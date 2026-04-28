use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const WIDGET_BRIDGE_REQUEST_EVENT: &str = "widget-bridge-request";

const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 15_000;
const MAX_REQUEST_TIMEOUT_MS: u64 = 60_000;
const MIN_REQUEST_TIMEOUT_MS: u64 = 250;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetBridgeMessage {
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetBridgeRequestEvent {
    pub widget_id: String,
    pub instance_id: String,
    pub request_id: String,
    pub transport: WidgetBridgeTransport,
    pub timeout_ms: u64,
    pub message: WidgetBridgeMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WidgetBridgeTransport {
    #[serde(rename = "native-webview")]
    NativeWebview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetBridgeError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetBridgeResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<WidgetBridgeError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetBridgeEventFrame {
    pub widget_id: String,
    pub instance_id: String,
    pub event: WidgetBridgeMessage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetBridgeHttpRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetBridgeRespondRequest {
    pub widget_id: String,
    pub instance_id: String,
    pub request_id: String,
    pub response: WidgetBridgeResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetBridgeEmitEventRequest {
    pub widget_id: String,
    pub instance_id: String,
    pub event: WidgetBridgeMessage,
}

type PendingKey = (String, String, String);
type SubscriberKey = (String, String);

pub struct WidgetBridgeBroker {
    app: AppHandle,
    pending: Mutex<HashMap<PendingKey, mpsc::SyncSender<WidgetBridgeResponse>>>,
    subscribers: Mutex<HashMap<SubscriberKey, Vec<mpsc::Sender<String>>>>,
}

impl WidgetBridgeBroker {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(HashMap::new()),
        }
    }

    pub fn handle_http_request(
        &self,
        widget_id: &str,
        instance_id: &str,
        body: &[u8],
    ) -> (u16, serde_json::Value) {
        if !is_valid_bridge_id(widget_id) {
            return error_response(403, "", "bad_widget_id", "Invalid widget id", None);
        }
        if !is_valid_bridge_id(instance_id) {
            return error_response(
                403,
                "",
                "bad_instance_id",
                "Invalid widget bridge instance id",
                None,
            );
        }

        let req: WidgetBridgeHttpRequest = match serde_json::from_slice(body) {
            Ok(req) => req,
            Err(e) => {
                return error_response(
                    400,
                    "",
                    "bad_request",
                    &format!("Invalid widget bridge envelope: {}", e),
                    None,
                );
            }
        };

        if req.message_type.trim().is_empty() {
            return error_response(
                400,
                "",
                "bad_request",
                "Widget bridge message type is required",
                None,
            );
        }

        let timeout_ms = clamp_timeout(req.timeout_ms);
        let request_id = match req.request_id {
            Some(id) if is_valid_request_id(&id) => id,
            Some(id) => {
                return error_response(
                    400,
                    &id,
                    "bad_request_id",
                    "Invalid widget bridge request id",
                    None,
                );
            }
            None => uuid::Uuid::new_v4().to_string(),
        };
        let key = (
            widget_id.to_string(),
            instance_id.to_string(),
            request_id.clone(),
        );
        let (tx, rx) = mpsc::sync_channel(1);

        {
            let mut pending = match self.pending.lock() {
                Ok(pending) => pending,
                Err(_) => {
                    return error_response(
                        500,
                        &request_id,
                        "internal",
                        "Widget bridge lock poisoned",
                        None,
                    );
                }
            };
            if pending.contains_key(&key) {
                return error_response(
                    409,
                    &request_id,
                    "duplicate_request",
                    "A widget bridge request with this id is already pending",
                    None,
                );
            }
            pending.insert(key.clone(), tx);
        }

        let event = WidgetBridgeRequestEvent {
            widget_id: widget_id.to_string(),
            instance_id: instance_id.to_string(),
            request_id: request_id.clone(),
            transport: WidgetBridgeTransport::NativeWebview,
            timeout_ms,
            message: WidgetBridgeMessage {
                message_type: req.message_type,
                payload: req.payload,
            },
        };

        if let Err(e) = self.app.emit(WIDGET_BRIDGE_REQUEST_EVENT, event) {
            self.remove_pending(&key);
            return error_response(
                500,
                &request_id,
                "emit_failed",
                &format!("Failed to emit widget bridge request: {}", e),
                None,
            );
        }

        match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(mut response) => {
                if response.request_id.is_none() {
                    response.request_id = Some(request_id.clone());
                }
                let status = if response.ok { 200 } else { 500 };
                (
                    status,
                    serde_json::to_value(response)
                        .unwrap_or_else(|_| serde_json::json!({ "ok": false })),
                )
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.remove_pending(&key);
                error_response(
                    504,
                    &request_id,
                    "timeout",
                    &format!("Widget bridge request timed out after {}ms", timeout_ms),
                    Some(serde_json::json!({ "timeoutMs": timeout_ms })),
                )
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.remove_pending(&key);
                error_response(
                    500,
                    &request_id,
                    "internal",
                    "Widget bridge response channel closed",
                    None,
                )
            }
        }
    }

    pub fn respond(&self, req: WidgetBridgeRespondRequest) -> Result<(), String> {
        validate_contract_ids(&req.widget_id, &req.instance_id)?;
        if !is_valid_request_id(&req.request_id) {
            return Err("invalid widget bridge request id".to_string());
        }
        let key = (req.widget_id, req.instance_id, req.request_id.clone());
        let tx = self.remove_pending(&key).ok_or_else(|| {
            format!(
                "unknown or expired widget bridge request: {}",
                req.request_id
            )
        })?;
        tx.send(req.response)
            .map_err(|_| "widget bridge requester disconnected".to_string())
    }

    pub fn emit_event(&self, req: WidgetBridgeEmitEventRequest) -> Result<usize, String> {
        validate_contract_ids(&req.widget_id, &req.instance_id)?;
        if req.event.message_type.trim().is_empty() {
            return Err("widget bridge event type is required".to_string());
        }

        let frame = WidgetBridgeEventFrame {
            widget_id: req.widget_id.clone(),
            instance_id: req.instance_id.clone(),
            event: req.event,
        };
        let payload = serde_json::to_string(&frame)
            .map_err(|e| format!("serialize widget bridge event: {}", e))?;
        let key = (req.widget_id, req.instance_id);
        let mut subscribers = self
            .subscribers
            .lock()
            .map_err(|_| "widget bridge subscriber lock poisoned".to_string())?;
        let Some(list) = subscribers.get_mut(&key) else {
            return Ok(0);
        };

        let mut delivered = 0usize;
        list.retain(|tx| {
            if tx.send(payload.clone()).is_ok() {
                delivered += 1;
                true
            } else {
                false
            }
        });
        if list.is_empty() {
            subscribers.remove(&key);
        }
        Ok(delivered)
    }

    pub fn subscribe(
        &self,
        widget_id: &str,
        instance_id: &str,
    ) -> Result<mpsc::Receiver<String>, String> {
        validate_contract_ids(widget_id, instance_id)?;
        let (tx, rx) = mpsc::channel();
        let key = (widget_id.to_string(), instance_id.to_string());
        let mut subscribers = self
            .subscribers
            .lock()
            .map_err(|_| "widget bridge subscriber lock poisoned".to_string())?;
        subscribers.entry(key).or_default().push(tx);
        Ok(rx)
    }

    fn remove_pending(&self, key: &PendingKey) -> Option<mpsc::SyncSender<WidgetBridgeResponse>> {
        self.pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(key))
    }
}

pub fn bridge_ready_frame(widget_id: &str, instance_id: &str) -> String {
    let frame = WidgetBridgeEventFrame {
        widget_id: widget_id.to_string(),
        instance_id: instance_id.to_string(),
        event: WidgetBridgeMessage {
            message_type: "t64:bridge-ready".to_string(),
            payload: serde_json::json!({
                "transport": "native-webview",
                "widgetId": widget_id,
                "instanceId": instance_id,
            }),
        },
    };
    serde_json::to_string(&frame).unwrap_or_else(|_| "{}".to_string())
}

fn validate_contract_ids(widget_id: &str, instance_id: &str) -> Result<(), String> {
    if !is_valid_bridge_id(widget_id) {
        return Err("invalid widget id".to_string());
    }
    if !is_valid_bridge_id(instance_id) {
        return Err("invalid widget bridge instance id".to_string());
    }
    Ok(())
}

fn is_valid_bridge_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn is_valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == ':')
}

fn clamp_timeout(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS)
        .clamp(MIN_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS)
}

fn error_response(
    status: u16,
    request_id: &str,
    code: &str,
    message: &str,
    details: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let mut response = WidgetBridgeResponse {
        ok: false,
        request_id: None,
        result: None,
        error: Some(WidgetBridgeError {
            code: code.to_string(),
            message: message.to_string(),
            details,
        }),
    };
    if !request_id.is_empty() {
        response.request_id = Some(request_id.to_string());
    }
    (
        status,
        serde_json::to_value(response).unwrap_or_else(|_| serde_json::json!({ "ok": false })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_bridge_ids() {
        assert!(is_valid_bridge_id("widget-main_1"));
        assert!(!is_valid_bridge_id("../bad"));
        assert!(!is_valid_bridge_id("bad.dot"));
    }

    #[test]
    fn clamps_timeouts() {
        assert_eq!(clamp_timeout(None), DEFAULT_REQUEST_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(1)), MIN_REQUEST_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(120_000)), MAX_REQUEST_TIMEOUT_MS);
    }
}
