//! Disk cache for the toolbar's read-aloud audio.
//!
//! Kokoro returns a complete MP3 per text chunk. Chunks are appended to a
//! `.part.mp3` file while they are generated, then finalized into the
//! `<document>.mp3` next to the Markdown source. Finalizing re-encodes to a
//! 192 kbps CBR MP3 with ffmpeg when it is available, because the Kokoro
//! streaming writer hard-codes 128 kbps (see services/streaming_audio_writer.py).
//! Without ffmpeg the 128 kbps file is kept and the caller is told the real
//! bitrate, so the UI never claims 192k when it is not.
//!
//! Paths are restricted to `.mp3` / `.json` so these commands cannot become a
//! general-purpose file writer for the web view (same hardening as
//! read_markdown_file / write_markdown_file).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::ipc::Response;

const TARGET_BITRATE: i32 = 192;
const SOURCE_BITRATE: i32 = 128;

fn check_extension(path: &str, allowed: &[&str]) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !allowed.iter().any(|a| *a == ext) {
        return Err(format!("Refusing to touch a non-audio file: {}", path));
    }
    Ok(p)
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => return Err("Invalid base64 audio payload".to_string()),
        };
        buf = (buf << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Create (or truncate) the part file a generation run appends to.
#[tauri::command]
pub fn tts_cache_begin(part_path: String) -> Result<(), String> {
    let p = check_extension(&part_path, &["mp3"])?;
    fs::write(&p, b"").map_err(|e| format!("Failed to create {}: {}", part_path, e))
}

/// Append one synthesized chunk. `data` is base64 so the IPC payload stays small.
#[tauri::command]
pub fn tts_cache_append(part_path: String, data: String) -> Result<(), String> {
    let p = check_extension(&part_path, &["mp3"])?;
    let bytes = decode_base64(&data)?;
    let mut file = OpenOptions::new()
        .append(true)
        .open(&p)
        .map_err(|e| format!("Failed to open {}: {}", part_path, e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to append to {}: {}", part_path, e))
}

/// Whether a cache file exists and its sidecar hash matches the current
/// document. Missing or unreadable sidecars count as a miss so a stale or
/// half-written cache is never played as if it were current.
#[tauri::command]
pub fn tts_cache_valid(audio_path: String, sidecar_path: String, hash: String) -> bool {
    let audio = match check_extension(&audio_path, &["mp3"]) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let sidecar = match check_extension(&sidecar_path, &["json"]) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let has_audio = fs::metadata(&audio)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false);
    if !has_audio {
        return false;
    }
    let Ok(text) = fs::read_to_string(sidecar) else {
        return false;
    };
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    meta.get("hash").and_then(|v| v.as_str()) == Some(hash.as_str())
}

/// Read a finalized cache file back as raw bytes (no base64 round trip).
#[tauri::command]
pub fn tts_cache_read(audio_path: String) -> Result<Response, String> {
    let p = check_extension(&audio_path, &["mp3"])?;
    if !p.is_file() {
        return Err(format!("Cache not found: {}", audio_path));
    }
    let bytes = fs::read(&p).map_err(|e| format!("Failed to read {}: {}", audio_path, e))?;
    Ok(Response::new(bytes))
}

/// The sidecar JSON text, so the UI can show the real bitrate and duration of
/// a cache hit without a second cached call.
#[tauri::command]
pub fn tts_cache_meta(sidecar_path: String) -> Option<String> {
    let p = check_extension(&sidecar_path, &["json"]).ok()?;
    fs::read_to_string(p).ok()
}

/// Remove a part file (failed run, tab closed, stopped playback).
#[tauri::command]
pub fn tts_cache_delete(path: String) -> Result<(), String> {
    let p = check_extension(&path, &["mp3", "json"])?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("Failed to delete {}: {}", path, e))?;
    }
    Ok(())
}

/// Whether ffmpeg is on PATH. The UI uses this to explain a 128 kbps fallback
/// before a whole document is generated.
#[tauri::command]
pub fn tts_encoder_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn finalize_blocking(
    part_path: String,
    audio_path: String,
    sidecar_path: String,
    hash: String,
    source_size: u64,
    duration: f64,
) -> Result<i32, String> {
    let part = check_extension(&part_path, &["mp3"])?;
    let audio = check_extension(&audio_path, &["mp3"])?;
    let sidecar = check_extension(&sidecar_path, &["json"])?;

    if !part.is_file() {
        return Err(format!("Missing part file: {}", part_path));
    }

    let encoded = encode_192(&part, &audio);
    let bitrate = if encoded {
        let _ = fs::remove_file(&part);
        TARGET_BITRATE
    } else {
        // ffmpeg missing or failed: keep the chunks exactly as Kokoro produced
        // them. The sidecar records the real bitrate.
        if audio.exists() {
            let _ = fs::remove_file(&audio);
        }
        fs::rename(&part, &audio).map_err(|e| {
            format!(
                "Failed to move {} to {}: {}",
                part.display(),
                audio.display(),
                e
            )
        })?;
        SOURCE_BITRATE
    };

    let meta = serde_json::json!({
        "hash": hash,
        "sourceSize": source_size,
        "bitrate": bitrate,
        "duration": duration,
        "createdAt": chrono_stamp(),
    });
    let text = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("Failed to serialize cache metadata: {}", e))?;
    fs::write(&sidecar, text).map_err(|e| {
        format!(
            "Audio cached but metadata failed ({}): {}",
            sidecar.display(),
            e
        )
    })?;
    Ok(bitrate)
}

fn chrono_stamp() -> String {
    // Avoid a chrono dependency for one timestamp: seconds since the epoch is
    // enough for the sidecar and is trivially readable.
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => format!("{}", d.as_secs()),
        Err(_) => "0".to_string(),
    }
}

/// Encode the concatenated chunk stream as CBR 192 kbps MP3. Kokoro runs at
/// 24 kHz mono; MP3 needs MPEG-1 rates for 192k, so resample to 44.1 kHz.
fn encode_192(part: &Path, audio: &Path) -> bool {
    if audio.exists() {
        let _ = fs::remove_file(audio);
    }
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            part.to_string_lossy().as_ref(),
            "-ar",
            "44100",
            "-ac",
            "1",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            "-write_xing",
            "0",
            audio.to_string_lossy().as_ref(),
        ])
        .output();
    matches!(output, Ok(out) if out.status.success() && audio.is_file())
}

/// Finalize a generation run. Runs ffmpeg off the IPC thread because a long
/// document takes a few seconds to transcode.
#[tauri::command]
pub async fn tts_cache_finalize(
    part_path: String,
    audio_path: String,
    sidecar_path: String,
    hash: String,
    source_size: u64,
    duration: f64,
) -> Result<i32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        finalize_blocking(part_path, audio_path, sidecar_path, hash, source_size, duration)
    })
    .await
    .map_err(|e| format!("Cache finalize task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip() {
        // "hello" => aGVsbG8=
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello".to_vec());
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello".to_vec());
    }

    #[test]
    fn rejects_non_audio_paths() {
        assert!(check_extension("x.exe", &["mp3"]).is_err());
        assert!(check_extension("a.mp3", &["mp3"]).is_ok());
    }
}
