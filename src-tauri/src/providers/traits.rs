// The synchronous command adapter is live for Claude and Codex. The broader
// async provider trait remains ahead of the current UI surface, so keep the
// unused contract pieces available without per-item allowances.
#![allow(dead_code)]

//! `ProviderAdapter` trait — Rust port of
//! `ProviderAdapterShape<TError>` from
//! `apps/server/src/provider/Services/ProviderAdapter.ts` (t3code).
//!
//! Translations:
//! - `Effect.Effect<T, E>`                → `async fn(..) -> Result<T, ProviderAdapterError>`
//! - `Stream.Stream<ProviderRuntimeEvent>` → `tokio::sync::mpsc::Receiver<ProviderEvent>`
//! - `ReadonlyArray<T>`                    → `Vec<T>`
//! - Branded `ThreadId`/`TurnId`/`ApprovalRequestId` → `String` at the Tauri boundary.
//!
//! The trait is `Send + Sync` and lives behind `Arc<dyn ProviderAdapter>`
//! in `AppState`, matching the registry-owned adapter pattern.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::providers::events::ProviderEvent;

/// Error type surfaced by every adapter method. The live command adapters
/// still surface user-facing strings; the normalized async surface can grow a
/// structured enum when the UI starts consuming typed provider errors.
pub type ProviderAdapterError = String;

/// Discriminator for registered adapters. Matches `ProviderKind` in
/// `packages/contracts/src/provider.ts` (t3code).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    ClaudeAgent,
    Codex,
    Cursor,
    OpenCode,
}

/// Matches `ProviderSessionModelSwitchMode` in ProviderAdapter.ts:19.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderSessionModelSwitchMode {
    InSession,
    Unsupported,
}

/// Matches `ProviderAdapterCapabilities` in ProviderAdapter.ts:23–27.
#[derive(Debug, Clone)]
pub struct ProviderAdapterCapabilities {
    pub session_model_switch: ProviderSessionModelSwitchMode,
    pub history: ProviderHistoryCapabilities,
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderHistoryCapabilities {
    pub hydrate: bool,
    pub fork: bool,
    pub rewind: bool,
    pub delete: bool,
}

impl ProviderHistoryCapabilities {
    pub const NONE: Self = Self {
        hydrate: false,
        fork: false,
        rewind: false,
        delete: false,
    };

    pub const FULL: Self = Self {
        hydrate: true,
        fork: true,
        rewind: true,
        delete: true,
    };
}

// Future normalized payloads can replace these `serde_json::Value` aliases
// once the full async provider adapter surface is wired end to end.
pub type ProviderSessionStartInput = serde_json::Value;
pub type ProviderSendTurnInput = serde_json::Value;
pub type ProviderApprovalDecision = serde_json::Value;
pub type ProviderUserInputAnswers = serde_json::Value;
pub type ProviderSession = serde_json::Value;
pub type ProviderTurnStartResult = serde_json::Value;

/// Sidecar data produced by provider-agnostic command setup. Concrete
/// adapters decide which fields, if any, apply to their payload.
#[derive(Debug, Clone, Default)]
pub struct ProviderCommandContext {
    pub settings_path: Option<String>,
    pub approver_mcp_config: Option<String>,
}

/// Existing Tauri IPC command payload grouped behind one backend provider
/// command boundary. The raw JSON payload belongs to the selected provider
/// adapter, avoiding central enums that grow every time a provider adds a
/// field.
#[derive(Debug, Clone)]
pub struct ProviderCommandRequest {
    pub payload: serde_json::Value,
    pub context: ProviderCommandContext,
}

impl ProviderCommandRequest {
    pub fn new(payload: serde_json::Value, context: ProviderCommandContext) -> Self {
        Self { payload, context }
    }
}

pub type ProviderCreateSessionRequest = ProviderCommandRequest;
pub type ProviderSendPromptRequest = ProviderCommandRequest;

/// Synchronous command surface used by the current Tauri IPC wrappers. This
/// is intentionally smaller than the future normalized `ProviderAdapter`
/// contract below: it only covers the common Claude/Codex lifecycle commands
/// that already exist today.
pub trait ProviderCommandAdapter: Send + Sync {
    fn create_session(
        &self,
        app_handle: &AppHandle,
        req: ProviderCreateSessionRequest,
    ) -> Result<String, ProviderAdapterError>;

    fn send_prompt(
        &self,
        app_handle: &AppHandle,
        req: ProviderSendPromptRequest,
    ) -> Result<(), ProviderAdapterError>;

    fn cancel_session(&self, session_id: &str) -> Result<(), ProviderAdapterError>;

    fn close_session(&self, session_id: &str) -> Result<(), ProviderAdapterError>;
}

/// Matches `ProviderThreadTurnSnapshot` in ProviderAdapter.ts — one turn
/// inside a thread snapshot returned by [`ProviderAdapter::read_thread`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderThreadTurnSnapshot {
    #[serde(rename = "turnId")]
    pub turn_id: String,
    pub items: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Matches `ProviderThreadSnapshot` in ProviderAdapter.ts — the full
/// canonicalised thread state, used for rewind/fork and session resume.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderThreadSnapshot {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub provider: ProviderKind,
    pub turns: Vec<ProviderThreadTurnSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Provider-agnostic CLI adapter.
///
/// Method list (12) matches the t3code contract exactly:
/// `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`,
/// `respondToUserInput`, `stopSession`, `listSessions`, `hasSession`,
/// `readThread`, `rollbackThread`, `stopAll`, `streamEvents`.
#[async_trait]
pub trait ProviderAdapter: ProviderCommandAdapter + Send + Sync {
    /// `provider` discriminator — ProviderAdapter.ts:48.
    fn provider(&self) -> ProviderKind;

    /// `capabilities` — ProviderAdapter.ts:49.
    fn capabilities(&self) -> &ProviderAdapterCapabilities;

    /// Start a provider-backed session. ProviderAdapter.ts:54–57.
    async fn start_session(
        &self,
        input: ProviderSessionStartInput,
    ) -> Result<ProviderSession, ProviderAdapterError>;

    /// Send a turn to an active provider session. ProviderAdapter.ts:62–64.
    async fn send_turn(
        &self,
        input: ProviderSendTurnInput,
    ) -> Result<ProviderTurnStartResult, ProviderAdapterError>;

    /// Interrupt an active turn. ProviderAdapter.ts:69.
    async fn interrupt_turn(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
    ) -> Result<(), ProviderAdapterError>;

    /// Respond to a permission/approval request. ProviderAdapter.ts:74–78.
    async fn respond_to_request(
        &self,
        thread_id: &str,
        request_id: &str,
        decision: ProviderApprovalDecision,
    ) -> Result<(), ProviderAdapterError>;

    /// Respond to a structured user-input request. ProviderAdapter.ts:83–87.
    async fn respond_to_user_input(
        &self,
        thread_id: &str,
        request_id: &str,
        answers: ProviderUserInputAnswers,
    ) -> Result<(), ProviderAdapterError>;

    /// Stop one provider session. ProviderAdapter.ts:92.
    async fn stop_session(&self, thread_id: &str) -> Result<(), ProviderAdapterError>;

    /// List active sessions owned by this adapter. ProviderAdapter.ts:97.
    async fn list_sessions(&self) -> Vec<ProviderSession>;

    /// Does this adapter own `thread_id`? ProviderAdapter.ts:102.
    async fn has_session(&self, thread_id: &str) -> bool;

    /// Read a provider thread snapshot. ProviderAdapter.ts:107.
    async fn read_thread(
        &self,
        thread_id: &str,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError>;

    /// Roll back a provider thread by N turns. ProviderAdapter.ts:112–115.
    async fn rollback_thread(
        &self,
        thread_id: &str,
        num_turns: u32,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError>;

    /// Stop every session this adapter owns. ProviderAdapter.ts:120.
    async fn stop_all(&self) -> Result<(), ProviderAdapterError>;

    /// Subscribe to the adapter's event stream.
    ///
    /// Returns a fresh `mpsc::Receiver<ProviderEvent>` that the caller owns.
    /// Implementations should wire this to the same channel that carries
    /// events emitted by `start_session` / `send_turn`; callers forward the
    /// stream to Tauri via `emit("provider-event", …)`.
    async fn stream_events(&self) -> mpsc::Receiver<ProviderEvent>;
}
