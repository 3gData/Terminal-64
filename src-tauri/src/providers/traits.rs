//! Backend provider adapter contract.
//!
//! The current Tauri surface is a synchronous command bridge: generic
//! `provider_*` IPC handlers resolve a provider id and hand the raw
//! provider-owned JSON payload to the selected adapter. Provider-specific
//! command setup lives in adapter-owned preparation hooks, while history
//! operations use the same registry boundary and are gated by explicit
//! capabilities. This file intentionally models that supported surface instead
//! of carrying unused async lifecycle stubs from the upstream t3code shape.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::permission_server::PermissionServer;

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

pub type ProviderHistoryRequest = serde_json::Value;
pub type ProviderHistoryResponse = serde_json::Value;

pub fn provider_history_unsupported_response(
    kind: ProviderKind,
    operation: &str,
) -> ProviderHistoryResponse {
    serde_json::json!({
        "status": "unsupported",
        "method": "unsupported",
        "messages": [],
        "stat": null,
        "reason": format!("Provider {:?} does not support history {}", kind, operation),
    })
}

/// Sidecar data produced by provider-owned command preparation. Concrete
/// adapters decide which fields, if any, apply to their payload.
#[derive(Debug, Clone, Default)]
pub struct ProviderCommandContext {
    pub settings_path: Option<String>,
    pub approver_mcp_config: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ProviderOpenWolfOptions {
    pub enabled: bool,
    pub auto_init: bool,
    pub design_qc: bool,
}

pub struct ProviderCommandLifecycle<'a> {
    pub app_handle: &'a AppHandle,
    pub permission_server: &'a PermissionServer,
    pub openwolf: ProviderOpenWolfOptions,
}

#[derive(Debug, Clone)]
pub struct ProviderPreparedCommand {
    pub request: ProviderCommandRequest,
    pub cleanup_tokens: Vec<String>,
}

impl ProviderPreparedCommand {
    pub fn new(request: ProviderCommandRequest) -> Self {
        Self {
            request,
            cleanup_tokens: Vec::new(),
        }
    }
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

/// Common backend surface implemented by every registered provider adapter.
///
/// Provider-specific create/send fields stay inside the raw JSON payload.
/// Shared setup, such as Claude permission settings or MCP config paths, is
/// passed through [`ProviderCommandContext`] so registry callers do not need to
/// know each provider's request schema.
pub trait ProviderAdapter: Send + Sync {
    fn provider(&self) -> ProviderKind;

    fn capabilities(&self) -> &ProviderAdapterCapabilities;

    fn prepare_create_session(
        &self,
        _lifecycle: &ProviderCommandLifecycle<'_>,
        req: ProviderCreateSessionRequest,
    ) -> Result<ProviderPreparedCommand, ProviderAdapterError> {
        Ok(ProviderPreparedCommand::new(req))
    }

    fn prepare_send_prompt(
        &self,
        _lifecycle: &ProviderCommandLifecycle<'_>,
        req: ProviderSendPromptRequest,
    ) -> Result<ProviderPreparedCommand, ProviderAdapterError> {
        Ok(ProviderPreparedCommand::new(req))
    }

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

    fn history_truncate(
        &self,
        _req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        Ok(provider_history_unsupported_response(
            self.provider(),
            "rewind",
        ))
    }

    fn history_fork(
        &self,
        _req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        Ok(provider_history_unsupported_response(
            self.provider(),
            "fork",
        ))
    }

    fn history_hydrate(
        &self,
        _req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        Ok(provider_history_unsupported_response(
            self.provider(),
            "hydrate",
        ))
    }

    fn history_delete(
        &self,
        _req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        Ok(provider_history_unsupported_response(
            self.provider(),
            "delete",
        ))
    }
}
