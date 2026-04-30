//! Provider adapter abstraction.
//!
//! Each concrete CLI backend (Claude Agent CLI, Codex app-server, Cursor
//! Agent, …) implements [`ProviderAdapter`] so call sites in `lib.rs` stay
//! provider-agnostic.

// Re-export the live Terminal 64 event envelope for provider adapters.
// The larger t3code reference matrix stays under providers::events::experimental.
#![allow(unused_imports)]

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod events;
pub mod registry;
pub mod snapshots;
pub mod traits;
pub mod util;

use tauri::{AppHandle, Emitter};

use crate::types::ProviderEventEnvelope;

pub use claude::ClaudeAdapter;
pub use codex::CodexAdapter;
pub use cursor::CursorAdapter;
pub use events::{ProviderRuntimeEvent, ProviderRuntimeEventType};
pub use registry::ProviderRegistry;
pub use traits::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderAdapterError, ProviderCommandContext,
    ProviderCommandLifecycle, ProviderCommandRequest, ProviderCreateSessionRequest,
    ProviderHistoryCapabilities, ProviderKind, ProviderOpenWolfOptions, ProviderPreparedCommand,
    ProviderSendPromptRequest, ProviderSessionModelSwitchMode,
};

pub(crate) fn emit_provider_event(
    app_handle: &AppHandle,
    provider: &str,
    session_id: &str,
    data: &str,
) {
    if let Err(e) = app_handle.emit(
        "provider-event",
        ProviderEventEnvelope {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            data: data.to_string(),
            event: None,
        },
    ) {
        safe_eprintln!(
            "[provider] Failed to emit provider-event for {} {}: {}",
            provider,
            session_id,
            e
        );
    }
}

pub(crate) fn emit_provider_runtime_event(app_handle: &AppHandle, event: ProviderRuntimeEvent) {
    let provider = event.provider.clone();
    let session_id = event.session_id.clone();
    let data = crate::providers::util::cap_event_size(event.into_value().to_string());
    let event_payload = serde_json::from_str::<serde_json::Value>(&data).ok();
    if let Err(e) = app_handle.emit(
        "provider-event",
        ProviderEventEnvelope {
            provider: provider.clone(),
            session_id: session_id.clone(),
            data,
            event: event_payload,
        },
    ) {
        safe_eprintln!(
            "[provider] Failed to emit provider-event for {} {}: {}",
            provider,
            session_id,
            e
        );
    }
}
