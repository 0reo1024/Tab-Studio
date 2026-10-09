//! CLI harness: `convert <in.sf3> <out.sf2>`, `render <soundfont> <in.mid> <out.wav>`,
//! `events <soundfont> <in.tsev> <out.wav>` (the engine's own player, stems summed).
use std::sync::Arc;
use tabstudio_audio::{player, song, sf3, wav};

fn load_font(path: &str) -> Result<Arc<tabstudio_audio::synth::SoundFont>, Box<dyn std::error::Error>> {
    let mut data = std::fs::read(path)?;
    if sf3::is_sf3(&data) {
        data = sf3::to_sf2(&data)?;
    }
    Ok(Arc::new(tabstudio_audio::synth::SoundFont::new(&mut data.as_slice())?))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("convert") => {
            let data = std::fs::read(&args[2])?;
            let started = std::time::Instant::now();
            let out = sf3::to_sf2(&data)?;
            std::fs::write(&args[3], &out)?;
            println!("converted {} -> {} bytes in {:?}", data.len(), out.len(), started.elapsed());
        }
        Some("render") => {
            let mut data = std::fs::read(&args[2])?;
            if sf3::is_sf3(&data) {
                data = sf3::to_sf2(&data)?;
            }
            let font = Arc::new(tabstudio_audio::synth::SoundFont::new(&mut data.as_slice())?);
            let midi = Arc::new(tabstudio_audio::synth::MidiFile::new(&mut std::fs::File::open(&args[3])?)?);
            let settings = tabstudio_audio::synth::SynthesizerSettings::new(44100);
            let synth = tabstudio_audio::synth::Synthesizer::new(&font, &settings)?;
            let mut sequencer = tabstudio_audio::synth::MidiFileSequencer::new(synth);
            sequencer.play(&midi, false);
            let frames = ((midi.get_length() + 2.0) * 44100.0) as usize;
            let (mut left, mut right) = (vec![0f32; frames], vec![0f32; frames]);
            let started = std::time::Instant::now();
            sequencer.render(&mut left, &mut right);
            let took = started.elapsed();
            std::fs::write(&args[4], wav::stereo_16(&left, &right, 44100))?;
            println!("rendered {:.1}s of audio in {:?} ({:.0}x real time)", frames as f64 / 44100.0, took, frames as f64 / 44100.0 / took.as_secs_f64());
        }
        Some("events") => {
            let font = load_font(&args[2])?;
            let song = Arc::new(song::Song::parse(&std::fs::read(&args[3])?).map_err(|e| e.0)?);
            let rate = 44100;
            let mut player = player::Player::new(song.clone(), &font, rate)?;
            let block = 512;
            let mut stems: Vec<player::Stem> = (0..player.tracks()).map(|_| player::Stem::new(block)).collect();
            let (mut left, mut right) = (Vec::new(), Vec::new());
            let tail = (2.0 * rate as f64) as usize;
            let started = std::time::Instant::now();
            player.play();
            let mut after_end = 0;
            while after_end < tail {
                player.render(&mut stems, block);
                for i in 0..block {
                    left.push(stems.iter().map(|s| s.left[i]).sum::<f32>());
                    right.push(stems.iter().map(|s| s.right[i]).sum::<f32>());
                }
                if !player.is_playing() {
                    after_end += block;
                }
            }
            let took = started.elapsed();
            std::fs::write(&args[4], wav::stereo_16(&left, &right, rate))?;
            println!("{} tracks, {:.1}s in {:?}", player.tracks(), left.len() as f64 / rate as f64, took);
        }
        _ => eprintln!("usage: tabstudio-audio convert <in.sf3> <out.sf2> | render <soundfont> <in.mid> <out.wav>"),
    }
    Ok(())
}
