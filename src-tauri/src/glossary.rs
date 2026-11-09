//! Dictionary and sentence lookups for the reading ("词"/"句") modes, plus
//! their per-document caches.
//!
//! The cache files sit next to the Markdown source as `<document>.words.json`
//! and `<document>.sentences.json`:
//! `{"version":2,"glosses":{"word":["释义1","释义2"]},"phonetics":{"word":{"uk":"","us":""}}}`.
//! Version-1 files (glosses only) still load. Writes are serialised by a Mutex
//! and go through a temp file + rename, so two quick lookups cannot corrupt a
//! half-written file.

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

/// Insert one word (and optionally its IPA) into the cache and write it back
/// atomically.
#[tauri::command]
pub fn glossary_store(
    path: String,
    word: String,
    glosses: Vec<String>,
    phonetic_uk: Option<String>,
    phonetic_us: Option<String>,
) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "Glossary cache lock poisoned".to_string())?;
    let p = check_cache_path(&path)?;
    let existing = fs::read_to_string(&p).ok();
    let merged = upsert_glossary(
        existing.as_deref(),
        &word,
        &glosses,
        phonetic_uk.as_deref(),
        phonetic_us.as_deref(),
    );

    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&merged).unwrap_or_default())
        .map_err(|e| format!("Failed to write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to replace {}: {}", p.display(), e)
    })
}

/// Merge one entry into the cache JSON, tolerating a missing or damaged file.
/// Version-1 files (glosses only) are upgraded in place; the `phonetics` map is
/// only created when the caller actually asked the model for IPA, so sentence
/// caches stay unchanged.
fn upsert_glossary(
    existing: Option<&str>,
    word: &str,
    glosses: &[String],
    phonetic_uk: Option<&str>,
    phonetic_us: Option<&str>,
) -> Value {
    let mut doc = existing
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({ "version": 2, "glosses": {} }));

    if !doc["glosses"].is_object() {
        doc["glosses"] = json!({});
    }
    doc["version"] = json!(2);
    doc["glosses"][word] = json!(glosses);

    if phonetic_uk.is_some() || phonetic_us.is_some() {
        if !doc["phonetics"].is_object() {
            doc["phonetics"] = json!({});
        }
        doc["phonetics"][word] = json!({
            "uk": phonetic_uk.unwrap_or(""),
            "us": phonetic_us.unwrap_or(""),
        });
    }
    doc
}

/// One OpenAI-compatible chat completion. Requests are made in Rust so a LAN
/// endpoint behind any CORS/CSP rules still works, and the key never passes
/// through the webview's fetch.
async fn request_chat(
    base_url: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_text: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let url = crate::commands::chat_completions_url(base_url)?;
    let body = json!({
        "model": model,
        "stream": false,
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_text }
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

const GLOSS_PROMPT: &str = "You are a dictionary. Reply with only the most common Chinese meaning(s) of the given English word or phrase: one meaning, at most two for genuinely polysemous words, separated by \"/\". No explanations, no part of speech, no examples, no English.";

/// Dedicated IPA request, separate from the gloss request so a model that
/// ignores this format can never damage the Chinese meaning. The example makes
/// the two-line shape explicit for small instruction-following models.
const PHONETIC_PROMPT: &str = r#"You are an English pronunciation dictionary. Reply with only the British and American IPA of the English word or phrase the user sends, in exactly this format:
UK: /British IPA/
US: /American IPA/
Example for "token":
UK: /ˈtəʊkən/
US: /ˈtoʊkən/
Do not repeat the example; transcribe the word the user sends. No other text, no Chinese, no explanations. If a transcription is unknown, reply with UK: // or US: //."#;

/// Ask the dictionary model for a word's Chinese meaning.
#[tauri::command]
pub async fn glossary_lookup(
    base_url: String,
    api_key: String,
    model: String,
    word: String,
) -> Result<String, String> {
    request_chat(&base_url, &api_key, &model, GLOSS_PROMPT, &word, 32).await
}

/// Ask only for IPA. The frontend merges it with the separately fetched gloss.
#[tauri::command]
pub async fn glossary_lookup_phonetic(
    base_url: String,
    api_key: String,
    model: String,
    word: String,
) -> Result<String, String> {
    request_chat(&base_url, &api_key, &model, PHONETIC_PROMPT, &word, 80).await
}

/// Translate one English sentence into Chinese through the same endpoint and
/// model as `glossary_lookup`.
#[tauri::command]
pub async fn glossary_lookup_sentence(
    base_url: String,
    api_key: String,
    model: String,
    sentence: String,
) -> Result<String, String> {
    request_chat(
        &base_url,
        &api_key,
        &model,
        "You are a translator. Translate the given English sentence into natural, accurate Simplified Chinese. Reply with only the translation: no explanations, no quotes, no source text, and no English.",
        &sentence,
        512,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_cache_document() {
        let doc = upsert_glossary(None, "token", &["令牌".to_string()], None, None);
        assert_eq!(doc["version"], 2);
        assert_eq!(doc["glosses"]["token"][0], "令牌");
        assert!(doc.get("phonetics").is_none());
    }

    #[test]
    fn keeps_other_words_and_overwrites_the_same_one() {
        let existing = r#"{"version":1,"glosses":{"run":["跑"],"token":["象征"]}}"#;
        let doc = upsert_glossary(Some(existing), "token", &["令牌".to_string()], None, None);
        assert_eq!(doc["glosses"]["run"][0], "跑");
        assert_eq!(doc["glosses"]["token"][0], "令牌");
    }

    #[test]
    fn recovers_from_a_damaged_file() {
        let doc = upsert_glossary(Some("{ broken"), "word", &["词".to_string()], None, None);
        assert_eq!(doc["glosses"]["word"][0], "词");
    }

    #[test]
    fn stores_phonetics_and_upgrades_the_document_version() {
        let existing = r#"{"version":1,"glosses":{"run":["跑"]}}"#;
        let doc = upsert_glossary(
            Some(existing),
            "token",
            &["令牌".to_string()],
            Some("ˈtəʊkən"),
            Some("ˈtoʊkən"),
        );
        assert_eq!(doc["version"], 2);
        assert_eq!(doc["glosses"]["run"][0], "跑");
        assert_eq!(doc["glosses"]["token"][0], "令牌");
        assert_eq!(doc["phonetics"]["token"]["uk"], "ˈtəʊkən");
        assert_eq!(doc["phonetics"]["token"]["us"], "ˈtoʊkən");
    }
}
