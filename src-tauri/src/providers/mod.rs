//! Provider adapter abstraction.
//!
//! Port of t3code's `ProviderAdapterShape` (see
//! `apps/server/src/provider/Services/ProviderAdapter.ts`). Each concrete
//! CLI backend (Claude Agent CLI, Codex app-server, …) implements
//! [`ProviderAdapter`] so call sites in `lib.rs` stay provider-agnostic.

// Step 1 ports the Claude side only; Codex / Cursor / OpenCode adapters
// land later. The infra types and re-exports below are part of the public
// surface those adapters will consume — silencing the unused warnings now
// keeps the scaffolding intact without polluting CI output.
#![allow(unused_imports)]

pub mod claude;
pub mod events;
pub mod registry;
pub mod traits;
pub mod util;

pub use claude::ClaudeAdapter;
pub use events::{ProviderEvent, ProviderEventBase};
pub use registry::ProviderRegistry;
pub use traits::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderAdapterError, ProviderApprovalDecision,
    ProviderKind, ProviderSendTurnInput, ProviderSession, ProviderSessionModelSwitchMode,
    ProviderSessionStartInput, ProviderThreadSnapshot, ProviderThreadTurnSnapshot,
    ProviderTurnStartResult, ProviderUserInputAnswers,
};
