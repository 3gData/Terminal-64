//! Provider adapter abstraction.
//!
//! Each concrete CLI backend (Claude Agent CLI, Codex app-server, Cursor
//! Agent, …) implements [`ProviderAdapter`] so call sites in `lib.rs` stay
//! provider-agnostic.

// Event types are exported ahead of full Rust-side event-stream consumers.
#![allow(unused_imports)]

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod events;
pub mod registry;
pub mod traits;
pub mod util;

use tauri::{AppHandle, Emitter};

use crate::types::ProviderEventEnvelope;

pub use claude::ClaudeAdapter;
pub use codex::CodexAdapter;
pub use cursor::CursorAdapter;
pub use events::{ProviderEvent, ProviderEventBase};
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
