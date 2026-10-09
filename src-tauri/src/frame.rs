//! Binary IPC framing shared with src/platform/tauri.ts:
//! u32 little-endian JSON length, the JSON header, then raw bytes.
//! File contents never go through JSON (a Uint8Array would become a number array).
use serde_json::Value;

pub fn join(header: &Value, bytes: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(header).expect("header serializes");
    let mut out = Vec::with_capacity(4 + json.len() + bytes.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(bytes);
    out
}

pub fn split(body: &[u8]) -> Option<(Value, &[u8])> {
    let length = u32::from_le_bytes(body.get(..4)?.try_into().ok()?) as usize;
    let json = body.get(4..4 + length)?;
    Some((serde_json::from_slice(json).ok()?, &body[4 + length..]))
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip() {
        let body = super::join(&serde_json::json!({"name":"曲.tg"}), b"PK\x03");
        let (header, bytes) = super::split(&body).unwrap();
        assert_eq!(header["name"], "曲.tg");
        assert_eq!(bytes, b"PK\x03");
        assert!(super::split(&body[..5]).is_none());
    }
}
