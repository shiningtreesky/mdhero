//! Per-document paragraph translations for the reading ("段") mode.
//!
//! The cache sits next to the Markdown source as `<document>.paras.json`:
//!
//! ```json
//! {"version":1,"items":[{"index":3,"hash":"<sha256 前16>","text":"译文",
//!                       "status":"translated","updatedAt":123}]}
//! ```
//!
//! Entries are keyed by paragraph index; `hash` records the English source the
//! translation was written against so the UI can flag a paragraph whose source
//! changed. Writes merge into the existing file under a Mutex and go through a
//! temp file + rename.

use std::sync::Mutex;

use serde_json::{json, Value};

use crate::json_store::{check_json_path, read_optional, write_atomic};

static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Read the paragraph cache, returning `None` when it does not exist yet.
#[tauri::command]
pub fn paras_read(path: String) -> Result<Option<String>, String> {
    let p = check_json_path(&path)?;
    read_optional(&p)
}

/// Upsert one paragraph and write the cache back atomically.
#[tauri::command]
pub fn paras_store(path: String, item: Value) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "Paragraph cache lock poisoned".to_string())?;
    let p = check_json_path(&path)?;
    let existing = read_optional(&p).unwrap_or(None);
    let merged = upsert_item(existing.as_deref(), &item)?;
    write_atomic(&p, &merged)
}

/// Merge one `{index, hash, text, status, updatedAt}` entry into the document.
/// A damaged or missing file starts a fresh one; other paragraphs survive.
fn upsert_item(existing: Option<&str>, item: &Value) -> Result<Value, String> {
    let index = item["index"]
        .as_i64()
        .ok_or_else(|| "Paragraph item is missing an integer index".to_string())?;
    let status = item["status"].as_str().unwrap_or("translated");
    if status != "translated" && status != "skipped" {
        return Err(format!("Unknown paragraph status: {status}"));
    }

    let mut doc = existing
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({ "version": 1, "items": [] }));

    if !doc["items"].is_array() {
        doc["items"] = json!([]);
    }
    doc["version"] = json!(1);

    let entry = json!({
        "index": index,
        "hash": item["hash"].as_str().unwrap_or(""),
        "text": item["text"].as_str().unwrap_or(""),
        "status": status,
        "updatedAt": item["updatedAt"].as_i64().unwrap_or(0),
    });

    let items = doc["items"].as_array_mut().expect("items is an array");
    match items.iter_mut().find(|value| value["index"].as_i64() == Some(index)) {
        Some(slot) => *slot = entry,
        None => items.push(entry),
    }
    items.sort_by_key(|value| value["index"].as_i64().unwrap_or(i64::MAX));
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(index: i64, hash: &str, text: &str, status: &str) -> Value {
        json!({ "index": index, "hash": hash, "text": text, "status": status, "updatedAt": 1 })
    }

    #[test]
    fn creates_a_document_from_scratch() {
        let doc = upsert_item(None, &item(3, "abc", "译文", "translated")).unwrap();
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["items"][0]["index"], 3);
        assert_eq!(doc["items"][0]["text"], "译文");
    }

    #[test]
    fn replaces_the_same_index_and_keeps_the_others() {
        let existing = r#"{"version":1,"items":[{"index":0,"hash":"a","text":"旧","status":"translated","updatedAt":1},{"index":2,"hash":"b","text":"保留","status":"translated","updatedAt":1}]}"#;
        let doc = upsert_item(Some(existing), &item(0, "c", "新", "translated")).unwrap();
        let items = doc["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["text"], "新");
        assert_eq!(items[0]["hash"], "c");
        assert_eq!(items[1]["text"], "保留");
    }

    #[test]
    fn keeps_skipped_paragraphs_and_sorts_by_index() {
        let existing = r#"{"version":1,"items":[{"index":5,"hash":"e","text":"","status":"skipped","updatedAt":1}]}"#;
        let doc = upsert_item(Some(existing), &item(1, "f", "新译", "translated")).unwrap();
        let items = doc["items"].as_array().unwrap();
        assert_eq!(items[0]["index"], 1);
        assert_eq!(items[1]["status"], "skipped");
    }

    #[test]
    fn recovers_from_a_damaged_file() {
        let doc = upsert_item(Some("{ broken"), &item(4, "g", "译", "translated")).unwrap();
        assert_eq!(doc["items"][0]["index"], 4);
    }

    #[test]
    fn rejects_unknown_status_and_missing_index() {
        assert!(upsert_item(None, &json!({ "index": 1, "status": "weird" })).is_err());
        assert!(upsert_item(None, &json!({ "status": "translated" })).is_err());
    }
}
