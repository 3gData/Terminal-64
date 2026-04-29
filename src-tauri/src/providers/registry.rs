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
    ProviderCreateSessionRequest, ProviderHistoryCapabilities, ProviderHistoryRequest,
    ProviderHistoryResponse, ProviderKind, ProviderSendPromptRequest,
};

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
        let _model_switch_capability = adapter.capabilities().session_model_switch;
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
            match expected {
                ProviderKind::ClaudeAgent | ProviderKind::Codex => {
                    assert!(history.hydrate);
                    assert!(history.fork);
                    assert!(history.rewind);
                    assert!(history.delete);
                }
                ProviderKind::Cursor => {
                    assert!(!history.hydrate);
                    assert!(!history.fork);
                    assert!(!history.rewind);
                    assert!(!history.delete);
                }
                ProviderKind::OpenCode => unreachable!("OpenCode has no adapter yet"),
            }
        }
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
}
