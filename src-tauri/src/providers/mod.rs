//! Provider adapter abstraction.
//!
//! Port of t3code's `ProviderAdapterShape` (see
//! `apps/server/src/provider/Services/ProviderAdapter.ts`). Each concrete
//! CLI backend (Claude Agent CLI, Codex app-server, …) implements
//! [`ProviderAdapter`] so call sites in `lib.rs` stay provider-agnostic.

// Claude and Codex both implement the current command adapter surface. The
// broader infra types and re-exports below are part of the public surface
// future adapters will consume, so silence unused warnings at the module
// boundary instead of sprinkling per-item allowances.
#![allow(unused_imports)]

pub mod claude;
pub mod codex;
pub mod events;
pub mod registry;
pub mod traits;
pub mod util;

use tauri::{AppHandle, Emitter};

use crate::types::ProviderEventEnvelope;

pub use claude::ClaudeAdapter;
pub use codex::CodexAdapter;
pub use events::{ProviderEvent, ProviderEventBase};
pub use registry::ProviderRegistry;
pub use traits::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderAdapterError, ProviderApprovalDecision,
    ProviderCommandAdapter, ProviderCommandContext, ProviderCommandRequest,
    ProviderCreateSessionRequest, ProviderHistoryCapabilities, ProviderKind,
    ProviderSendPromptRequest, ProviderSendTurnInput, ProviderSession,
    ProviderSessionModelSwitchMode, ProviderSessionStartInput, ProviderThreadSnapshot,
    ProviderThreadTurnSnapshot, ProviderTurnStartResult, ProviderUserInputAnswers,
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
