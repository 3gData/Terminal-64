//! Provider snapshot helpers for the frontend's additive `provider_snapshots`
//! IPC surface.
//!
//! Registered adapters own when their descriptor is exposed through the
//! registry and keep their static descriptor data beside their runtime
//! behavior. This module only builds the shared wire shape, avoiding a central
//! provider-kind dispatch table.

use std::path::Path;

use crate::providers::traits::{
    ProviderAdapterCapabilities, ProviderHistoryCapabilities, ProviderSessionModelSwitchMode,
};
use crate::types::{
    ProviderSnapshot, ProviderSnapshotAuth, ProviderSnapshotCapabilities,
    ProviderSnapshotControlValue, ProviderSnapshotDisplay, ProviderSnapshotHistoryCapabilities,
    ProviderSnapshotInstall, ProviderSnapshotOptionDescriptor, ProviderSnapshotOptionValue,
    ProviderSnapshotSlashCommand, ProviderSnapshotStatus,
};

pub(crate) struct SnapshotOptionDescriptor {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) description: Option<&'static str>,
    pub(crate) color: Option<&'static str>,
    pub(crate) input_label: Option<&'static str>,
}

impl SnapshotOptionDescriptor {
    pub(crate) const fn basic(id: &'static str, label: &'static str) -> Self {
        Self {
            id,
            label,
            description: None,
            color: None,
            input_label: None,
        }
    }

    pub(crate) const fn described(
        id: &'static str,
        label: &'static str,
        description: &'static str,
        color: &'static str,
        input_label: Option<&'static str>,
    ) -> Self {
        Self {
            id,
            label,
            description: Some(description),
            color: Some(color),
            input_label,
        }
    }
}

pub(crate) struct SnapshotControlDescriptor {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) kind: &'static str,
    pub(crate) scope: &'static str,
    pub(crate) default_value: &'static str,
    pub(crate) options: &'static [SnapshotOptionDescriptor],
    pub(crate) input_suffix: Option<&'static str>,
    pub(crate) legacy_slot: Option<&'static str>,
}

impl SnapshotControlDescriptor {
    pub(crate) const fn select(
        id: &'static str,
        label: &'static str,
        default_value: &'static str,
        scope: &'static str,
        options: &'static [SnapshotOptionDescriptor],
        input_suffix: Option<&'static str>,
        legacy_slot: Option<&'static str>,
    ) -> Self {
        Self {
            id,
            label,
            kind: "select",
            scope,
            default_value,
            options,
            input_suffix,
            legacy_slot,
        }
    }
}

pub(crate) struct SnapshotDisplayDescriptor {
    pub(crate) label: &'static str,
    pub(crate) short_label: &'static str,
    pub(crate) brand_title: &'static str,
    pub(crate) empty_state_label: &'static str,
    pub(crate) default_session_name: &'static str,
}

pub(crate) struct SnapshotInstallDescriptor {
    pub(crate) command: &'static str,
    pub(crate) status_label: &'static str,
}

pub(crate) struct SnapshotDescriptor {
    pub(crate) id: &'static str,
    pub(crate) display: SnapshotDisplayDescriptor,
    pub(crate) auth_label: &'static str,
    pub(crate) install: SnapshotInstallDescriptor,
    pub(crate) controls: &'static [SnapshotControlDescriptor],
}

fn option_value(
    option: &SnapshotOptionDescriptor,
    default_id: Option<&str>,
) -> ProviderSnapshotOptionValue {
    ProviderSnapshotOptionValue {
        id: option.id.to_string(),
        label: option.label.to_string(),
        value: None,
        description: option.description.map(str::to_string),
        color: option.color.map(str::to_string),
        input_label: option.input_label.map(str::to_string),
        default: default_id.and_then(|id| (option.id == id).then_some(true)),
    }
}

fn marks_default_option(control: &SnapshotControlDescriptor) -> bool {
    control.legacy_slot == Some("model") || control.id == "model"
}

fn control_options(control: &SnapshotControlDescriptor) -> Vec<ProviderSnapshotOptionValue> {
    let default_id = marks_default_option(control).then_some(control.default_value);
    control
        .options
        .iter()
        .map(|option| option_value(option, default_id))
        .collect()
}

fn option_descriptor(control: &SnapshotControlDescriptor) -> ProviderSnapshotOptionDescriptor {
    ProviderSnapshotOptionDescriptor {
        id: control.id.to_string(),
        label: control.label.to_string(),
        kind: control.kind.to_string(),
        scope: control.scope.to_string(),
        default_value: ProviderSnapshotControlValue::from(control.default_value),
        options: control_options(control),
        input_suffix: control.input_suffix.map(str::to_string),
        legacy_slot: control.legacy_slot.map(str::to_string),
    }
}

fn auth_snapshot(label: &str) -> ProviderSnapshotAuth {
    ProviderSnapshotAuth {
        status: "unknown".to_string(),
        label: label.to_string(),
        detail: Some(
            "Authentication is verified by the provider CLI when a turn starts.".to_string(),
        ),
    }
}

fn unresolved_binary_names(command: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![
            command.to_string(),
            format!("{command}.cmd"),
            format!("{command}.exe"),
        ]
    } else {
        vec![command.to_string()]
    }
}

fn install_snapshot(command: &str, resolved_path: String) -> ProviderSnapshotInstall {
    let unresolved = unresolved_binary_names(command)
        .iter()
        .any(|name| resolved_path.eq_ignore_ascii_case(name));
    let installed = !unresolved || Path::new(&resolved_path).exists();
    ProviderSnapshotInstall {
        status: if installed { "installed" } else { "missing" }.to_string(),
        command: command.to_string(),
        path: installed.then_some(resolved_path),
        version: None,
    }
}

fn status_from_install(label: &str, install: &ProviderSnapshotInstall) -> ProviderSnapshotStatus {
    if install.status == "installed" {
        ProviderSnapshotStatus {
            state: "available".to_string(),
            message: None,
        }
    } else {
        ProviderSnapshotStatus {
            state: "unavailable".to_string(),
            message: Some(format!(
                "{label} CLI was not found. Install it or add `{}` to PATH.",
                install.command
            )),
        }
    }
}

fn session_model_switch(mode: ProviderSessionModelSwitchMode) -> String {
    match mode {
        ProviderSessionModelSwitchMode::InSession => "in-session",
        ProviderSessionModelSwitchMode::Unsupported => "unsupported",
    }
    .to_string()
}

fn history_capabilities(
    history: ProviderHistoryCapabilities,
) -> ProviderSnapshotHistoryCapabilities {
    ProviderSnapshotHistoryCapabilities {
        hydrate: history.hydrate,
        fork: history.fork,
        rewind: history.rewind,
        delete: history.delete,
    }
}

fn capabilities_snapshot(adapter: &ProviderAdapterCapabilities) -> ProviderSnapshotCapabilities {
    ProviderSnapshotCapabilities {
        mcp: adapter.mcp,
        plan: adapter.plan,
        fork: adapter.history.fork,
        rewind: adapter.history.rewind,
        images: adapter.images,
        hook_log: adapter.hook_log,
        native_slash_commands: adapter.native_slash_commands,
        compact: adapter.compact,
        session_model_switch: session_model_switch(adapter.session_model_switch),
        history: history_capabilities(adapter.history),
    }
}

fn display_snapshot(display: &SnapshotDisplayDescriptor) -> ProviderSnapshotDisplay {
    ProviderSnapshotDisplay {
        label: display.label.to_string(),
        short_label: display.short_label.to_string(),
        brand_title: display.brand_title.to_string(),
        empty_state_label: display.empty_state_label.to_string(),
        default_session_name: display.default_session_name.to_string(),
    }
}

fn top_level_models(descriptor: &SnapshotDescriptor) -> Vec<ProviderSnapshotOptionValue> {
    descriptor
        .controls
        .iter()
        .find(|control| marks_default_option(control))
        .map(control_options)
        .unwrap_or_default()
}

pub(crate) fn snapshot_from_descriptor(
    descriptor: &SnapshotDescriptor,
    adapter: &ProviderAdapterCapabilities,
    resolved_path: String,
) -> ProviderSnapshot {
    let install = install_snapshot(descriptor.install.command, resolved_path);
    let status = status_from_install(descriptor.install.status_label, &install);

    ProviderSnapshot {
        id: descriptor.id.to_string(),
        display: display_snapshot(&descriptor.display),
        auth: auth_snapshot(descriptor.auth_label),
        install,
        status,
        models: top_level_models(descriptor),
        options: descriptor.controls.iter().map(option_descriptor).collect(),
        capabilities: capabilities_snapshot(adapter),
        slash_commands: Vec::<ProviderSnapshotSlashCommand>::new(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::providers::traits::ProviderAdapter;
    use crate::providers::{ClaudeAdapter, CodexAdapter, CursorAdapter};

    fn assert_snapshot_capabilities_match_adapter(adapter: &dyn ProviderAdapter) {
        let capabilities = adapter.capabilities();
        let snapshot = adapter.snapshot();

        assert_eq!(
            snapshot.capabilities.session_model_switch,
            session_model_switch(capabilities.session_model_switch)
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

    fn control<'a>(
        snapshot: &'a ProviderSnapshot,
        id: &str,
    ) -> &'a ProviderSnapshotOptionDescriptor {
        snapshot
            .options
            .iter()
            .find(|option| option.id == id)
            .unwrap()
    }

    fn string_default(control: &ProviderSnapshotOptionDescriptor) -> &str {
        match &control.default_value {
            ProviderSnapshotControlValue::String(value) => value,
            _ => panic!("expected string default for {}", control.id),
        }
    }

    #[test]
    fn provider_snapshot_serializes_frontend_contract_fields() {
        let snapshot = CodexAdapter::new().snapshot();
        let value = serde_json::to_value(snapshot).unwrap();

        assert_eq!(value["id"], "openai");
        assert_eq!(value["display"]["shortLabel"], "Codex");
        assert_eq!(value["capabilities"]["sessionModelSwitch"], "in-session");
        assert_eq!(value["capabilities"]["history"]["rewind"], true);

        let options = value["options"].as_array().unwrap();
        assert!(options.iter().any(|option| option["id"] == "sandbox"));
        let first = &options[0];
        assert_eq!(first["kind"], "select");
        assert!(first.get("scope").is_some());
        assert!(first.get("options").is_some());
        assert!(
            first.get("placement").is_none(),
            "frontend snapshot descriptors use generic scope, not legacy placement"
        );
        assert!(
            first.get("values").is_none(),
            "frontend snapshot descriptors use options, not legacy values"
        );
    }

    #[test]
    fn provider_snapshot_control_values_serialize_typed_non_select_values() {
        let descriptor = ProviderSnapshotOptionDescriptor {
            id: "stream".to_string(),
            label: "Stream".to_string(),
            kind: "boolean".to_string(),
            scope: "topbar".to_string(),
            default_value: ProviderSnapshotControlValue::Boolean(true),
            options: vec![ProviderSnapshotOptionValue {
                id: "enabled".to_string(),
                label: "Enabled".to_string(),
                value: Some(ProviderSnapshotControlValue::Boolean(true)),
                description: None,
                color: None,
                input_label: None,
                default: None,
            }],
            input_suffix: None,
            legacy_slot: None,
        };
        let value = serde_json::to_value(descriptor).unwrap();

        assert_eq!(value["kind"], "boolean");
        assert_eq!(value["defaultValue"], true);
        assert_eq!(value["options"][0]["value"], true);

        let descriptor = ProviderSnapshotOptionDescriptor {
            id: "temperature".to_string(),
            label: "Temperature".to_string(),
            kind: "number".to_string(),
            scope: "topbar".to_string(),
            default_value: ProviderSnapshotControlValue::Number(0.2),
            options: vec![ProviderSnapshotOptionValue {
                id: "balanced".to_string(),
                label: "Balanced".to_string(),
                value: Some(ProviderSnapshotControlValue::Number(0.2)),
                description: None,
                color: None,
                input_label: None,
                default: None,
            }],
            input_suffix: None,
            legacy_slot: None,
        };
        let value = serde_json::to_value(descriptor).unwrap();

        assert_eq!(value["kind"], "number");
        assert_eq!(value["defaultValue"], 0.2);
        assert_eq!(value["options"][0]["value"], 0.2);
    }

    #[test]
    fn cursor_snapshot_reflects_unsupported_history_capabilities() {
        let snapshot = CursorAdapter::new().snapshot();

        assert_eq!(snapshot.id, "cursor");
        assert!(!snapshot.capabilities.history.hydrate);
        assert!(!snapshot.capabilities.history.fork);
        assert!(!snapshot.capabilities.history.rewind);
        assert!(!snapshot.capabilities.history.delete);
        assert!(snapshot
            .options
            .iter()
            .any(|option| option.id == "apply-mode"));
    }

    #[test]
    fn shipping_provider_snapshots_keep_descriptor_defaults_stable() {
        let cases = vec![
            (
                ClaudeAdapter::new().snapshot(),
                "anthropic",
                "Claude",
                "sonnet",
                "tool-permission",
                "default",
            ),
            (
                CodexAdapter::new().snapshot(),
                "openai",
                "Codex",
                "gpt-5.5",
                "sandbox",
                "workspace",
            ),
            (
                CursorAdapter::new().snapshot(),
                "cursor",
                "Cursor",
                "composer-2-fast",
                "apply-mode",
                "default",
            ),
        ];

        for (
            snapshot,
            expected_id,
            expected_default_session_name,
            expected_model,
            permission_control_id,
            expected_permission,
        ) in cases
        {
            assert_eq!(snapshot.id, expected_id);
            assert_eq!(
                snapshot.display.default_session_name,
                expected_default_session_name
            );
            assert_eq!(string_default(control(&snapshot, "model")), expected_model);
            assert_eq!(
                string_default(control(&snapshot, permission_control_id)),
                expected_permission
            );
            assert!(snapshot
                .models
                .iter()
                .any(|model| model.id == expected_model && model.default == Some(true)));
        }
    }

    #[test]
    fn shipping_provider_snapshots_match_adapter_capabilities() {
        let claude = ClaudeAdapter::new();
        assert_snapshot_capabilities_match_adapter(&claude);

        let codex = CodexAdapter::new();
        assert_snapshot_capabilities_match_adapter(&codex);

        let cursor = CursorAdapter::new();
        assert_snapshot_capabilities_match_adapter(&cursor);
    }
}
