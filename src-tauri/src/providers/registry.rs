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
    ProviderAdapter, ProviderAdapterError, ProviderCreateSessionRequest,
    ProviderHistoryCapabilities, ProviderKind, ProviderSendPromptRequest,
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

    /// Fan out `stop_all` to every registered adapter. Collects per-adapter
    /// errors rather than short-circuiting so one misbehaving provider can't
    /// leak another's sessions on shutdown.
    pub async fn stop_all(&self) -> Result<(), Vec<ProviderAdapterError>> {
        let mut errors = Vec::new();
        for adapter in self.adapters.values() {
            if let Err(err) = adapter.stop_all().await {
                errors.push(err);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}
