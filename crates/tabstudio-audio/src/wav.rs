//! Minimal 16-bit stereo WAV writer for offline renders and listening comparisons.
pub fn stereo_16(left: &[f32], right: &[f32], rate: u32) -> Vec<u8> {
    let frames = left.len().min(right.len());
    let data_len = (frames * 4) as u32;
    let mut out = Vec::with_capacity(44 + frames * 4);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for i in 0..frames {
        for value in [left[i], right[i]] {
            out.extend_from_slice(&((value.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
    }
    out
}
