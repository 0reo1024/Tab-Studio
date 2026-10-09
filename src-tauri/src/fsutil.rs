//! Small file helpers shared by the stores and commands.
use std::path::Path;

/// Writes `file.writing` then renames it over `file`, so readers never see a partial file.
pub fn atomic_write(file: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut temp = file.as_os_str().to_owned();
    temp.push(".writing");
    std::fs::write(&temp, data)?;
    std::fs::rename(&temp, file)
}

/// Like Node's path.resolve for an absolute path: normalizes `.`/`..` and separators.
pub fn absolute(file: &str) -> String {
    std::path::absolute(file).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| file.to_string())
}

pub fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) { a.to_lowercase() == b.to_lowercase() } else { a == b }
}

pub fn file_name(file: &str) -> String {
    Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn extension_is(file: &Path, ext: &str) -> bool {
    file.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case(ext))
}

/// Replaces characters Windows does not allow in file names and caps the length (as Electron did).
pub fn safe_name(name: &str, max: usize) -> String {
    name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c }).take(max).collect()
}
