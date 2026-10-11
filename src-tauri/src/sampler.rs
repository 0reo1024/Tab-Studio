//! SFZ instruments (Standard Guitar "Guitar DI") through the bundled Python sfz-host.py,
//! as electron/fx-host.cjs does: one host process per loaded instrument, JSON lines on
//! stdin, `TABSTUDIO:{...}` replies on stdout (id 0 = ready). Rendered PCM comes back as
//! base64 little-endian f32 stereo and is passed to the WebView as raw bytes.
//! External effects (VST3) run the same way through tabstudio-fx-host, which speaks
//! fx-host.py's protocol (crates/tabstudio-fx-host, MIGRATION_PROGRESS P2-13).
use base64::Engine as _;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<u64, Sender<Reply>>>>;

struct Instance {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next: AtomicU64,
}

impl Instance {
    fn ask(&self, cmd: &str, mut args: Value, timeout: Duration) -> Reply {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        args["id"] = json!(id);
        args["cmd"] = json!(cmd);
        let line = serde_json::to_string(&args).map_err(|e| e.to_string())? + "\n";
        let written = self.stdin.lock().unwrap_or_else(|e| e.into_inner()).write_all(line.as_bytes());
        if let Err(error) = written {
            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return Err(error.to_string());
        }
        match rx.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(_) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                Err("音源の応答がタイムアウトしました。".into())
            }
        }
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap_or_else(|e| e.into_inner()).kill();
    }
}

#[derive(Default)]
pub struct SamplerHost {
    instances: Mutex<HashMap<String, Arc<Instance>>>,
    counter: AtomicU64,
}

pub fn valid_lanes(value: &Value) -> Result<Vec<u8>, String> {
    let invalid = || "SFZの弦指定が不正です。".to_string();
    let list = value.as_array().ok_or_else(invalid)?;
    if list.len() > 12 {
        return Err(invalid());
    }
    let mut lanes = Vec::new();
    for lane in list {
        let lane = lane.as_u64().filter(|l| (1..=12).contains(l)).ok_or_else(invalid)? as u8;
        if !lanes.contains(&lane) {
            lanes.push(lane);
        }
    }
    Ok(lanes)
}

pub fn valid_pitches(value: &Value) -> Result<Value, String> {
    let invalid = || "SFZの音程指定が不正です。".to_string();
    let Some(map) = value.as_object() else {
        return if value.is_null() { Ok(json!({})) } else { Err(invalid()) };
    };
    if map.len() > 12 {
        return Err(invalid());
    }
    let mut out = serde_json::Map::new();
    for (lane, keys) in map {
        if !lane.parse::<u8>().is_ok_and(|l| (1..=12).contains(&l)) || lane.starts_with('0') {
            return Err(invalid());
        }
        let keys = keys.as_array().filter(|k| k.len() <= 128).ok_or_else(invalid)?;
        let mut unique: Vec<u64> = Vec::new();
        for key in keys {
            let key = key.as_u64().filter(|k| *k <= 127).ok_or_else(invalid)?;
            if !unique.contains(&key) {
                unique.push(key);
            }
        }
        out.insert(lane.clone(), json!(unique));
    }
    Ok(Value::Object(out))
}

fn python(native: &Path) -> PathBuf {
    native.join("runtime").join(if cfg!(windows) { "python.exe" } else { "bin/python3" })
}

impl SamplerHost {
    fn get(&self, id: &str) -> Result<Arc<Instance>, String> {
        self.instances.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned().ok_or_else(|| "FXが読み込まれていません。".to_string())
    }

    /// Starts a host for `file` and waits until it reports ready (large libraries take a while).
    pub fn load(&self, native: &Path, file: &str, lanes: &[u8], pitches: &Value) -> Result<(String, String), String> {
        let path = Path::new(file);
        if !path.is_absolute() || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("sfz")) || !path.is_file() {
            return Err("SFZ音源を選択してください。".into());
        }
        let mut command = Command::new(python(native));
        command.arg(native.join("sfz-host.py")).arg(file).arg(serde_json::to_string(lanes).unwrap()).arg(pitches.to_string());
        let (id, ready) = self.spawn(command, Duration::from_secs(120), "SFZホスト")?;
        Ok((id, ready.get("name").and_then(Value::as_str).unwrap_or("SFZ").to_string()))
    }

    /// Starts the effect host for a VST3 plugin, restoring `state` (base64 .vstpreset) if given.
    pub fn load_fx(&self, host: &Path, plugin: &Path, state: Option<&str>) -> Result<(String, String), String> {
        let mut command = Command::new(host);
        command.arg(plugin);
        let (id, ready) = self.spawn(command, Duration::from_secs(20), "FXホスト")?;
        if let Some(state) = state {
            if let Err(error) = self.command(&id, "restore", json!({"state": state})) {
                self.close(&id);
                return Err(error);
            }
        }
        Ok((id, ready.get("name").and_then(Value::as_str).unwrap_or("FX").to_string()))
    }

    /// Runs a host program and waits for its ready line (id 0).
    fn spawn(&self, mut command: Command, ready_timeout: Duration, what: &str) -> Result<(String, Value), String> {
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| format!("{what}を起動できません：{e}"))?;
        let stdin = child.stdin.take().ok_or(format!("{what}を起動できません。"))?;
        let stdout = child.stdout.take().ok_or(format!("{what}を起動できません。"))?;
        let pending: Pending = Arc::default();
        let (ready_tx, ready_rx) = channel::<Reply>();
        let reader_pending = pending.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Some(body) = line.strip_prefix("TABSTUDIO:") else { continue };
                let Ok(reply) = serde_json::from_str::<Value>(body) else { continue };
                let result = match reply.get("error").and_then(Value::as_str) {
                    Some(error) => Err(error.to_string()),
                    None => Ok(reply.clone()),
                };
                let id = reply.get("id").and_then(Value::as_u64).unwrap_or(0);
                if id == 0 {
                    let _ = ready_tx.send(result);
                } else if let Some(tx) = reader_pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                    let _ = tx.send(result);
                }
            }
            // Host ended: fail everything still waiting.
            let _ = ready_tx.send(Err("FXホストが終了しました".into()));
            for (_, tx) in reader_pending.lock().unwrap_or_else(|e| e.into_inner()).drain() {
                let _ = tx.send(Err("FXホストが終了しました".into()));
            }
        });
        let instance = Arc::new(Instance { child: Mutex::new(child), stdin: Mutex::new(stdin), pending, next: AtomicU64::new(0) });
        let ready = ready_rx.recv_timeout(ready_timeout).unwrap_or_else(|_| Err("音源・プラグインの読み込みがタイムアウトしました。".into()))?;
        let id = (self.counter.fetch_add(1, Ordering::Relaxed) + 1).to_string();
        self.instances.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), instance);
        Ok((id, ready))
    }

    /// A command that may wait for the user (the editor answers when its window closes).
    pub fn command_waiting(&self, id: &str, cmd: &str, args: Value) -> Reply {
        self.get(id)?.ask(cmd, args, Duration::from_secs(60 * 60 * 24))
    }

    /// One block through an effect: little-endian f32 stereo interleaved in and out.
    pub fn process(&self, id: &str, pcm: &[u8], rate: f64) -> Result<Vec<u8>, String> {
        if pcm.len() > 1024 * 1024 || pcm.len() % 8 != 0 || !(22050.0..=192000.0).contains(&rate) {
            return Err("音声ブロックが不正です。".into());
        }
        let b64 = base64::engine::general_purpose::STANDARD;
        let reply = self.command(id, "process", json!({"pcm": b64.encode(pcm), "rate": rate}))?;
        let pcm = reply.get("pcm").and_then(Value::as_str).ok_or("FXの音声が返されませんでした。")?;
        b64.decode(pcm).map_err(|e| e.to_string())
    }

    pub fn command(&self, id: &str, cmd: &str, args: Value) -> Reply {
        self.get(id)?.ask(cmd, args, Duration::from_secs(10))
    }

    /// One block of audio: little-endian f32 stereo interleaved, `frames` frames.
    pub fn render(&self, id: &str, frames: u32, rate: f64, events: Value) -> Result<Vec<u8>, String> {
        if !(1..=4096).contains(&frames) || !rate.is_finite() || !events.as_array().is_some_and(|e| e.len() <= 8192) {
            return Err("SFZ再生データが不正です。".into());
        }
        let reply = self.command(id, "render", json!({"frames": frames, "rate": rate, "events": events}))?;
        let pcm = reply.get("pcm").and_then(Value::as_str).ok_or("SFZの音声が返されませんでした。")?;
        base64::engine::general_purpose::STANDARD.decode(pcm).map_err(|e| e.to_string())
    }

    pub fn close(&self, id: &str) {
        self.instances.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    pub fn close_all(&self) {
        self.instances.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

/// The bass DIs as registered by scripts/install-standard-bass.py (finger, then pick) and
/// scripts/install-growlybass.py (Growly).
pub fn find_standard_bass(native: &Path) -> Vec<(&'static str, String)> {
    let manifest = std::fs::read(native.join("soundfonts.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    [("Bass DI (finger)", "standardBassFinger"), ("Bass DI (pick)", "standardBassPick"), ("Bass DI (Growly)", "growlyBass")]
        .into_iter()
        .filter_map(|(name, key)| {
            let file = manifest.as_ref()?.get(key)?.as_str()?.to_string();
            Path::new(&file).is_file().then_some((name, file))
        })
        .collect()
}

/// Where the Standard Guitar SFZ is: the remembered choice, the installed library, the
/// bundled folder, then the desktop (same order as electron/main.cjs sfzLibrary).
pub fn find_standard_guitar(registry: &Path, electron_registry: Option<&Path>, native: &Path, desktop: Option<&Path>) -> Option<String> {
    let read = |file: &Path, key: &str| std::fs::read(file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.get(key).and_then(Value::as_str).map(String::from));
    let relative = Path::new("UI_Standard_Guitar").join("Programs").join("01-Standard Guitar KSOP.sfz");
    let candidates = [
        read(registry, "path"),
        electron_registry.and_then(|r| read(r, "path")),
        read(&native.join("soundfonts.json"), "standardGuitar"),
        Some(native.join("soundfonts").join(&relative).to_string_lossy().into_owned()),
        desktop.map(|d| d.join(&relative).to_string_lossy().into_owned()),
    ];
    let found = candidates.into_iter().flatten().find(|file| Path::new(file).is_file())?;
    let _ = crate::fsutil::atomic_write(registry, json!({"path": found}).to_string().as_bytes());
    Some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_lanes_and_pitches_like_electron() {
        assert_eq!(valid_lanes(&json!([1, 2, 2, 6])).unwrap(), vec![1, 2, 6]);
        assert!(valid_lanes(&json!([0])).is_err());
        assert!(valid_lanes(&json!([13])).is_err());
        assert!(valid_lanes(&json!((1..=13).collect::<Vec<_>>())).is_err());
        assert_eq!(valid_pitches(&json!({"1": [40, 40, 52]})).unwrap(), json!({"1": [40, 52]}));
        assert_eq!(valid_pitches(&Value::Null).unwrap(), json!({}));
        assert!(valid_pitches(&json!({"13": [1]})).is_err());
        assert!(valid_pitches(&json!({"1": [128]})).is_err());
        assert!(valid_pitches(&json!([1])).is_err());
    }

    #[test]
    fn finds_the_standard_guitar_and_remembers_it() {
        let dir = tempfile::tempdir().unwrap();
        let native = dir.path().join("native");
        let sfz = native.join("soundfonts").join("UI_Standard_Guitar").join("Programs").join("01-Standard Guitar KSOP.sfz");
        let registry = dir.path().join("data").join("standard-guitar.json");
        assert_eq!(find_standard_guitar(&registry, None, &native, None), None);
        std::fs::create_dir_all(sfz.parent().unwrap()).unwrap();
        std::fs::write(&sfz, "<region>").unwrap();
        let found = find_standard_guitar(&registry, None, &native, None).unwrap();
        assert_eq!(Path::new(&found), sfz);
        let saved: Value = serde_json::from_slice(&std::fs::read(&registry).unwrap()).unwrap();
        assert_eq!(saved["path"], json!(found));
    }

    #[test]
    fn rejects_files_that_are_not_sfz() {
        let host = SamplerHost::default();
        assert!(host.load(Path::new("."), "relative.sfz", &[1], &json!({})).is_err());
        assert!(host.render("missing", 128, 48000.0, json!([])).is_err());
        assert!(host.render("missing", 0, 48000.0, json!([])).is_err());
    }
}
