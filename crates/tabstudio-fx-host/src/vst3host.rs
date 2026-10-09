//! A minimal VST3 effect host: loads the module, creates the processor and its controller,
//! connects them, processes stereo 32-bit audio and saves/restores .vstpreset states.
//! Host-side COM objects (host context, messages, attribute lists, parameter changes,
//! streams) follow the SDK's reference host behaviour, which JUCE (and so pedalboard,
//! the Electron build's host) also follows.
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{CStr, c_void};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{Arc, Mutex};

use vst3::Steinberg::Vst::*;
use vst3::Steinberg::*;
use vst3::{Class, ComPtr, ComWrapper, Interface};

use crate::preset;

fn ok(result: tresult, what: &str) -> Result<(), String> {
    if result == kResultOk { Ok(()) } else { Err(format!("{what} に失敗しました（{result}）")) }
}

fn guid_eq(a: *const TUID, b: &[u8; 16]) -> bool {
    !a.is_null() && unsafe { std::slice::from_raw_parts(a as *const u8, 16) } == b
}

fn c_string(chars: &[std::ffi::c_char]) -> String {
    let bytes: Vec<u8> = chars.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

// ---------------------------------------------------------------------------------------
// Host-side COM objects

/// IBStream over a byte vector.
pub struct MemoryStream {
    data: RefCell<Vec<u8>>,
    position: Cell<usize>,
}

impl MemoryStream {
    pub fn new(data: Vec<u8>) -> ComWrapper<MemoryStream> {
        ComWrapper::new(MemoryStream { data: RefCell::new(data), position: Cell::new(0) })
    }
    pub fn take(&self) -> Vec<u8> {
        std::mem::take(&mut *self.data.borrow_mut())
    }
}

impl Class for MemoryStream {
    type Interfaces = (IBStream,);
}

impl IBStreamTrait for MemoryStream {
    unsafe fn read(&self, buffer: *mut c_void, bytes: int32, read: *mut int32) -> tresult {
        let data = self.data.borrow();
        let at = self.position.get().min(data.len());
        let count = (bytes.max(0) as usize).min(data.len() - at);
        if count > 0 {
            ptr::copy_nonoverlapping(data.as_ptr().add(at), buffer as *mut u8, count);
        }
        self.position.set(at + count);
        if !read.is_null() {
            *read = count as int32;
        }
        kResultOk
    }
    unsafe fn write(&self, buffer: *mut c_void, bytes: int32, written: *mut int32) -> tresult {
        let count = bytes.max(0) as usize;
        let mut data = self.data.borrow_mut();
        let at = self.position.get();
        if data.len() < at + count {
            data.resize(at + count, 0);
        }
        if count > 0 {
            ptr::copy_nonoverlapping(buffer as *const u8, data.as_mut_ptr().add(at), count);
        }
        self.position.set(at + count);
        if !written.is_null() {
            *written = count as int32;
        }
        kResultOk
    }
    unsafe fn seek(&self, pos: int64, mode: int32, result: *mut int64) -> tresult {
        let len = self.data.borrow().len() as i64;
        let base = match mode {
            IBStream_::IStreamSeekMode_::kIBSeekSet => 0,
            IBStream_::IStreamSeekMode_::kIBSeekCur => self.position.get() as i64,
            IBStream_::IStreamSeekMode_::kIBSeekEnd => len,
            _ => return kInvalidArgument,
        };
        let next = (base + pos).max(0);
        self.position.set(next as usize);
        if !result.is_null() {
            *result = next;
        }
        kResultOk
    }
    unsafe fn tell(&self, pos: *mut int64) -> tresult {
        if !pos.is_null() {
            *pos = self.position.get() as i64;
        }
        kResultOk
    }
}

enum Attribute {
    Int(i64),
    Float(f64),
    Text(Vec<u16>),
    Binary(Vec<u8>),
}

pub struct AttributeList {
    values: RefCell<HashMap<Vec<u8>, Attribute>>,
}

impl Class for AttributeList {
    type Interfaces = (IAttributeList,);
}

unsafe fn key(id: IAttributeList_::AttrID) -> Option<Vec<u8>> {
    (!id.is_null()).then(|| CStr::from_ptr(id).to_bytes().to_vec())
}

impl IAttributeListTrait for AttributeList {
    unsafe fn setInt(&self, id: IAttributeList_::AttrID, value: int64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        self.values.borrow_mut().insert(k, Attribute::Int(value));
        kResultOk
    }
    unsafe fn getInt(&self, id: IAttributeList_::AttrID, value: *mut int64) -> tresult {
        match key(id).and_then(|k| match self.values.borrow().get(&k) { Some(Attribute::Int(v)) => Some(*v), _ => None }) {
            Some(v) if !value.is_null() => { *value = v; kResultOk }
            _ => kResultFalse,
        }
    }
    unsafe fn setFloat(&self, id: IAttributeList_::AttrID, value: f64) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        self.values.borrow_mut().insert(k, Attribute::Float(value));
        kResultOk
    }
    unsafe fn getFloat(&self, id: IAttributeList_::AttrID, value: *mut f64) -> tresult {
        match key(id).and_then(|k| match self.values.borrow().get(&k) { Some(Attribute::Float(v)) => Some(*v), _ => None }) {
            Some(v) if !value.is_null() => { *value = v; kResultOk }
            _ => kResultFalse,
        }
    }
    unsafe fn setString(&self, id: IAttributeList_::AttrID, string: *const TChar) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        if string.is_null() {
            return kInvalidArgument;
        }
        let mut text = Vec::new();
        let mut at = string;
        while *at != 0 {
            text.push(*at as u16);
            at = at.add(1);
        }
        self.values.borrow_mut().insert(k, Attribute::Text(text));
        kResultOk
    }
    unsafe fn getString(&self, id: IAttributeList_::AttrID, string: *mut TChar, size: uint32) -> tresult {
        let values = self.values.borrow();
        let Some(Attribute::Text(text)) = key(id).and_then(|k| values.get(&k)) else { return kResultFalse };
        let room = size as usize / 2;
        if string.is_null() || room == 0 {
            return kResultFalse;
        }
        let n = text.len().min(room - 1);
        for (i, c) in text[..n].iter().enumerate() {
            *string.add(i) = *c as TChar;
        }
        *string.add(n) = 0;
        kResultOk
    }
    unsafe fn setBinary(&self, id: IAttributeList_::AttrID, data: *const c_void, size: uint32) -> tresult {
        let Some(k) = key(id) else { return kInvalidArgument };
        let bytes = if data.is_null() { Vec::new() } else { std::slice::from_raw_parts(data as *const u8, size as usize).to_vec() };
        self.values.borrow_mut().insert(k, Attribute::Binary(bytes));
        kResultOk
    }
    unsafe fn getBinary(&self, id: IAttributeList_::AttrID, data: *mut *const c_void, size: *mut uint32) -> tresult {
        let values = self.values.borrow();
        let Some(Attribute::Binary(bytes)) = key(id).and_then(|k| values.get(&k)) else { return kResultFalse };
        if data.is_null() || size.is_null() {
            return kInvalidArgument;
        }
        // The bytes stay owned by the list (the message) as the SDK requires.
        *data = bytes.as_ptr() as *const c_void;
        *size = bytes.len() as uint32;
        kResultOk
    }
}

pub struct Message {
    id: RefCell<Vec<u8>>,
    attributes: ComWrapper<AttributeList>,
}

impl Class for Message {
    type Interfaces = (IMessage,);
}

impl IMessageTrait for Message {
    unsafe fn getMessageID(&self) -> FIDString {
        self.id.borrow().as_ptr() as FIDString
    }
    unsafe fn setMessageID(&self, id: FIDString) {
        let mut bytes = if id.is_null() { Vec::new() } else { CStr::from_ptr(id).to_bytes().to_vec() };
        bytes.push(0);
        *self.id.borrow_mut() = bytes;
    }
    unsafe fn getAttributes(&self) -> *mut IAttributeList {
        self.attributes.as_com_ref::<IAttributeList>().map_or(ptr::null_mut(), |r| r.as_ptr())
    }
}

fn new_attributes() -> ComWrapper<AttributeList> {
    ComWrapper::new(AttributeList { values: RefCell::new(HashMap::new()) })
}

pub struct HostApplication;

impl Class for HostApplication {
    type Interfaces = (IHostApplication,);
}

impl IHostApplicationTrait for HostApplication {
    unsafe fn getName(&self, name: *mut String128) -> tresult {
        if name.is_null() {
            return kInvalidArgument;
        }
        let text: Vec<u16> = "Tab Studio".encode_utf16().collect();
        for (i, c) in text.iter().enumerate() {
            (*name)[i] = *c as TChar;
        }
        (*name)[text.len()] = 0;
        kResultOk
    }
    unsafe fn createInstance(&self, cid: *mut TUID, iid: *mut TUID, obj: *mut *mut c_void) -> tresult {
        if obj.is_null() {
            return kInvalidArgument;
        }
        *obj = ptr::null_mut();
        if guid_eq(cid, &IMessage::IID) && guid_eq(iid, &IMessage::IID) {
            let message = ComWrapper::new(Message { id: RefCell::new(vec![0]), attributes: new_attributes() });
            if let Some(p) = message.to_com_ptr::<IMessage>() {
                *obj = p.into_raw() as *mut c_void;
                return kResultOk;
            }
        }
        if guid_eq(cid, &IAttributeList::IID) && guid_eq(iid, &IAttributeList::IID) {
            if let Some(p) = new_attributes().to_com_ptr::<IAttributeList>() {
                *obj = p.into_raw() as *mut c_void;
                return kResultOk;
            }
        }
        kResultFalse
    }
}

/// Edits the user makes in the plugin's editor; forwarded to the processor on the next block.
#[derive(Default)]
pub struct Edits {
    pub pending: Mutex<Vec<(ParamID, ParamValue)>>,
    pub restart: Mutex<i32>,
}

pub struct ComponentHandler {
    edits: Arc<Edits>,
}

impl Class for ComponentHandler {
    type Interfaces = (IComponentHandler,);
}

impl IComponentHandlerTrait for ComponentHandler {
    unsafe fn beginEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }
    unsafe fn performEdit(&self, id: ParamID, value: ParamValue) -> tresult {
        let mut pending = self.edits.pending.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = pending.iter_mut().find(|(p, _)| *p == id) {
            slot.1 = value;
        } else if pending.len() < 1024 {
            pending.push((id, value));
        }
        kResultOk
    }
    unsafe fn endEdit(&self, _id: ParamID) -> tresult {
        kResultOk
    }
    unsafe fn restartComponent(&self, flags: int32) -> tresult {
        *self.edits.restart.lock().unwrap_or_else(|e| e.into_inner()) |= flags;
        kResultOk
    }
}

pub struct ValueQueue {
    id: ParamID,
    points: RefCell<Vec<(int32, ParamValue)>>,
}

impl Class for ValueQueue {
    type Interfaces = (IParamValueQueue,);
}

impl IParamValueQueueTrait for ValueQueue {
    unsafe fn getParameterId(&self) -> ParamID {
        self.id
    }
    unsafe fn getPointCount(&self) -> int32 {
        self.points.borrow().len() as int32
    }
    unsafe fn getPoint(&self, index: int32, offset: *mut int32, value: *mut ParamValue) -> tresult {
        match self.points.borrow().get(index.max(0) as usize) {
            Some(&(o, v)) if !offset.is_null() && !value.is_null() => { *offset = o; *value = v; kResultOk }
            _ => kResultFalse,
        }
    }
    unsafe fn addPoint(&self, offset: int32, value: ParamValue, index: *mut int32) -> tresult {
        let mut points = self.points.borrow_mut();
        points.push((offset, value));
        if !index.is_null() {
            *index = points.len() as int32 - 1;
        }
        kResultOk
    }
}

/// Parameter changes for one process call (input) or from it (output).
pub struct ParameterChanges {
    queues: RefCell<Vec<ComWrapper<ValueQueue>>>,
}

impl ParameterChanges {
    fn new() -> ComWrapper<ParameterChanges> {
        ComWrapper::new(ParameterChanges { queues: RefCell::new(Vec::with_capacity(64)) })
    }
    fn clear(&self) {
        self.queues.borrow_mut().clear();
    }
    fn set(&self, id: ParamID, value: ParamValue) {
        self.queues.borrow_mut().push(ComWrapper::new(ValueQueue { id, points: RefCell::new(vec![(0, value)]) }));
    }
}

impl Class for ParameterChanges {
    type Interfaces = (IParameterChanges,);
}

impl IParameterChangesTrait for ParameterChanges {
    unsafe fn getParameterCount(&self) -> int32 {
        self.queues.borrow().len() as int32
    }
    unsafe fn getParameterData(&self, index: int32) -> *mut IParamValueQueue {
        self.queues.borrow().get(index.max(0) as usize).and_then(|q| q.as_com_ref::<IParamValueQueue>()).map_or(ptr::null_mut(), |r| r.as_ptr())
    }
    unsafe fn addParameterData(&self, id: *const ParamID, index: *mut int32) -> *mut IParamValueQueue {
        if id.is_null() {
            return ptr::null_mut();
        }
        let mut queues = self.queues.borrow_mut();
        let at = match queues.iter().position(|q| q.id == *id) {
            Some(at) => at,
            None => {
                queues.push(ComWrapper::new(ValueQueue { id: *id, points: RefCell::new(Vec::new()) }));
                queues.len() - 1
            }
        };
        if !index.is_null() {
            *index = at as int32;
        }
        queues[at].as_com_ref::<IParamValueQueue>().map_or(ptr::null_mut(), |r| r.as_ptr())
    }
}

// ---------------------------------------------------------------------------------------
// The plugin

type GetFactory = unsafe extern "system" fn() -> *mut IPluginFactory;
type ModuleEntry = unsafe extern "system" fn() -> bool;

pub struct Plugin {
    pub name: String,
    pub class_id: [u8; 16],
    pub latency: u32,
    pub sample_rate: f64,
    pub max_block: usize,
    component: ComPtr<IComponent>,
    processor: ComPtr<IAudioProcessor>,
    controller: Option<ComPtr<IEditController>>,
    separate_controller: bool,
    connections: Option<(ComPtr<IConnectionPoint>, ComPtr<IConnectionPoint>)>,
    _host: ComWrapper<HostApplication>,
    _handler: ComWrapper<ComponentHandler>,
    pub edits: Arc<Edits>,
    input_changes: ComWrapper<ParameterChanges>,
    output_changes: ComWrapper<ParameterChanges>,
    inputs: Vec<(i32, Vec<Vec<f32>>)>,
    outputs: Vec<(i32, Vec<Vec<f32>>)>,
    context: ProcessContext,
    active: bool,
    library: Option<libloading::Library>,
}

/// The binary inside a VST3 bundle folder, or the file itself (older single-file plugins).
pub fn module_path(path: &Path) -> PathBuf {
    if path.is_dir() {
        let arch = if cfg!(target_arch = "aarch64") { "arm64-win" } else { "x86_64-win" };
        let name = path.file_name().map(PathBuf::from).unwrap_or_default();
        return path.join("Contents").join(arch).join(name);
    }
    path.to_path_buf()
}

impl Plugin {
    /// Loads the first audio effect class of the module and prepares it for stereo processing.
    pub fn load(path: &Path, sample_rate: f64, max_block: usize) -> Result<Plugin, String> {
        unsafe {
            let library = libloading::Library::new(module_path(path)).map_err(|e| format!("プラグインを読み込めません：{e}"))?;
            if let Ok(init) = library.get::<ModuleEntry>(b"InitDll") {
                init();
            }
            let get_factory = library.get::<GetFactory>(b"GetPluginFactory").map_err(|_| "VST3 プラグインではありません。".to_string())?;
            let factory = ComPtr::<IPluginFactory>::from_raw(get_factory()).ok_or("プラグインの初期化に失敗しました。")?;
            let mut found = None;
            for i in 0..factory.countClasses() {
                let mut info: PClassInfo = std::mem::zeroed();
                if factory.getClassInfo(i, &mut info) == kResultOk && c_string(&info.category) == "Audio Module Class" {
                    found = Some(info);
                    break;
                }
            }
            let info = found.ok_or("オーディオエフェクトが見つかりません。")?;
            let class_id: [u8; 16] = std::mem::transmute(info.cid);
            let host = ComWrapper::new(HostApplication);
            let host_unknown = host.as_com_ref::<FUnknown>().map_or(ptr::null_mut(), |r| r.as_ptr());
            let mut object: *mut c_void = ptr::null_mut();
            ok(factory.createInstance(info.cid.as_ptr(), IComponent::IID.as_ptr() as FIDString, &mut object), "プラグインの作成")?;
            let component = ComPtr::<IComponent>::from_raw(object as *mut IComponent).ok_or("プラグインの作成に失敗しました。")?;
            ok(component.initialize(host_unknown), "プラグインの初期化")?;
            let processor = component.cast::<IAudioProcessor>().ok_or("音声処理に対応していないプラグインです。")?;
            // The controller is either the component itself or a separate class.
            let (controller, separate_controller) = match component.cast::<IEditController>() {
                Some(c) => (Some(c), false),
                None => {
                    let mut cid: TUID = [0; 16];
                    let mut made = None;
                    if component.getControllerClassId(&mut cid) == kResultOk {
                        let mut object: *mut c_void = ptr::null_mut();
                        if factory.createInstance(cid.as_ptr(), IEditController::IID.as_ptr() as FIDString, &mut object) == kResultOk {
                            if let Some(c) = ComPtr::<IEditController>::from_raw(object as *mut IEditController) {
                                if c.initialize(host_unknown) == kResultOk {
                                    made = Some(c);
                                }
                            }
                        }
                    }
                    (made, true)
                }
            };
            let edits = Arc::new(Edits::default());
            let handler = ComWrapper::new(ComponentHandler { edits: edits.clone() });
            let mut connections = None;
            if let Some(controller) = &controller {
                if let Some(h) = handler.as_com_ref::<IComponentHandler>() {
                    controller.setComponentHandler(h.as_ptr());
                }
                if separate_controller {
                    if let (Some(a), Some(b)) = (component.cast::<IConnectionPoint>(), controller.cast::<IConnectionPoint>()) {
                        a.connect(b.as_ptr());
                        b.connect(a.as_ptr());
                        connections = Some((a, b));
                    }
                    // The controller starts from the processor's state.
                    let stream = MemoryStream::new(Vec::new());
                    if let Some(s) = stream.as_com_ref::<IBStream>() {
                        if component.getState(s.as_ptr()) == kResultOk {
                            let data = stream.take();
                            let back = MemoryStream::new(data);
                            if let Some(s) = back.as_com_ref::<IBStream>() {
                                controller.setComponentState(s.as_ptr());
                            }
                        }
                    }
                }
            }
            let mut plugin = Plugin {
                name: c_string(&info.name),
                class_id,
                latency: 0,
                sample_rate,
                max_block,
                component,
                processor,
                controller,
                separate_controller,
                connections,
                _host: host,
                _handler: handler,
                edits,
                input_changes: ParameterChanges::new(),
                output_changes: ParameterChanges::new(),
                inputs: Vec::new(),
                outputs: Vec::new(),
                context: std::mem::zeroed(),
                active: false,
                library: Some(library),
            };
            plugin.setup()?;
            Ok(plugin)
        }
    }

    /// Stereo main buses, other buses at their own layouts (inactive), then activate.
    unsafe fn setup(&mut self) -> Result<(), String> {
        let buses = |dir| {
            let count = self.component.getBusCount(MediaTypes_::kAudio as i32, dir);
            (0..count).map(|i| {
                let mut arrangement: SpeakerArrangement = 0;
                self.processor.getBusArrangement(dir, i, &mut arrangement);
                if i == 0 { SpeakerArr::kStereo } else { arrangement }
            }).collect::<Vec<_>>()
        };
        let mut ins = buses(BusDirections_::kInput as i32);
        let mut outs = buses(BusDirections_::kOutput as i32);
        if outs.is_empty() {
            return Err("音声を出力しないプラグインです。".into());
        }
        self.processor.setBusArrangements(ins.as_mut_ptr(), ins.len() as i32, outs.as_mut_ptr(), outs.len() as i32);
        // Read back what the plugin accepted (a mono-only effect keeps one channel).
        let channels = |dir, count: usize| (0..count as i32).map(|i| {
            let mut info: BusInfo = std::mem::zeroed();
            self.component.getBusInfo(MediaTypes_::kAudio as i32, dir, i, &mut info);
            info.channelCount.max(0)
        }).collect::<Vec<_>>();
        let in_channels = channels(BusDirections_::kInput as i32, ins.len());
        let out_channels = channels(BusDirections_::kOutput as i32, outs.len());
        for (dir, count) in [(BusDirections_::kInput as i32, ins.len()), (BusDirections_::kOutput as i32, outs.len())] {
            for i in 0..count as i32 {
                self.component.activateBus(MediaTypes_::kAudio as i32, dir, i, (i == 0) as u8);
            }
        }
        let block = self.max_block;
        self.inputs = in_channels.iter().map(|&n| (n, (0..n).map(|_| vec![0f32; block]).collect())).collect();
        self.outputs = out_channels.iter().map(|&n| (n, (0..n).map(|_| vec![0f32; block]).collect())).collect();
        let mut setup = ProcessSetup {
            processMode: ProcessModes_::kRealtime as i32,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            maxSamplesPerBlock: block as i32,
            sampleRate: self.sample_rate,
        };
        ok(self.processor.setupProcessing(&mut setup), "音声処理の準備")?;
        ok(self.component.setActive(1), "プラグインの有効化")?;
        self.processor.setProcessing(1);
        self.active = true;
        self.latency = self.processor.getLatencySamples();
        self.context.sampleRate = self.sample_rate;
        self.context.tempo = 120.0;
        self.context.timeSigNumerator = 4;
        self.context.timeSigDenominator = 4;
        self.context.state = ProcessContext_::StatesAndFlags_::kTempoValid as u32 | ProcessContext_::StatesAndFlags_::kTimeSigValid as u32;
        Ok(())
    }

    /// Processes stereo audio in place, in blocks of at most `max_block` frames.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let total = left.len().min(right.len());
        let mut done = 0;
        while done < total {
            let n = (total - done).min(self.max_block);
            unsafe { self.process_block(&mut left[done..done + n], &mut right[done..done + n]) };
            done += n;
        }
    }

    unsafe fn process_block(&mut self, left: &mut [f32], right: &mut [f32]) {
        let n = left.len();
        for (bus, (count, channels)) in self.inputs.iter_mut().enumerate() {
            for (c, channel) in channels.iter_mut().enumerate() {
                let source: &[f32] = if bus == 0 { if c == 0 || *count == 1 { left } else { right } } else { &[] };
                if source.is_empty() { channel[..n].fill(0.0) } else { channel[..n].copy_from_slice(source) }
            }
            // A mono main input gets the stereo signal down-mixed.
            if bus == 0 && *count == 1 {
                for i in 0..n {
                    channels[0][i] = 0.5 * (left[i] + right[i]);
                }
            }
        }
        let mut in_pointers: Vec<Vec<*mut f32>> = self.inputs.iter_mut().map(|(_, ch)| ch.iter_mut().map(|c| c.as_mut_ptr()).collect()).collect();
        let mut out_pointers: Vec<Vec<*mut f32>> = self.outputs.iter_mut().map(|(_, ch)| ch.iter_mut().map(|c| c.as_mut_ptr()).collect()).collect();
        let mut in_buses: Vec<AudioBusBuffers> = in_pointers.iter_mut().map(|p| { let mut b: AudioBusBuffers = std::mem::zeroed(); b.numChannels = p.len() as i32; b.__field0.channelBuffers32 = p.as_mut_ptr(); b }).collect();
        let mut out_buses: Vec<AudioBusBuffers> = out_pointers.iter_mut().map(|p| { let mut b: AudioBusBuffers = std::mem::zeroed(); b.numChannels = p.len() as i32; b.__field0.channelBuffers32 = p.as_mut_ptr(); b }).collect();
        self.input_changes.clear();
        self.output_changes.clear();
        for (id, value) in std::mem::take(&mut *self.edits.pending.lock().unwrap_or_else(|e| e.into_inner())) {
            self.input_changes.set(id, value);
        }
        let mut data = ProcessData {
            processMode: ProcessModes_::kRealtime as i32,
            symbolicSampleSize: SymbolicSampleSizes_::kSample32 as i32,
            numSamples: n as i32,
            numInputs: in_buses.len() as i32,
            numOutputs: out_buses.len() as i32,
            inputs: if in_buses.is_empty() { ptr::null_mut() } else { in_buses.as_mut_ptr() },
            outputs: out_buses.as_mut_ptr(),
            inputParameterChanges: self.input_changes.as_com_ref::<IParameterChanges>().map_or(ptr::null_mut(), |r| r.as_ptr()),
            outputParameterChanges: self.output_changes.as_com_ref::<IParameterChanges>().map_or(ptr::null_mut(), |r| r.as_ptr()),
            inputEvents: ptr::null_mut(),
            outputEvents: ptr::null_mut(),
            processContext: &mut self.context,
        };
        if self.processor.process(&mut data) != kResultOk {
            left.fill(0.0);
            right.fill(0.0);
            return;
        }
        self.context.projectTimeSamples += n as i64;
        self.context.continousTimeSamples += n as i64;
        let (count, channels) = &self.outputs[0];
        match *count {
            0 => { left.fill(0.0); right.fill(0.0); }
            1 => { left.copy_from_slice(&channels[0][..n]); right.copy_from_slice(&channels[0][..n]); }
            _ => { left.copy_from_slice(&channels[0][..n]); right.copy_from_slice(&channels[1][..n]); }
        }
    }

    /// The state as .vstpreset bytes (component + controller chunks).
    pub fn preset(&self) -> Result<Vec<u8>, String> {
        unsafe {
            let component = MemoryStream::new(Vec::new());
            ok(self.component.getState(component.as_com_ref::<IBStream>().unwrap().as_ptr()), "状態の取得")?;
            let component = component.take();
            // As the SDK's PresetFile::savePreset (JUCE, pedalboard): the controller chunk is
            // written whenever there is an edit controller, even the component itself.
            let controller = self.controller.as_ref().and_then(|c| {
                let stream = MemoryStream::new(Vec::new());
                (c.getState(stream.as_com_ref::<IBStream>().unwrap().as_ptr()) == kResultOk).then(|| stream.take())
            });
            Ok(preset::write(&preset::class_id_string(&self.class_id), &component, controller.as_deref()))
        }
    }

    /// Restores a .vstpreset state (as pedalboard/JUCE do: component, then controller).
    pub fn set_preset(&mut self, data: &[u8]) -> Result<(), String> {
        let p = preset::read(data)?;
        unsafe {
            if let Some(component) = &p.component {
                let stream = MemoryStream::new(component.clone());
                ok(self.component.setState(stream.as_com_ref::<IBStream>().unwrap().as_ptr()), "状態の復元")?;
                // PresetFile::loadPreset also hands the component state to the controller.
                if let Some(controller) = self.controller.as_ref() {
                    let stream = MemoryStream::new(component.clone());
                    controller.setComponentState(stream.as_com_ref::<IBStream>().unwrap().as_ptr());
                }
            }
            if let (Some(state), Some(controller)) = (&p.controller, &self.controller) {
                let stream = MemoryStream::new(state.clone());
                controller.setState(stream.as_com_ref::<IBStream>().unwrap().as_ptr());
            }
            self.latency = self.processor.getLatencySamples();
        }
        Ok(())
    }

    /// Prepares for another sample rate (stops, sets up, restarts processing).
    pub fn set_sample_rate(&mut self, rate: f64) -> Result<(), String> {
        unsafe {
            self.processor.setProcessing(0);
            self.component.setActive(0);
            self.active = false;
            self.sample_rate = rate;
            self.setup()
        }
    }

    /// Clears tails and internal state (as JUCE's reset of a VST3: deactivate, reactivate).
    pub fn reset(&mut self) {
        unsafe {
            self.processor.setProcessing(0);
            self.component.setActive(0);
            self.component.setActive(1);
            self.processor.setProcessing(1);
        }
    }

    pub fn controller(&self) -> Option<&ComPtr<IEditController>> {
        self.controller.as_ref()
    }
}

impl Drop for Plugin {
    fn drop(&mut self) {
        unsafe {
            if self.active {
                self.processor.setProcessing(0);
                self.component.setActive(0);
            }
            if let Some((a, b)) = self.connections.take() {
                a.disconnect(b.as_ptr());
                b.disconnect(a.as_ptr());
            }
            if let Some(c) = self.controller.take() {
                c.setComponentHandler(ptr::null_mut());
                if self.separate_controller {
                    c.terminate();
                }
            }
            self.component.terminate();
        }
        // The COM objects above must be released before the module unloads; the remaining
        // fields drop after this body, so keep the library loaded for the process lifetime.
        if let Some(library) = self.library.take() {
            std::mem::forget(library);
        }
    }
}
