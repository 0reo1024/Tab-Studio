//! Tab Studio native audio engine (plan P2). Built as a standalone crate with a CLI
//! test harness first, then wired into the Tauri shell.
pub mod sf3;
pub mod wav;
pub mod synth;
pub mod player;
pub mod song;
pub mod engine;
pub mod output;
pub mod click;
pub mod dsp;
pub mod compressor;
pub mod fx;
pub mod sfz;
pub mod nam;
pub mod pool;
pub mod live;
pub mod recorder;
pub mod device;
pub mod backing;
