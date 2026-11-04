//! Whole-document scoring for the reading ("段") mode.
//!
//! One request carries every paragraph, so it can be slow and large; the HTTP
//! call happens in Rust for the same reasons as `glossary_lookup` (CSP, CORS)
//! and the API key never reaches the webview's fetch layer or the logs.

use serde_json::{json, Value};

#[tauri::command]
pub async fn grader_score(
    base_url: String,
    api_key: String,
    model: String,
    messages: Value,
) -> Result<String, String> {
    let url = crate::commands::chat_completions_url(&base_url)?;
    let body = json!({
        "model": model,
        "stream": false,
        "temperature": 0.2,
        "max_tokens": 4096,
        "messages": messages,
    });

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(180))
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
        let snippet: String = text.chars().take(400).collect();
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
