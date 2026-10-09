//! SF3 -> SF2: decodes Ogg Vorbis compressed samples into 16-bit PCM so a plain SF2
//! synthesizer (rustysynth) can use the bundled GeneralUser-Classical.sf3.
//!
//! SF3 (MuseScore) rules, matching alphaTab's reader: a sample with sampleType bit 0x10
//! stores an Ogg stream at byte offsets start..end of `smpl`, and its loop points are
//! relative to the decoded sample. Uncompressed samples keep SF2 rules (positions in
//! 16-bit samples). The output follows SF2: absolute positions, 46 zero samples after
//! each sample.
use std::io::Cursor;

const SHDR_SIZE: usize = 46;
const COMPRESSED: u16 = 0x10;
const PADDING: usize = 46;

#[derive(Debug)]
pub struct Error(pub String);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
fn err<T>(message: impl Into<String>) -> Result<T, Error> {
    Err(Error(message.into()))
}

struct Chunk<'a> {
    id: [u8; 4],
    data: &'a [u8],
}

/// Chunks inside a RIFF/LIST body. Tolerates a missing pad byte after odd-sized chunks
/// (the bundled SF3 omits it, see scripts/replace-nylon-soundfont.py).
fn chunks(mut data: &[u8]) -> Result<Vec<Chunk<'_>>, Error> {
    let mut out = Vec::new();
    while data.len() >= 8 {
        let id: [u8; 4] = data[..4].try_into().unwrap();
        let length = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
        let Some(body) = data.get(8..8 + length) else { return err(format!("chunk {} is truncated", String::from_utf8_lossy(&id))) };
        out.push(Chunk { id, data: body });
        data = &data[8 + length..];
        if length % 2 == 1 && data.first() == Some(&0) && data.len() % 2 == 1 {
            data = &data[1..];
        }
    }
    Ok(out)
}

fn list<'a>(top: &'a [Chunk<'a>], kind: &[u8; 4]) -> Result<Vec<Chunk<'a>>, Error> {
    let chunk = top.iter().find(|c| &c.id == b"LIST" && c.data.get(..4) == Some(kind)).ok_or_else(|| Error(format!("LIST {} missing", String::from_utf8_lossy(kind))))?;
    chunks(&chunk.data[4..])
}

fn write_chunk(out: &mut Vec<u8>, id: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    if data.len() % 2 == 1 {
        out.push(0);
    }
}

fn decode_vorbis(bytes: &[u8]) -> Result<Vec<i16>, Error> {
    let mut reader = lewton::inside_ogg::OggStreamReader::new(Cursor::new(bytes)).map_err(|e| Error(format!("vorbis: {e}")))?;
    let channels = reader.ident_hdr.audio_channels.max(1) as usize;
    let mut pcm = Vec::new();
    while let Some(packet) = reader.read_dec_packet_itl().map_err(|e| Error(format!("vorbis: {e}")))? {
        // SoundFont samples are mono; keep the first channel if a stream is not.
        pcm.extend(packet.iter().step_by(channels));
    }
    // The last page's granule position is the exact sample count; the final packet
    // decodes padding past it.
    if let Some(total) = reader.get_last_absgp() {
        pcm.truncate(total as usize);
    }
    Ok(pcm)
}

/// True when any sample is Ogg Vorbis compressed (SF3).
pub fn is_sf3(data: &[u8]) -> bool {
    let check = || -> Result<bool, Error> {
        if data.len() < 12 || &data[..4] != b"RIFF" || &data[8..12] != b"sfbk" {
            return Ok(false);
        }
        let top = chunks(&data[12..])?;
        let pdta = list(&top, b"pdta")?;
        let shdr = pdta.iter().find(|c| &c.id == b"shdr").ok_or(Error("shdr missing".into()))?;
        Ok(shdr.data.chunks_exact(SHDR_SIZE).any(|h| u16::from_le_bytes([h[44], h[45]]) & COMPRESSED != 0))
    };
    check().unwrap_or(false)
}

/// Converts an SF3 (or SF2 with some compressed samples) into a plain SF2.
pub fn to_sf2(data: &[u8]) -> Result<Vec<u8>, Error> {
    if data.len() < 12 || &data[..4] != b"RIFF" || &data[8..12] != b"sfbk" {
        return err("not a SoundFont file");
    }
    let top = chunks(&data[12..])?;
    let info = top.iter().find(|c| &c.id == b"LIST" && c.data.get(..4) == Some(b"INFO"));
    let sdta = list(&top, b"sdta")?;
    let pdta = list(&top, b"pdta")?;
    let smpl = sdta.iter().find(|c| &c.id == b"smpl").map(|c| c.data).unwrap_or(&[]);
    let shdr = pdta.iter().find(|c| &c.id == b"shdr").ok_or(Error("shdr missing".into()))?;
    if shdr.data.len() % SHDR_SIZE != 0 {
        return err("shdr has a bad size");
    }
    let mut pcm: Vec<i16> = Vec::with_capacity(smpl.len() / 2);
    let mut headers = shdr.data.to_vec();
    let count = headers.len() / SHDR_SIZE;
    for index in 0..count {
        let h = &mut headers[index * SHDR_SIZE..(index + 1) * SHDR_SIZE];
        let field = |h: &[u8], at: usize| u32::from_le_bytes(h[at..at + 4].try_into().unwrap()) as usize;
        let (start, end, loop_start, loop_end) = (field(h, 20), field(h, 24), field(h, 28), field(h, 32));
        let sample_type = u16::from_le_bytes([h[44], h[45]]);
        // The terminal "EOS" record has no data.
        if index == count - 1 {
            for at in [20, 24, 28, 32] {
                h[at..at + 4].copy_from_slice(&0u32.to_le_bytes());
            }
            continue;
        }
        let new_start = pcm.len();
        let (new_loop_start, new_loop_end);
        if sample_type & COMPRESSED != 0 {
            let Some(bytes) = smpl.get(start..end) else { return err(format!("compressed sample {index} is out of range")) };
            pcm.extend(decode_vorbis(bytes)?);
            new_loop_start = new_start + loop_start;
            new_loop_end = new_start + loop_end;
            h[44..46].copy_from_slice(&(sample_type & !COMPRESSED).to_le_bytes());
        } else {
            let Some(bytes) = smpl.get(start * 2..end * 2) else { return err(format!("sample {index} is out of range")) };
            pcm.extend(bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])));
            new_loop_start = (new_start + loop_start).saturating_sub(start);
            new_loop_end = (new_start + loop_end).saturating_sub(start);
        }
        let new_end = pcm.len();
        pcm.extend(std::iter::repeat_n(0, PADDING));
        for (at, value) in [(20, new_start), (24, new_end), (28, new_loop_start), (32, new_loop_end)] {
            h[at..at + 4].copy_from_slice(&(value as u32).to_le_bytes());
        }
    }
    let mut samples = Vec::with_capacity(pcm.len() * 2);
    for value in &pcm {
        samples.extend_from_slice(&value.to_le_bytes());
    }
    let mut sdta_body = b"sdta".to_vec();
    write_chunk(&mut sdta_body, b"smpl", &samples);
    let mut pdta_body = b"pdta".to_vec();
    for chunk in &pdta {
        write_chunk(&mut pdta_body, &chunk.id, if &chunk.id == b"shdr" { &headers } else { chunk.data });
    }
    let mut body = b"sfbk".to_vec();
    if let Some(info) = info {
        let mut info_body = info.data.to_vec();
        // Mark the result as SF2 2.01 so readers do not treat it as version 3.
        if let Ok(items) = chunks(&info.data[4..]) {
            info_body = b"INFO".to_vec();
            for item in items {
                if &item.id == b"ifil" {
                    write_chunk(&mut info_body, b"ifil", &[2, 0, 1, 0]);
                } else {
                    write_chunk(&mut info_body, &item.id, item.data);
                }
            }
        }
        write_chunk(&mut body, b"LIST", &info_body);
    }
    write_chunk(&mut body, b"LIST", &sdta_body);
    write_chunk(&mut body, b"LIST", &pdta_body);
    let mut out = Vec::with_capacity(body.len() + 8);
    write_chunk(&mut out, b"RIFF", &body);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synth::SoundFont;

    fn bundled(name: &str) -> Option<Vec<u8>> {
        std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/alphatab/soundfont").join(name)).ok()
    }

    #[test]
    fn converts_the_compressed_sonivox_like_its_pcm_original() {
        let (Some(sf3), Some(sf2)) = (bundled("sonivox.sf3"), bundled("sonivox.sf2")) else { return };
        assert!(is_sf3(&sf3));
        assert!(!is_sf3(&sf2));
        let converted = to_sf2(&sf3).unwrap();
        assert!(!is_sf3(&converted));
        let a = SoundFont::new(&mut converted.as_slice()).unwrap();
        let b = SoundFont::new(&mut sf2.as_slice()).unwrap();
        assert_eq!(a.get_presets().len(), b.get_presets().len());
        assert_eq!(a.get_sample_headers().len(), b.get_sample_headers().len());
        for x in a.get_sample_headers() {
            // The SF3 tool reordered samples; match them by name.
            let y = b.get_sample_headers().iter().find(|y| y.get_name() == x.get_name()).expect("same sample names");
            // Lossy codec: lengths and loops may differ by a few samples at most.
            let len = |h: &crate::synth::SampleHeader| h.get_end() - h.get_start();
            assert!((len(x) - len(y)).abs() <= 64, "{} {} {}", x.get_name(), len(x), len(y));
            assert_eq!(x.get_end_loop() - x.get_start_loop(), y.get_end_loop() - y.get_start_loop(), "{}", x.get_name());
        }
    }

    #[test]
    fn plain_sf2_round_trips_unchanged_in_content() {
        let Some(sf2) = bundled("sonivox.sf2") else { return };
        let again = to_sf2(&sf2).unwrap();
        let a = SoundFont::new(&mut again.as_slice()).unwrap();
        let b = SoundFont::new(&mut sf2.as_slice()).unwrap();
        for (x, y) in a.get_sample_headers().iter().zip(b.get_sample_headers()) {
            assert_eq!(x.get_end() - x.get_start(), y.get_end() - y.get_start());
            assert_eq!(x.get_start_loop() - x.get_start(), y.get_start_loop() - y.get_start());
        }
        assert!(to_sf2(b"RIFF").is_err());
    }
}
