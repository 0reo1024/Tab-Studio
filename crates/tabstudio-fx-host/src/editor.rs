//! The plugin's own editor (IPlugView) in a captioned top-level window. As in the Electron
//! build (native/editor_window.py), closing the window only hides it: the plugin keeps
//! processing and the same editor comes back on the next open. Runs on the main thread,
//! which pumps window messages.
use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::ptr;

use vst3::Steinberg::Vst::IEditControllerTrait;
use vst3::Steinberg::*;
use vst3::{Class, ComPtr, ComWrapper};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const CLASS: &[u16] = &[b'T' as u16, b'S' as u16, b'F' as u16, b'x' as u16, b'E' as u16, b'd' as u16, 0];
const STYLE: WINDOW_STYLE = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN;

thread_local! {
    /// Set when the user closes (hides) the editor; the host answers waiting requests then.
    static HIDDEN: Cell<bool> = const { Cell::new(false) };
    static FRAME_VIEW: RefCell<Option<ComPtr<IPlugView>>> = const { RefCell::new(None) };
}

/// IPlugFrame: the editor asks the host to resize its window.
struct Frame {
    hwnd: Cell<HWND>,
}

impl Class for Frame {
    type Interfaces = (IPlugFrame,);
}

impl IPlugFrameTrait for Frame {
    unsafe fn resizeView(&self, view: *mut IPlugView, size: *mut ViewRect) -> tresult {
        if view.is_null() || size.is_null() || self.hwnd.get().is_null() {
            return kInvalidArgument;
        }
        let (w, h) = ((*size).right - (*size).left, (*size).bottom - (*size).top);
        let mut rect = RECT { left: 0, top: 0, right: w, bottom: h };
        AdjustWindowRectEx(&mut rect, STYLE, 0, 0);
        SetWindowPos(self.hwnd.get(), ptr::null_mut(), 0, 0, rect.right - rect.left, rect.bottom - rect.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        if let Some(v) = ComPtr::<IPlugView>::from_raw(view) {
            v.onSize(size);
            std::mem::forget(v);
        }
        kResultOk
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_CLOSE {
        ShowWindow(hwnd, SW_HIDE);
        HIDDEN.with(|h| h.set(true));
        return 0;
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

pub struct Editor {
    pub hwnd: HWND,
    view: ComPtr<IPlugView>,
    _frame: ComWrapper<Frame>,
}

impl Editor {
    /// Creates the editor window for `controller` (shown at once).
    pub fn open(controller: &ComPtr<vst3::Steinberg::Vst::IEditController>, title: &str) -> Result<Editor, String> {
        unsafe {
            let view = controller.createView(c"editor".as_ptr());
            let view = ComPtr::<IPlugView>::from_raw(view).ok_or("このプラグインには編集画面がありません。")?;
            if view.isPlatformTypeSupported(kPlatformTypeHWND) != kResultOk {
                return Err("このプラグインの編集画面は表示できません。".into());
            }
            let instance = GetModuleHandleW(ptr::null());
            let class = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: ptr::null_mut(),
                hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
                hbrBackground: ptr::null_mut(),
                lpszMenuName: ptr::null(),
                lpszClassName: CLASS.as_ptr(),
            };
            RegisterClassW(&class);
            let mut size: ViewRect = std::mem::zeroed();
            if view.getSize(&mut size) != kResultOk || size.right - size.left <= 0 {
                size = ViewRect { left: 0, top: 0, right: 800, bottom: 600 };
            }
            let mut rect = RECT { left: 0, top: 0, right: size.right - size.left, bottom: size.bottom - size.top };
            AdjustWindowRectEx(&mut rect, STYLE, 0, 0);
            let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
            let hwnd = CreateWindowExW(0, CLASS.as_ptr(), title.as_ptr(), STYLE, CW_USEDEFAULT, CW_USEDEFAULT, rect.right - rect.left, rect.bottom - rect.top, ptr::null_mut(), ptr::null_mut(), instance, ptr::null());
            if hwnd.is_null() {
                return Err("編集画面のウィンドウを作れません。".into());
            }
            let frame = ComWrapper::new(Frame { hwnd: Cell::new(hwnd) });
            if let Some(f) = frame.as_com_ref::<IPlugFrame>() {
                view.setFrame(f.as_ptr());
            }
            if view.attached(hwnd as *mut c_void, kPlatformTypeHWND) != kResultOk {
                view.setFrame(ptr::null_mut());
                DestroyWindow(hwnd);
                return Err("編集画面を開けません。".into());
            }
            FRAME_VIEW.with(|v| *v.borrow_mut() = Some(view.clone()));
            if std::env::var_os("TABSTUDIO_FX_DEBUG").is_some() {
                let mut r: RECT = std::mem::zeroed();
                GetWindowRect(hwnd, &mut r);
                eprintln!("editor window {hwnd:?} {}x{}", r.right - r.left, r.bottom - r.top);
            }
            let editor = Editor { hwnd, view, _frame: frame };
            editor.show();
            Ok(editor)
        }
    }

    pub fn show(&self) {
        unsafe {
            HIDDEN.with(|h| h.set(false));
            ShowWindow(self.hwnd, if IsIconic(self.hwnd) != 0 { SW_RESTORE } else { SW_SHOW });
            BringWindowToTop(self.hwnd);
            SetForegroundWindow(self.hwnd);
        }
    }

    pub fn hide(&self) {
        unsafe { ShowWindow(self.hwnd, SW_HIDE) };
        HIDDEN.with(|h| h.set(true));
    }

    /// Saves the window's current picture as a 32-bit BMP (automated checks).
    pub fn capture(&self, path: &std::path::Path) -> Result<(u32, u32), String> {
        use windows_sys::Win32::Graphics::Gdi::*;
        use windows_sys::Win32::Storage::Xps::PrintWindow;
        unsafe {
            let mut r: RECT = std::mem::zeroed();
            GetWindowRect(self.hwnd, &mut r);
            let (w, h) = (r.right - r.left, r.bottom - r.top);
            if w <= 0 || h <= 0 {
                return Err("window has no size".into());
            }
            let screen = GetDC(self.hwnd);
            let dc = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(dc, bitmap);
            // Only this window's own content (PW_RENDERFULLCONTENT: GPU-drawn editors too),
            // never the screen, so nothing else on the desktop is recorded.
            PrintWindow(self.hwnd, dc, 2);
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = w;
            info.bmiHeader.biHeight = h;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            GetDIBits(dc, bitmap, 0, h as u32, pixels.as_mut_ptr() as *mut c_void, &mut info, DIB_RGB_COLORS);
            SelectObject(dc, old);
            DeleteObject(bitmap);
            DeleteDC(dc);
            ReleaseDC(self.hwnd, screen);
            let mut file = Vec::with_capacity(54 + pixels.len());
            file.extend_from_slice(b"BM");
            file.extend_from_slice(&(54 + pixels.len() as u32).to_le_bytes());
            file.extend_from_slice(&[0, 0, 0, 0]);
            file.extend_from_slice(&54u32.to_le_bytes());
            file.extend_from_slice(&40u32.to_le_bytes());
            file.extend_from_slice(&w.to_le_bytes());
            file.extend_from_slice(&h.to_le_bytes());
            file.extend_from_slice(&1u16.to_le_bytes());
            file.extend_from_slice(&32u16.to_le_bytes());
            file.extend_from_slice(&[0u8; 24]);
            file.extend_from_slice(&pixels);
            std::fs::write(path, file).map_err(|e| e.to_string())?;
            Ok((w as u32, h as u32))
        }
    }

    pub fn visible(&self) -> bool {
        unsafe { IsWindowVisible(self.hwnd) != 0 }
    }

    /// True once after the user closed the window.
    pub fn take_hidden() -> bool {
        HIDDEN.with(|h| h.replace(false))
    }
}

impl Drop for Editor {
    fn drop(&mut self) {
        unsafe {
            self.view.removed();
            self.view.setFrame(ptr::null_mut());
            FRAME_VIEW.with(|v| v.borrow_mut().take());
            DestroyWindow(self.hwnd);
        }
    }
}
