//! Small helpers shared by the per-document cache files (`.words.json`,
//! `.paras.json`): a path guard, a tolerant reader and an atomic writer.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Only ever touch `.json` files: these commands are callable from the webview,
/// so they must not become an arbitrary file writer.
pub fn check_json_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "json" {
        return Err(format!("Refusing to write a non-cache file: {path}"));
    }
    Ok(p)
}

/// Read a cache file, returning `None` when it does not exist yet.
pub fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

/// Write a temp file and rename it over the target so a crash cannot leave a
/// half-written cache behind.
pub fn write_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value).unwrap_or_default())
        .map_err(|e| format!("Failed to write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to replace {}: {}", path.display(), e)
    })
}
