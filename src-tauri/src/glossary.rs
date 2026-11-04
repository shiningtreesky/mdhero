//! Dictionary lookups for the reading ("词") mode, plus its per-document cache.
//!
//! The cache file sits next to the Markdown source as `<document>.words.json`:
//! `{"version":1,"glosses":{"word":["释义1","释义2"]}}`. Writes are serialised
//! by a Mutex and go through a temp file + rename, so two quick lookups cannot
//! corrupt a half-written file.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn check_cache_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "json" {
        return Err(format!("Refusing to write a non-glossary file: {path}"));
    }
    Ok(p)
}

/// Read the cache file, returning `None` when it does not exist yet.
#[tauri::command]
pub fn glossary_read(path: String) -> Result<Option<String>, String> {
    let p = check_cache_path(&path)?;
    match fs::read_to_string(&p) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {path}: {error}")),
    }
}

/// Insert one word into the cache and write it back atomically.
#[tauri::command]
pub fn glossary_store(path: String, word: String, glosses: Vec<String>) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "Glossary cache lock poisoned".to_string())?;
    let p = check_cache_path(&path)?;
    let existing = fs::read_to_string(&p).ok();
    let merged = upsert_glossary(existing.as_deref(), &word, &glosses);

    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&merged).unwrap_or_default())
        .map_err(|e| format!("Failed to write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to replace {}: {}", p.display(), e)
    })
}

/// Merge one entry into the cache JSON, tolerating a missing or damaged file.
fn upsert_glossary(existing: Option<&str>, word: &str, glosses: &[String]) -> Value {
    let mut doc = existing
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({ "version": 1, "glosses": {} }));

    if !doc["glosses"].is_object() {
        doc["glosses"] = json!({});
    }
    doc["version"] = json!(1);
    doc["glosses"][word] = json!(glosses);
    doc
}

/// Ask the dictionary model for a word's Chinese meaning. Requests are made in
/// Rust so a LAN endpoint behind any CORS/CSP rules still works, and the key
/// never passes through the webview's fetch.
#[tauri::command]
pub async fn glossary_lookup(
    base_url: String,
    api_key: String,
    model: String,
    word: String,
) -> Result<String, String> {
    let url = crate::commands::chat_completions_url(&base_url)?;
    let body = json!({
        "model": model,
        "stream": false,
        "temperature": 0.2,
        "max_tokens": 32,
        "messages": [
            {
                "role": "system",
                "content": "You are a dictionary. Reply with only the most common Chinese meaning(s) of the given English word: one meaning, at most two for genuinely polysemous words, separated by \"/\". No explanations, no part of speech, no examples, no English."
            },
            { "role": "user", "content": word }
        ]
    });

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let mut request = client.post(&url).json(&body);
    let key = api_key.trim();
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Request to {url} failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {e}"))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("Invalid JSON response: {e}"))?;
    if let Some(message) = value["error"]["message"].as_str() {
        return Err(message.to_string());
    }
    let content = value["choices"][0]["message"]["content"]
        .as_str()
        .or_else(|| value["choices"][0]["text"].as_str())
        .ok_or_else(|| "The model returned no content".to_string())?;
    Ok(content.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_cache_document() {
        let doc = upsert_glossary(None, "token", &["令牌".to_string()]);
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["glosses"]["token"][0], "令牌");
    }

    #[test]
    fn keeps_other_words_and_overwrites_the_same_one() {
        let existing = r#"{"version":1,"glosses":{"run":["跑"],"token":["象征"]}}"#;
        let doc = upsert_glossary(Some(existing), "token", &["令牌".to_string()]);
        assert_eq!(doc["glosses"]["run"][0], "跑");
        assert_eq!(doc["glosses"]["token"][0], "令牌");
    }

    #[test]
    fn recovers_from_a_damaged_file() {
        let doc = upsert_glossary(Some("{ broken"), "word", &["词".to_string()]);
        assert_eq!(doc["glosses"]["word"][0], "词");
    }
}
