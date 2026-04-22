//! Read/write helpers for plugin manifests and approval records.
//!
//! These commands give the frontend a safe way to inspect a widget's
//! `widget.json` and persist the user's consent decision to
//! `~/.terminal64/widgets/{id}/.approved.json` — without exposing arbitrary
//! filesystem access or requiring `@tauri-apps/api/path` permissions.

use std::path::PathBuf;

fn widgets_base() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    Ok(home.join(".terminal64").join("widgets"))
}

fn validate_widget_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains("..")
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid widget id".to_string());
    }
    Ok(())
}

fn hash_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Read `widget.json` for a given widget. Returns `null` if the file does
/// not exist so the caller can distinguish "legacy web widget" from a real
/// read error. The response shape is:
///   `{ raw: <parsed JSON>, rawText: <source text>, hash: <sha256 hex> }`.
#[tauri::command]
pub fn read_widget_manifest(widget_id: String) -> Result<Option<serde_json::Value>, String> {
    validate_widget_id(&widget_id)?;
    let path = widgets_base()?.join(&widget_id).join("widget.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read widget.json: {}", e)),
    };
    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid JSON: {}", e))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let hash = hash_bytes(&bytes);
    Ok(Some(serde_json::json!({
        "raw": raw,
        "rawText": text,
        "hash": hash,
    })))
}

/// Read the existing `.approved.json` record for a widget, if any. Returns
/// `null` when no approval has been written yet so the caller can prompt the
/// user for consent.
#[tauri::command]
pub fn read_widget_approval(widget_id: String) -> Result<Option<serde_json::Value>, String> {
    validate_widget_id(&widget_id)?;
    let path = widgets_base()?.join(&widget_id).join(".approved.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read approval: {}", e)),
    };
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid approval JSON: {}", e))?;
    Ok(Some(value))
}

/// Persist an approval record. The caller is expected to pass a pre-serialized
/// JSON string so the hash stored inside the record matches the bytes written
/// to disk byte-for-byte.
#[tauri::command]
pub fn write_widget_approval(widget_id: String, content: String) -> Result<(), String> {
    validate_widget_id(&widget_id)?;
    // Sanity-check the payload is JSON so callers can't accidentally write
    // junk into the plugin dir.
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("approval content must be valid JSON: {}", e))?;
    let dir = widgets_base()?.join(&widget_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
    let path = dir.join(".approved.json");
    std::fs::write(&path, content).map_err(|e| format!("write approval: {}", e))?;
    Ok(())
}
