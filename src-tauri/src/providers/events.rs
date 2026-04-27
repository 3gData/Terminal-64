// The frontend still consumes provider-specific legacy event topics; the
// typed `ProviderEvent` enum is kept ahead of the consumer so adapters can
// target it as soon as the normalized Rust stream is wired. Allow dead code
// until that wiring lands.
#![allow(dead_code)]

//! `ProviderEvent` — Rust port of the `ProviderRuntimeEvent` discriminated
//! union from `packages/contracts/src/providerRuntime.ts` (t3code).
//!
//! The tag strings match `ProviderRuntimeEventType` (providerRuntime.ts:135–184)
//! verbatim so the frontend decodes events without a translation layer.
//! Per-variant payloads stay `serde_json::Value` while the command-adapter
//! path remains the live IPC surface. The source contract has 600+ lines of
//! per-variant schemas, so the typed payloads can be bound when consumers need
//! the normalized Rust stream directly.

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

/// 1:1 with `ProviderRuntimeEventType` in
/// `packages/contracts/src/providerRuntime.ts:135–184`.
///
/// The `type` tag uses the exact kebab/dotted strings from the TS union so
/// the frontend decodes without a translation layer. Per-variant payload
/// fields land in `payload: serde_json::Value` via `#[serde(flatten)]`;
/// A later pass may promote hot variants to typed payloads.
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
