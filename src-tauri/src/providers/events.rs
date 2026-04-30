//! Backend provider event contracts.
//!
//! The live Terminal 64 stream contract is [`ProviderRuntimeEvent`]. Adapters
//! should emit that smaller envelope on the shared `provider-event` topic via
//! `crate::providers::emit_provider_runtime_event`.
//!
//! The larger t3code-shaped event matrix lives under [`experimental`]. It is a
//! docs/reference type only and is not a supported adapter emission target.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Canonical backend-to-frontend runtime event envelope.
///
/// This is intentionally smaller than the t3code event matrix: providers emit
/// one of the stable Terminal 64 categories and put provider-owned details in
/// flattened payload fields. Frontend decoders can ingest these directly while
/// legacy Claude/Codex raw streams continue to use provider-specific decoders.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum ProviderRuntimeEventType {
    #[serde(rename = "provider.session")]
    Session,
    #[serde(rename = "provider.turn")]
    Turn,
    #[serde(rename = "provider.content")]
    Content,
    #[serde(rename = "provider.tool")]
    Tool,
    #[serde(rename = "provider.mcp")]
    Mcp,
    #[serde(rename = "provider.error")]
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderRuntimeEvent {
    #[serde(rename = "type")]
    pub event_type: ProviderRuntimeEventType,
    pub provider: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,

    #[serde(rename = "threadId", default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(rename = "turnId", default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(rename = "itemId", default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(
        rename = "nativeType",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub native_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,

    #[serde(flatten)]
    pub payload: Map<String, Value>,
}

impl ProviderRuntimeEvent {
    pub fn new(event_type: ProviderRuntimeEventType, provider: &str, session_id: &str) -> Self {
        Self {
            event_type,
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            event_id: format!("provider-event-{}", uuid::Uuid::new_v4()),
            created_at: chrono::Utc::now().to_rfc3339(),
            thread_id: None,
            turn_id: None,
            item_id: None,
            native_type: None,
            raw: None,
            payload: Map::new(),
        }
    }

    pub fn with_thread_id(mut self, thread_id: impl Into<String>) -> Self {
        let thread_id = thread_id.into();
        if !thread_id.trim().is_empty() {
            self.thread_id = Some(thread_id);
        }
        self
    }

    pub fn with_item_id(mut self, item_id: impl Into<String>) -> Self {
        let item_id = item_id.into();
        if !item_id.trim().is_empty() {
            self.item_id = Some(item_id);
        }
        self
    }

    pub fn with_native_type(mut self, native_type: impl Into<String>) -> Self {
        let native_type = native_type.into();
        if !native_type.trim().is_empty() {
            self.native_type = Some(native_type);
        }
        self
    }

    pub fn with_payload(mut self, key: &str, value: Value) -> Self {
        self.payload.insert(key.to_string(), value);
        self
    }

    pub fn into_value(self) -> Value {
        match serde_json::to_value(self) {
            Ok(value) => value,
            Err(e) => serde_json::json!({
                "type": "provider.error",
                "provider": "unknown",
                "sessionId": "unknown",
                "eventId": format!("provider-event-{}", uuid::Uuid::new_v4()),
                "createdAt": chrono::Utc::now().to_rfc3339(),
                "phase": "error",
                "message": format!("Failed to serialize provider runtime event: {e}"),
            }),
        }
    }
}

pub mod experimental {
    //! Experimental t3code-style event matrix.
    //!
    //! These types are kept as a reference while Terminal 64 evaluates whether
    //! it ever needs a Rust-side version of the full upstream event schema.
    //! They are intentionally not re-exported from `crate::providers` and new
    //! adapters should not emit them. Emit [`super::ProviderRuntimeEvent`]
    //! instead.

    #![allow(dead_code)]

    use serde::{Deserialize, Serialize};

    use crate::providers::traits::ProviderKind;

    /// Shared envelope flattened into every [`ProviderEvent`] variant.
    ///
    /// Mirrors `ProviderRuntimeEventBase.pipe(Schema.extend(...))` in
    /// providerRuntime.ts:228+. The mandatory four (`eventId`, `provider`,
    /// `threadId`, `createdAt`) are present on every variant; the optional
    /// fields are contextual references that the contract attaches to specific
    /// variant subsets (turn-scoped events carry `turnId`, item-scoped events
    /// carry `itemId`, etc.).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ProviderEventBase {
        #[serde(rename = "eventId")]
        pub event_id: String,
        pub provider: ProviderKind,
        #[serde(rename = "threadId")]
        pub thread_id: String,
        #[serde(rename = "createdAt")]
        pub created_at: String,

        #[serde(rename = "turnId", default, skip_serializing_if = "Option::is_none")]
        pub turn_id: Option<String>,
        #[serde(rename = "itemId", default, skip_serializing_if = "Option::is_none")]
        pub item_id: Option<String>,
        #[serde(rename = "requestId", default, skip_serializing_if = "Option::is_none")]
        pub request_id: Option<String>,
        #[serde(
            rename = "providerRefs",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        pub provider_refs: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub raw: Option<serde_json::Value>,
    }

    /// 1:1 with the full t3code provider event matrix.
    ///
    /// The live Terminal 64 backend contract is [`super::ProviderRuntimeEvent`].
    /// This enum is experimental/reference-only and exists to preserve the mapped
    /// upstream event names without making them an adapter contract. Per-variant
    /// payload fields land in `payload: serde_json::Value` via `#[serde(flatten)]`.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(tag = "type")]
    pub enum ProviderEvent {
        // --- session.* ---
        #[serde(rename = "session.started")]
        SessionStarted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "session.configured")]
        SessionConfigured {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "session.state.changed")]
        SessionStateChanged {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "session.exited")]
        SessionExited {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },

        // --- thread.* ---
        #[serde(rename = "thread.started")]
        ThreadStarted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "thread.state.changed")]
        ThreadStateChanged {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "thread.metadata.updated")]
        ThreadMetadataUpdated {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "thread.token-usage.updated")]
        ThreadTokenUsageUpdated {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "thread.realtime.started")]
        ThreadRealtimeStarted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "thread.realtime.item-added")]
        ThreadRealtimeItemAdded {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "thread.realtime.audio.delta")]
        ThreadRealtimeAudioDelta {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "thread.realtime.error")]
        ThreadRealtimeError {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "thread.realtime.closed")]
        ThreadRealtimeClosed {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },

        // --- turn.* ---
        #[serde(rename = "turn.started")]
        TurnStarted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "turn.completed")]
        TurnCompleted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "turn.aborted")]
        TurnAborted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "turn.plan.updated")]
        TurnPlanUpdated {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "turn.proposed.delta")]
        TurnProposedDelta {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "turn.proposed.completed")]
        TurnProposedCompleted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "turn.diff.updated")]
        TurnDiffUpdated {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },

        // --- item.* / content.delta ---
        #[serde(rename = "item.started")]
        ItemStarted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "item.updated")]
        ItemUpdated {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "item.completed")]
        ItemCompleted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "content.delta")]
        ContentDelta {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },

        // --- request.* / user-input.* ---
        #[serde(rename = "request.opened")]
        RequestOpened {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "request.resolved")]
        RequestResolved {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "user-input.requested")]
        UserInputRequested {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "user-input.resolved")]
        UserInputResolved {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },

        // --- task.* ---
        #[serde(rename = "task.started")]
        TaskStarted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "task.progress")]
        TaskProgress {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "task.completed")]
        TaskCompleted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },

        // --- hook.* ---
        #[serde(rename = "hook.started")]
        HookStarted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "hook.progress")]
        HookProgress {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "hook.completed")]
        HookCompleted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },

        // --- tool.* ---
        #[serde(rename = "tool.progress")]
        ToolProgress {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "tool.summary")]
        ToolSummary {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },

        // --- auth / account / mcp / model / config / deprecation / files / runtime ---
        #[serde(rename = "auth.status")]
        AuthStatus {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "account.updated")]
        AccountUpdated {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "account.rate-limits.updated")]
        AccountRateLimitsUpdated {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "mcp.status.updated")]
        McpStatusUpdated {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "mcp.oauth.completed")]
        McpOauthCompleted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "model.rerouted")]
        ModelRerouted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "config.warning")]
        ConfigWarning {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "deprecation.notice")]
        DeprecationNotice {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "files.persisted")]
        FilesPersisted {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "runtime.warning")]
        RuntimeWarning {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
        #[serde(rename = "runtime.error")]
        RuntimeError {
            #[serde(flatten)]
            base: ProviderEventBase,
            #[serde(flatten)]
            payload: serde_json::Value,
        },
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::providers::events::experimental::{ProviderEvent, ProviderEventBase};
    use crate::providers::traits::ProviderKind;

    fn base(provider: ProviderKind) -> ProviderEventBase {
        ProviderEventBase {
            event_id: "event-1".to_string(),
            provider,
            thread_id: "thread-1".to_string(),
            created_at: "2026-04-28T00:00:00Z".to_string(),
            turn_id: Some("turn-1".to_string()),
            item_id: None,
            request_id: None,
            provider_refs: Some(json!({ "nativeId": "provider-event-1" })),
            raw: None,
        }
    }

    #[test]
    fn experimental_provider_event_serializes_t3code_type_and_flattened_base() {
        let event = ProviderEvent::TurnCompleted {
            base: base(ProviderKind::Codex),
            payload: json!({
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 4,
                    "total_tokens": 16
                }
            }),
        };

        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "turn.completed");
        assert_eq!(value["provider"], "codex");
        assert_eq!(value["eventId"], "event-1");
        assert_eq!(value["threadId"], "thread-1");
        assert_eq!(value["turnId"], "turn-1");
        assert_eq!(value["providerRefs"]["nativeId"], "provider-event-1");
        assert_eq!(value["usage"]["total_tokens"], 16);
    }

    #[test]
    fn provider_runtime_event_serializes_terminal64_envelope() {
        let event = ProviderRuntimeEvent::new(ProviderRuntimeEventType::Tool, "cursor", "t64-1")
            .with_item_id("tool-1")
            .with_native_type("tool_call:started")
            .with_payload("phase", json!("started"))
            .with_payload("id", json!("tool-1"))
            .with_payload("name", json!("terminal-64-StartDelegation"));

        let value = event.into_value();
        assert_eq!(value["type"], "provider.tool");
        assert_eq!(value["provider"], "cursor");
        assert_eq!(value["sessionId"], "t64-1");
        assert_eq!(value["itemId"], "tool-1");
        assert_eq!(value["nativeType"], "tool_call:started");
        assert_eq!(value["phase"], "started");
        assert_eq!(value["name"], "terminal-64-StartDelegation");
    }

    #[test]
    fn provider_runtime_event_serializes_session_scoped_registered_provider_names() {
        for provider in ["anthropic", "openai", "cursor"] {
            let session_id = format!("{provider}-session");
            let text = format!("{provider} text");
            let event =
                ProviderRuntimeEvent::new(ProviderRuntimeEventType::Content, provider, &session_id)
                    .with_payload("phase", json!("delta"))
                    .with_payload("text", json!(text));

            let value = event.into_value();
            assert_eq!(value["type"], "provider.content");
            assert_eq!(value["provider"], provider);
            assert_eq!(value["sessionId"], session_id.as_str());
            assert_eq!(value["phase"], "delta");
            assert_eq!(value["text"], text.as_str());
        }
    }

    #[test]
    fn experimental_provider_event_deserializes_request_event_without_provider_specific_shape() {
        let value = json!({
            "type": "request.opened",
            "eventId": "event-2",
            "provider": "claudeAgent",
            "threadId": "thread-2",
            "createdAt": "2026-04-28T00:00:01Z",
            "requestId": "request-1",
            "tool": "Edit",
            "raw": { "providerSpecific": true }
        });

        let event: ProviderEvent = serde_json::from_value(value).unwrap();
        match event {
            ProviderEvent::RequestOpened { base, payload } => {
                assert_eq!(base.provider, ProviderKind::ClaudeAgent);
                assert_eq!(base.request_id.as_deref(), Some("request-1"));
                assert_eq!(base.raw, Some(json!({ "providerSpecific": true })));
                assert_eq!(payload["tool"], "Edit");
            }
            other => panic!("expected request.opened, got {other:?}"),
        }
    }
}
