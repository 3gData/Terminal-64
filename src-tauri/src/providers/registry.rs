// Step 1 only registers the Claude adapter and reaches for it via the
// typed handle on `AppState`. The trait-object lookup methods (`get`,
// `claude`, `codex`, `all`, `iter`, `kinds`, `stop_all`) come online when a
// second adapter (Codex) lands. Allow dead code until then.
#![allow(dead_code)]

//! Provider registry — thin wrapper around a
//! `HashMap<ProviderKind, Arc<dyn ProviderAdapter>>`.
//!
//! Replaces the direct `Arc<ClaudeManager>` field on `AppState`. Call sites
//! use `registry.get(ProviderKind::ClaudeAgent)` instead of hard-coding a
//! concrete manager, so adding Codex is a `register(...)` call rather than a
//! call-site rewrite.

use std::collections::HashMap;
use std::sync::Arc;

use crate::providers::traits::{ProviderAdapter, ProviderAdapterError, ProviderKind};

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
