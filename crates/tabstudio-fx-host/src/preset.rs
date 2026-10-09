//! The .vstpreset container (VST 3 SDK PresetFile), the format pedalboard's `preset_data`
//! (JUCE VST3Client::getPreset) produced for the Electron build, so saved FX states stay
//! interchangeable. Layout (little endian):
//!   "VST3" | version i32 (1) | class id, 32 ASCII hex chars | chunk-list offset i64
//!   chunk data ...
//!   "List" | count i32 | count x (id [4] | offset i64 | size i64)
//! Chunks used here: "Comp" (component state) and "Cont" (controller state).

pub struct Preset {
    /// The processor class id as the 32-character string the file stores.
    pub class_id: String,
    pub component: Option<Vec<u8>>,
    pub controller: Option<Vec<u8>>,
}

const HEADER: usize = 4 + 4 + 32 + 8;

pub fn write(class_id: &str, component: &[u8], controller: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + component.len() + controller.map_or(0, |c| c.len()) + 64);
    out.extend_from_slice(b"VST3");
    out.extend_from_slice(&1i32.to_le_bytes());
    let mut id = class_id.as_bytes().to_vec();
    id.resize(32, b'0');
    out.extend_from_slice(&id);
    out.extend_from_slice(&0i64.to_le_bytes());
    let mut entries: Vec<([u8; 4], usize, usize)> = Vec::new();
    entries.push((*b"Comp", out.len(), component.len()));
    out.extend_from_slice(component);
    if let Some(controller) = controller {
        entries.push((*b"Cont", out.len(), controller.len()));
        out.extend_from_slice(controller);
    }
    let list = out.len() as i64;
    out.extend_from_slice(b"List");
    out.extend_from_slice(&(entries.len() as i32).to_le_bytes());
    for (id, offset, size) in entries {
        out.extend_from_slice(&id);
        out.extend_from_slice(&(offset as i64).to_le_bytes());
        out.extend_from_slice(&(size as i64).to_le_bytes());
    }
    out[40..48].copy_from_slice(&list.to_le_bytes());
    out
}

pub fn read(data: &[u8]) -> Result<Preset, String> {
    let bad = || "プラグインの状態データが不正です。".to_string();
    if data.len() < HEADER || &data[..4] != b"VST3" {
        return Err(bad());
    }
    let class_id = String::from_utf8_lossy(&data[8..40]).into_owned();
    let list = i64::from_le_bytes(data[40..48].try_into().unwrap());
    let list = usize::try_from(list).map_err(|_| bad())?;
    let head = data.get(list..list + 8).ok_or_else(bad)?;
    if &head[..4] != b"List" {
        return Err(bad());
    }
    let count = i32::from_le_bytes(head[4..8].try_into().unwrap());
    let (mut component, mut controller) = (None, None);
    for i in 0..count.clamp(0, 64) as usize {
        let at = list + 8 + i * 20;
        let entry = data.get(at..at + 20).ok_or_else(bad)?;
        let offset = usize::try_from(i64::from_le_bytes(entry[4..12].try_into().unwrap())).map_err(|_| bad())?;
        let size = usize::try_from(i64::from_le_bytes(entry[12..20].try_into().unwrap())).map_err(|_| bad())?;
        let chunk = data.get(offset..offset.checked_add(size).ok_or_else(bad)?).ok_or_else(bad)?.to_vec();
        match &entry[..4] {
            b"Comp" => component = Some(chunk),
            b"Cont" => controller = Some(chunk),
            _ => {}
        }
    }
    Ok(Preset { class_id, component, controller })
}

/// The class id as .vstpreset files spell it (FUID::toString): uppercase hex of the GUID
/// fields. On Windows a TUID is laid out as a COM GUID, so the first three fields
/// (4, 2 and 2 bytes) are little endian and are printed byte-reversed.
pub fn class_id_string(cid: &[u8; 16]) -> String {
    let mut bytes = *cid;
    if cfg!(windows) {
        bytes[0..4].reverse();
        bytes[4..6].reverse();
        bytes[6..8].reverse();
    }
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_rejects_garbage() {
        let data = write("0123456789ABCDEF0123456789ABCDEF", b"component", Some(b"ctrl"));
        let p = read(&data).unwrap();
        assert_eq!(p.class_id, "0123456789ABCDEF0123456789ABCDEF");
        assert_eq!(p.component.as_deref(), Some(&b"component"[..]));
        assert_eq!(p.controller.as_deref(), Some(&b"ctrl"[..]));
        assert!(read(b"nope").is_err());
        let mut broken = data.clone();
        broken[40] = 0xff;
        assert!(read(&broken).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn class_ids_are_spelled_in_guid_field_order() {
        // bx_greenscreamer: its TUID bytes begin "bTSVgxbs"; pedalboard's file says "VSTbxgsb".
        let cid: [u8; 16] = *b"bTSVgxbsx_greens";
        assert_eq!(class_id_string(&cid), "5653546278677362785F677265656E73");
    }
}
