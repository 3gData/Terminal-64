// The registry already owns Claude and Codex command dispatch. Some typed
// lookup helpers are kept ahead of deeper provider-adapter migration work.
#![allow(dead_code)]

//! Provider registry — thin wrapper around a
//! `HashMap<ProviderKind, Arc<dyn ProviderAdapter>>`.
//!
//! Replaces direct manager fields on `AppState` for common lifecycle
//! commands. Call sites dispatch by `ProviderKind` instead of hard-coding a
//! concrete manager, so new CLI providers can register an adapter instead of
//! rewriting every command path.

use std::collections::HashMap;
use std::sync::Arc;

use tauri::AppHandle;

use crate::providers::traits::{
    provider_history_unsupported_response, ProviderAdapter, ProviderAdapterError,
    ProviderCommandLifecycle, ProviderCreateSessionRequest, ProviderHistoryCapabilities,
    ProviderHistoryRequest, ProviderHistoryResponse, ProviderKind, ProviderPreparedCommand,
    ProviderSendPromptRequest,
};
use crate::types::ProviderSnapshot;

pub struct ProviderRegistry {
    adapters: HashMap<ProviderKind, Arc<dyn ProviderAdapter>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            adapters: HashMap::new(),
        }
    }

    /// Register an adapter under its `ProviderKind`. Later registrations for
    /// the same kind replace the earlier one.
    pub fn register(&mut self, kind: ProviderKind, adapter: Arc<dyn ProviderAdapter>) {
        assert_eq!(
            kind,
            adapter.provider(),
            "provider registry key must match adapter provider"
        );
        // Keep the full capability shape live; adding a capability field should
        // force registry-level consideration instead of becoming silent dead code.
        let _registered_capabilities = *adapter.capabilities();
        self.adapters.insert(kind, adapter);
    }

    /// Look up an adapter by kind.
    pub fn get(&self, kind: ProviderKind) -> Option<Arc<dyn ProviderAdapter>> {
        self.adapters.get(&kind).cloned()
    }

    fn require(
        &self,
        kind: ProviderKind,
    ) -> Result<Arc<dyn ProviderAdapter>, ProviderAdapterError> {
        self.get(kind)
            .ok_or_else(|| format!("No provider adapter registered for {:?}", kind))
    }

    /// Dispatch today's create-session IPC command through the registered
    /// provider adapter without changing the public Tauri command contract.
    pub fn prepare_create_session(
        &self,
        kind: ProviderKind,
        lifecycle: &ProviderCommandLifecycle<'_>,
        req: ProviderCreateSessionRequest,
    ) -> Result<ProviderPreparedCommand, ProviderAdapterError> {
        self.require(kind)?.prepare_create_session(lifecycle, req)
    }

    pub fn create_session(
        &self,
        kind: ProviderKind,
        app_handle: &AppHandle,
        req: ProviderCreateSessionRequest,
    ) -> Result<String, ProviderAdapterError> {
        self.require(kind)?.create_session(app_handle, req)
    }

    /// Dispatch today's send-prompt IPC command through the registered
    /// provider adapter without changing the public Tauri command contract.
    pub fn prepare_send_prompt(
        &self,
        kind: ProviderKind,
        lifecycle: &ProviderCommandLifecycle<'_>,
        req: ProviderSendPromptRequest,
    ) -> Result<ProviderPreparedCommand, ProviderAdapterError> {
        self.require(kind)?.prepare_send_prompt(lifecycle, req)
    }

    pub fn send_prompt(
        &self,
        kind: ProviderKind,
        app_handle: &AppHandle,
        req: ProviderSendPromptRequest,
    ) -> Result<(), ProviderAdapterError> {
        self.require(kind)?.send_prompt(app_handle, req)
    }

    pub fn cancel_session(
        &self,
        kind: ProviderKind,
        session_id: &str,
    ) -> Result<(), ProviderAdapterError> {
        self.require(kind)?.cancel_session(session_id)
    }

    pub fn close_session(
        &self,
        kind: ProviderKind,
        session_id: &str,
    ) -> Result<(), ProviderAdapterError> {
        self.require(kind)?.close_session(session_id)
    }

    pub fn history_capabilities(&self, kind: ProviderKind) -> ProviderHistoryCapabilities {
        self.get(kind)
            .map(|adapter| adapter.capabilities().history)
            .unwrap_or(ProviderHistoryCapabilities::NONE)
    }

    pub fn snapshots(&self) -> Vec<ProviderSnapshot> {
        let ordered = [
            ProviderKind::ClaudeAgent,
            ProviderKind::Codex,
            ProviderKind::Cursor,
            ProviderKind::OpenCode,
        ];
        let mut snapshots = Vec::new();
        for kind in ordered {
            if let Some(adapter) = self.get(kind) {
                snapshots.push(adapter.snapshot());
            }
        }
        for (kind, adapter) in self.iter() {
            if !ordered.contains(kind) {
                snapshots.push(adapter.snapshot());
            }
        }
        snapshots
    }

    fn history_adapter_or_unsupported(
        &self,
        kind: ProviderKind,
        operation: &str,
        supports: impl Fn(ProviderHistoryCapabilities) -> bool,
    ) -> Result<Arc<dyn ProviderAdapter>, ProviderHistoryResponse> {
        let Some(adapter) = self.get(kind) else {
            return Err(provider_history_unsupported_response(kind, operation));
        };
        if supports(adapter.capabilities().history) {
            Ok(adapter)
        } else {
            Err(provider_history_unsupported_response(kind, operation))
        }
    }

    pub fn history_truncate(
        &self,
        kind: ProviderKind,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        match self.history_adapter_or_unsupported(kind, "rewind", |history| history.rewind) {
            Ok(adapter) => adapter.history_truncate(req),
            Err(response) => Ok(response),
        }
    }

    pub fn history_fork(
        &self,
        kind: ProviderKind,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        match self.history_adapter_or_unsupported(kind, "fork", |history| history.fork) {
            Ok(adapter) => adapter.history_fork(req),
            Err(response) => Ok(response),
        }
    }

    pub fn history_hydrate(
        &self,
        kind: ProviderKind,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        match self.history_adapter_or_unsupported(kind, "hydrate", |history| history.hydrate) {
            Ok(adapter) => adapter.history_hydrate(req),
            Err(response) => Ok(response),
        }
    }

    pub fn history_delete(
        &self,
        kind: ProviderKind,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        match self.history_adapter_or_unsupported(kind, "delete", |history| history.delete) {
            Ok(adapter) => adapter.history_delete(req),
            Err(response) => Ok(response),
        }
    }

    /// Typed accessor for the Claude adapter.
    pub fn claude(&self) -> Option<Arc<dyn ProviderAdapter>> {
        self.get(ProviderKind::ClaudeAgent)
    }

    /// Typed accessor for the Codex adapter.
    pub fn codex(&self) -> Option<Arc<dyn ProviderAdapter>> {
        self.get(ProviderKind::Codex)
    }

    /// Snapshot of every registered adapter. Callers receive owned clones of
    /// the `Arc`s so they can drive them without holding a borrow on the
    /// registry.
    pub fn all(&self) -> Vec<Arc<dyn ProviderAdapter>> {
        self.adapters.values().cloned().collect()
    }

    /// Iterate `(kind, adapter)` pairs without cloning values.
    pub fn iter(&self) -> impl Iterator<Item = (&ProviderKind, &Arc<dyn ProviderAdapter>)> {
        self.adapters.iter()
    }

    /// Owned `ProviderKind`s currently registered.
    pub fn kinds(&self) -> Vec<ProviderKind> {
        self.adapters.keys().copied().collect()
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::providers::traits::{ProviderAdapterCapabilities, ProviderSessionModelSwitchMode};
    use crate::providers::{ClaudeAdapter, CodexAdapter, CursorAdapter};

    struct MockAdapter {
        kind: ProviderKind,
        capabilities: ProviderAdapterCapabilities,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl MockAdapter {
        fn new(
            kind: ProviderKind,
            history: ProviderHistoryCapabilities,
            calls: Arc<Mutex<Vec<String>>>,
        ) -> Self {
            Self {
                kind,
                capabilities: ProviderAdapterCapabilities {
                    session_model_switch: ProviderSessionModelSwitchMode::InSession,
                    history,
                    mcp: false,
                    plan: false,
                    images: false,
                    hook_log: false,
                    native_slash_commands: false,
                    compact: false,
                },
                calls,
            }
        }

        fn record(&self, call: impl Into<String>) {
            self.calls.lock().unwrap().push(call.into());
        }
    }

    impl ProviderAdapter for MockAdapter {
        fn provider(&self) -> ProviderKind {
            self.kind
        }

        fn capabilities(&self) -> &ProviderAdapterCapabilities {
            &self.capabilities
        }

        fn snapshot(&self) -> ProviderSnapshot {
            let session_model_switch = match self.capabilities.session_model_switch {
                ProviderSessionModelSwitchMode::InSession => "in-session",
                ProviderSessionModelSwitchMode::Unsupported => "unsupported",
            }
            .to_string();
            ProviderSnapshot {
                id: format!("mock-{:?}", self.kind).to_ascii_lowercase(),
                display: crate::types::ProviderSnapshotDisplay {
                    label: "Mock".to_string(),
                    short_label: "Mock".to_string(),
                    brand_title: "Mock Provider".to_string(),
                    empty_state_label: "Mock".to_string(),
                    default_session_name: "Mock".to_string(),
                },
                auth: crate::types::ProviderSnapshotAuth {
                    status: "unknown".to_string(),
                    label: "Mock CLI".to_string(),
                    detail: None,
                },
                install: crate::types::ProviderSnapshotInstall {
                    status: "installed".to_string(),
                    command: "mock".to_string(),
                    path: None,
                    version: None,
                },
                status: crate::types::ProviderSnapshotStatus {
                    state: "available".to_string(),
                    message: None,
                },
                models: Vec::new(),
                options: Vec::new(),
                capabilities: crate::types::ProviderSnapshotCapabilities {
                    mcp: self.capabilities.mcp,
                    plan: self.capabilities.plan,
                    fork: self.capabilities.history.fork,
                    rewind: self.capabilities.history.rewind,
                    images: self.capabilities.images,
                    hook_log: self.capabilities.hook_log,
                    native_slash_commands: self.capabilities.native_slash_commands,
                    compact: self.capabilities.compact,
                    session_model_switch,
                    history: crate::types::ProviderSnapshotHistoryCapabilities {
                        hydrate: self.capabilities.history.hydrate,
                        fork: self.capabilities.history.fork,
                        rewind: self.capabilities.history.rewind,
                        delete: self.capabilities.history.delete,
                    },
                },
                slash_commands: Vec::new(),
            }
        }

        fn create_session(
            &self,
            _app_handle: &tauri::AppHandle,
            req: ProviderCreateSessionRequest,
        ) -> Result<String, ProviderAdapterError> {
            self.record(format!("create:{}", req.payload));
            Ok("created-session".to_string())
        }

        fn send_prompt(
            &self,
            _app_handle: &tauri::AppHandle,
            req: ProviderSendPromptRequest,
        ) -> Result<(), ProviderAdapterError> {
            self.record(format!("send:{}", req.payload));
            Ok(())
        }

        fn cancel_session(&self, session_id: &str) -> Result<(), ProviderAdapterError> {
            self.record(format!("cancel:{session_id}"));
            Ok(())
        }

        fn close_session(&self, session_id: &str) -> Result<(), ProviderAdapterError> {
            self.record(format!("close:{session_id}"));
            Ok(())
        }

        fn history_truncate(
            &self,
            req: ProviderHistoryRequest,
        ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
            self.record(format!("history-rewind:{req}"));
            Ok(json!({ "status": "applied", "method": "mock", "operation": "rewind" }))
        }

        fn history_fork(
            &self,
            req: ProviderHistoryRequest,
        ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
            self.record(format!("history-fork:{req}"));
            Ok(json!({ "status": "applied", "method": "mock", "operation": "fork" }))
        }

        fn history_hydrate(
            &self,
            req: ProviderHistoryRequest,
        ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
            self.record(format!("history-hydrate:{req}"));
            Ok(
                json!({ "status": "messages", "method": "mock", "operation": "hydrate", "messages": [] }),
            )
        }

        fn history_delete(
            &self,
            req: ProviderHistoryRequest,
        ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
            self.record(format!("history-delete:{req}"));
            Ok(json!({ "status": "applied", "method": "deleted", "operation": "delete" }))
        }
    }

    #[test]
    fn provider_history_capability_constants_are_explicit() {
        let none = ProviderHistoryCapabilities::NONE;
        assert!(!none.hydrate);
        assert!(!none.fork);
        assert!(!none.rewind);
        assert!(!none.delete);

        let full = ProviderHistoryCapabilities::FULL;
        assert!(full.hydrate);
        assert!(full.fork);
        assert!(full.rewind);
        assert!(full.delete);
    }

    fn assert_provider_adapter<T: ProviderAdapter + Send + Sync + 'static>() {}

    fn session_model_switch_label(mode: ProviderSessionModelSwitchMode) -> &'static str {
        match mode {
            ProviderSessionModelSwitchMode::InSession => "in-session",
            ProviderSessionModelSwitchMode::Unsupported => "unsupported",
        }
    }

    fn assert_snapshot_capabilities_match_adapter(adapter: &dyn ProviderAdapter) {
        let capabilities = adapter.capabilities();
        let snapshot = adapter.snapshot();

        assert_eq!(
            snapshot.capabilities.session_model_switch,
            session_model_switch_label(capabilities.session_model_switch)
        );
        assert_eq!(
            snapshot.capabilities.history.hydrate,
            capabilities.history.hydrate
        );
        assert_eq!(
            snapshot.capabilities.history.fork,
            capabilities.history.fork
        );
        assert_eq!(
            snapshot.capabilities.history.rewind,
            capabilities.history.rewind
        );
        assert_eq!(
            snapshot.capabilities.history.delete,
            capabilities.history.delete
        );
        assert_eq!(snapshot.capabilities.mcp, capabilities.mcp);
        assert_eq!(snapshot.capabilities.plan, capabilities.plan);
        assert_eq!(snapshot.capabilities.fork, capabilities.history.fork);
        assert_eq!(snapshot.capabilities.rewind, capabilities.history.rewind);
        assert_eq!(snapshot.capabilities.images, capabilities.images);
        assert_eq!(snapshot.capabilities.hook_log, capabilities.hook_log);
        assert_eq!(
            snapshot.capabilities.native_slash_commands,
            capabilities.native_slash_commands
        );
        assert_eq!(snapshot.capabilities.compact, capabilities.compact);
    }

    #[test]
    fn concrete_provider_adapters_implement_common_contract() {
        assert_provider_adapter::<ClaudeAdapter>();
        assert_provider_adapter::<CodexAdapter>();
        assert_provider_adapter::<CursorAdapter>();

        let providers: Vec<(ProviderKind, Arc<dyn ProviderAdapter>)> = vec![
            (ProviderKind::ClaudeAgent, Arc::new(ClaudeAdapter::new())),
            (ProviderKind::Codex, Arc::new(CodexAdapter::new())),
            (ProviderKind::Cursor, Arc::new(CursorAdapter::new())),
        ];

        for (expected, adapter) in providers {
            assert_eq!(adapter.provider(), expected);
            let history = adapter.capabilities().history;
            let snapshot = adapter.snapshot();
            match expected {
                ProviderKind::ClaudeAgent | ProviderKind::Codex => {
                    assert!(history.hydrate);
                    assert!(history.fork);
                    assert!(history.rewind);
                    assert!(history.delete);
                    assert!(snapshot.capabilities.history.hydrate);
                    assert!(snapshot.capabilities.history.rewind);
                }
                ProviderKind::Cursor => {
                    assert!(!history.hydrate);
                    assert!(!history.fork);
                    assert!(!history.rewind);
                    assert!(!history.delete);
                    assert_eq!(snapshot.id, "cursor");
                    assert!(!snapshot.capabilities.history.hydrate);
                    assert!(!snapshot.capabilities.history.rewind);
                }
                ProviderKind::OpenCode => unreachable!("OpenCode has no adapter yet"),
            }
        }
    }

    #[test]
    fn registered_provider_snapshots_expose_adapter_owned_capabilities() {
        let mut registry = ProviderRegistry::new();
        registry.register(ProviderKind::ClaudeAgent, Arc::new(ClaudeAdapter::new()));
        registry.register(ProviderKind::Codex, Arc::new(CodexAdapter::new()));
        registry.register(ProviderKind::Cursor, Arc::new(CursorAdapter::new()));

        let snapshots = registry.snapshots();
        assert_eq!(snapshots.len(), registry.kinds().len());

        for (kind, expected_id) in [
            (ProviderKind::ClaudeAgent, "anthropic"),
            (ProviderKind::Codex, "openai"),
            (ProviderKind::Cursor, "cursor"),
        ] {
            let adapter = registry.get(kind).unwrap();
            assert_snapshot_capabilities_match_adapter(adapter.as_ref());

            let snapshot = adapter.snapshot();
            assert_eq!(snapshot.id, expected_id);
            assert!(!snapshot.options.is_empty());
            assert!(!snapshot.models.is_empty());

            let registry_snapshot = snapshots
                .iter()
                .find(|candidate| candidate.id == expected_id)
                .unwrap();
            assert_eq!(
                registry_snapshot.capabilities.history.hydrate,
                snapshot.capabilities.history.hydrate
            );
            assert_eq!(
                registry_snapshot.capabilities.history.fork,
                snapshot.capabilities.history.fork
            );
            assert_eq!(
                registry_snapshot.capabilities.history.rewind,
                snapshot.capabilities.history.rewind
            );
            assert_eq!(
                registry_snapshot.capabilities.history.delete,
                snapshot.capabilities.history.delete
            );
            assert_eq!(
                registry_snapshot.capabilities.mcp,
                snapshot.capabilities.mcp
            );
            assert_eq!(
                registry_snapshot.capabilities.session_model_switch,
                snapshot.capabilities.session_model_switch
            );
        }
    }

    #[test]
    fn registry_snapshots_include_registered_provider_descriptors() {
        let mut registry = ProviderRegistry::new();
        registry.register(ProviderKind::ClaudeAgent, Arc::new(ClaudeAdapter::new()));
        registry.register(ProviderKind::Codex, Arc::new(CodexAdapter::new()));
        registry.register(ProviderKind::Cursor, Arc::new(CursorAdapter::new()));

        let snapshots = registry.snapshots();
        let ids: Vec<_> = snapshots
            .iter()
            .map(|snapshot| snapshot.id.as_str())
            .collect();
        assert_eq!(ids, vec!["anthropic", "openai", "cursor"]);

        let anthropic = match snapshots.iter().find(|snapshot| snapshot.id == "anthropic") {
            Some(snapshot) => snapshot,
            None => panic!("anthropic snapshot missing"),
        };
        assert_eq!(anthropic.display.short_label, "Claude");
        assert!(anthropic.capabilities.history.hydrate);
        assert!(anthropic.options.iter().any(|option| {
            option.id == "model"
                && option.kind == "select"
                && option.scope == "topbar"
                && option
                    .options
                    .iter()
                    .any(|value| value.id == "sonnet" && value.default == Some(true))
        }));

        let cursor = match snapshots.iter().find(|snapshot| snapshot.id == "cursor") {
            Some(snapshot) => snapshot,
            None => panic!("cursor snapshot missing"),
        };
        assert!(!cursor.capabilities.history.hydrate);
        assert!(cursor
            .options
            .iter()
            .any(|option| option.id == "apply-mode" && option.scope == "composer"));
    }

    #[test]
    fn registry_snapshots_delegate_to_adapter_snapshot_hook() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let adapter = Arc::new(MockAdapter::new(
            ProviderKind::OpenCode,
            ProviderHistoryCapabilities {
                hydrate: true,
                fork: false,
                rewind: false,
                delete: true,
            },
            calls,
        ));
        let mut registry = ProviderRegistry::new();
        registry.register(ProviderKind::OpenCode, adapter);

        let snapshots = registry.snapshots();

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].id, "mock-opencode");
        assert!(snapshots[0].capabilities.history.hydrate);
        assert!(!snapshots[0].capabilities.history.rewind);
        assert!(snapshots[0].capabilities.history.delete);
    }

    #[test]
    #[should_panic(expected = "provider registry key must match adapter provider")]
    fn registry_rejects_mismatched_provider_key() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let adapter = Arc::new(MockAdapter::new(
            ProviderKind::Codex,
            ProviderHistoryCapabilities::NONE,
            calls,
        ));
        let mut registry = ProviderRegistry::new();
        registry.register(ProviderKind::ClaudeAgent, adapter);
    }

    #[test]
    fn registry_routes_registered_lifecycle_and_history_capabilities() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let adapter = Arc::new(MockAdapter::new(
            ProviderKind::OpenCode,
            ProviderHistoryCapabilities::FULL,
            calls.clone(),
        ));
        let mut registry = ProviderRegistry::new();
        registry.register(ProviderKind::OpenCode, adapter);

        let capabilities = registry.history_capabilities(ProviderKind::OpenCode);
        assert!(capabilities.hydrate);
        assert!(capabilities.fork);
        assert!(capabilities.rewind);
        assert!(capabilities.delete);

        registry
            .cancel_session(ProviderKind::OpenCode, "session-1")
            .unwrap();
        registry
            .close_session(ProviderKind::OpenCode, "session-1")
            .unwrap();
        let rewind = registry
            .history_truncate(ProviderKind::OpenCode, json!({ "session_id": "session-1" }))
            .unwrap();
        let fork = registry
            .history_fork(ProviderKind::OpenCode, json!({ "session_id": "session-1" }))
            .unwrap();
        let hydrate = registry
            .history_hydrate(ProviderKind::OpenCode, json!({ "session_id": "session-1" }))
            .unwrap();
        let delete = registry
            .history_delete(ProviderKind::OpenCode, json!({ "session_id": "session-1" }))
            .unwrap();

        assert_eq!(rewind["operation"], "rewind");
        assert_eq!(fork["operation"], "fork");
        assert_eq!(hydrate["operation"], "hydrate");
        assert_eq!(delete["operation"], "delete");

        let calls = calls.lock().unwrap().clone();
        assert_eq!(
            calls,
            vec![
                "cancel:session-1".to_string(),
                "close:session-1".to_string(),
                "history-rewind:{\"session_id\":\"session-1\"}".to_string(),
                "history-fork:{\"session_id\":\"session-1\"}".to_string(),
                "history-hydrate:{\"session_id\":\"session-1\"}".to_string(),
                "history-delete:{\"session_id\":\"session-1\"}".to_string(),
            ]
        );
    }

    #[test]
    fn registry_fails_closed_for_unregistered_future_provider() {
        let registry = ProviderRegistry::new();

        let capabilities = registry.history_capabilities(ProviderKind::OpenCode);
        assert!(!capabilities.hydrate);
        assert!(!capabilities.fork);
        assert!(!capabilities.rewind);
        assert!(!capabilities.delete);

        let err = match registry.require(ProviderKind::OpenCode) {
            Ok(_) => panic!("OpenCode adapter should not be registered"),
            Err(err) => err,
        };
        assert!(err.contains("No provider adapter registered for OpenCode"));

        let cancel_err = registry
            .cancel_session(ProviderKind::OpenCode, "missing")
            .unwrap_err();
        assert!(cancel_err.contains("No provider adapter registered for OpenCode"));

        let close_err = registry
            .close_session(ProviderKind::OpenCode, "missing")
            .unwrap_err();
        assert!(close_err.contains("No provider adapter registered for OpenCode"));

        let history = registry
            .history_delete(ProviderKind::OpenCode, json!({ "session_id": "missing" }))
            .unwrap();
        assert_eq!(history["status"], "unsupported");
        assert_eq!(history["method"], "unsupported");
        assert!(history["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("history delete")));
    }

    #[test]
    fn registry_history_methods_fail_closed_when_capability_disabled() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let adapter = Arc::new(MockAdapter::new(
            ProviderKind::OpenCode,
            ProviderHistoryCapabilities {
                hydrate: true,
                fork: false,
                rewind: false,
                delete: false,
            },
            calls.clone(),
        ));
        let mut registry = ProviderRegistry::new();
        registry.register(ProviderKind::OpenCode, adapter);

        let hydrate = registry
            .history_hydrate(ProviderKind::OpenCode, json!({ "session_id": "session-1" }))
            .unwrap();
        let rewind = registry
            .history_truncate(ProviderKind::OpenCode, json!({ "session_id": "session-1" }))
            .unwrap();
        let fork = registry
            .history_fork(ProviderKind::OpenCode, json!({ "session_id": "session-1" }))
            .unwrap();
        let delete = registry
            .history_delete(ProviderKind::OpenCode, json!({ "session_id": "session-1" }))
            .unwrap();

        assert_eq!(hydrate["operation"], "hydrate");
        assert_eq!(rewind["status"], "unsupported");
        assert_eq!(fork["status"], "unsupported");
        assert_eq!(delete["status"], "unsupported");

        let calls = calls.lock().unwrap().clone();
        assert_eq!(
            calls,
            vec!["history-hydrate:{\"session_id\":\"session-1\"}".to_string()]
        );
    }

    #[test]
    fn registered_cursor_history_operations_return_unsupported() {
        let mut registry = ProviderRegistry::new();
        registry.register(ProviderKind::Cursor, Arc::new(CursorAdapter::new()));

        let capabilities = registry.history_capabilities(ProviderKind::Cursor);
        assert!(!capabilities.hydrate);
        assert!(!capabilities.fork);
        assert!(!capabilities.rewind);
        assert!(!capabilities.delete);

        let rewind = registry
            .history_truncate(ProviderKind::Cursor, json!({ "session_id": "cursor-1" }))
            .unwrap();
        let fork = registry
            .history_fork(ProviderKind::Cursor, json!({ "session_id": "cursor-1" }))
            .unwrap();
        let hydrate = registry
            .history_hydrate(ProviderKind::Cursor, json!({ "session_id": "cursor-1" }))
            .unwrap();
        let delete = registry
            .history_delete(ProviderKind::Cursor, json!({ "session_id": "cursor-1" }))
            .unwrap();

        for (operation, response) in [
            ("rewind", rewind),
            ("fork", fork),
            ("hydrate", hydrate),
            ("delete", delete),
        ] {
            assert_eq!(response["status"], "unsupported");
            assert_eq!(response["method"], "unsupported");
            assert!(response["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains(&format!("history {operation}"))));
        }
    }
}
