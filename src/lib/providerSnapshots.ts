import { useEffect, useState } from "react";
import type {
  AnyProviderControlOption,
  PermissionOption,
  ProviderFeature,
  ProviderControlMetadata,
  ProviderControlOption,
  ProviderControlScope,
  ProviderControlValue,
  ProviderId,
  ProviderManifest,
} from "./providers";
import {
  getProviderInputPermissionControl,
  getProviderManifest,
  isProviderId,
  listProviderManifests,
  PROVIDER_IDS,
  providerControlOptionValue,
} from "./providers";
import { listProviderSnapshots } from "./tauriApi";
import type {
  ProviderSnapshot,
  ProviderSnapshotCapabilities,
  ProviderSnapshotHistoryCapabilities,
  ProviderSnapshotOptionDescriptor,
  ProviderSnapshotOptionValue,
} from "../contracts/providerSnapshot";

export type ProviderSnapshotMap = Partial<Record<ProviderId, ProviderSnapshot>>;

export interface ProviderSnapshotDisplaySummary {
  provider: ProviderId;
  label: string;
  shortLabel: string;
  brandTitle: string;
  emptyStateLabel: string;
  defaultSessionName: string;
  installed: boolean | null;
  enabled: boolean;
  statusLabel?: string;
}

export interface ProviderSnapshotControl extends ProviderSnapshotOptionDescriptor {}

export interface ProviderSnapshotPermissionPresentation {
  label: string;
  color: string;
}

const PROVIDER_COMMANDS: Record<ProviderId, string> = {
  anthropic: "claude",
  openai: "codex",
  cursor: "cursor-agent",
};

function historyCapabilitiesFromManifest(manifest: ProviderManifest): ProviderSnapshotHistoryCapabilities {
  switch (manifest.history.source) {
    case "claude-jsonl":
    case "codex-rollout":
      return {
        hydrate: true,
        fork: true,
        rewind: true,
        delete: true,
      };
    case "local-transcript":
    case "none":
      return {
        hydrate: false,
        fork: false,
        rewind: false,
        delete: false,
      };
  }
}

function capabilitiesFromManifest(manifest: ProviderManifest): ProviderSnapshotCapabilities {
  return {
    ...manifest.capabilities,
    sessionModelSwitch: "in-session",
    history: historyCapabilitiesFromManifest(manifest),
  };
}

function isPermissionOption(option: AnyProviderControlOption): option is PermissionOption {
  const candidate = option as Partial<PermissionOption>;
  return typeof candidate.desc === "string" || typeof candidate.color === "string";
}

function optionValueFromManifest(option: AnyProviderControlOption): ProviderSnapshotOptionValue {
  const value: ProviderSnapshotOptionValue = {
    id: option.id,
    label: option.label,
  };
  const optionValue = providerControlOptionValue(option);
  if (optionValue !== option.id) value.value = optionValue;
  if (isPermissionOption(option)) {
    if (option.desc) value.description = option.desc;
    if (option.color) value.color = option.color;
    if (option.inputLabel) value.inputLabel = option.inputLabel;
  }
  return value;
}

function modelValuesFromManifest(manifest: ProviderManifest): ProviderSnapshotOptionValue[] {
  const modelControl = manifest.controls.find((control) => control.legacySlot === "model" || control.id === "model");
  if (!modelControl) return [];
  return modelControl.options.map((model) => {
    const value = optionValueFromManifest(model);
    if (model.id === modelControl.defaultValue) {
      return { ...value, default: true };
    }
    return value;
  });
}

function optionDescriptorFromControl(control: ProviderControlMetadata): ProviderSnapshotOptionDescriptor {
  const descriptor: ProviderSnapshotOptionDescriptor = {
    id: control.id,
    label: control.label,
    kind: control.kind,
    scope: control.scope,
    defaultValue: control.defaultValue,
    options: (control.options as readonly AnyProviderControlOption[]).map(optionValueFromManifest),
  };
  if (control.inputSuffix) descriptor.inputSuffix = control.inputSuffix;
  if (control.legacySlot) descriptor.legacySlot = control.legacySlot;
  return descriptor;
}

export function providerSnapshotOptionValue(option: ProviderSnapshotOptionValue): Exclude<ProviderControlValue, null> {
  return option.value ?? option.id;
}

export function snapshotFromProviderManifest(manifest: ProviderManifest): ProviderSnapshot {
  const command = PROVIDER_COMMANDS[manifest.id];
  return {
    id: manifest.id,
    display: {
      label: manifest.ui.label,
      shortLabel: manifest.ui.shortLabel,
      brandTitle: manifest.ui.brandTitle,
      emptyStateLabel: manifest.ui.emptyStateLabel,
      defaultSessionName: manifest.ui.defaultSessionName,
    },
    auth: {
      status: "unknown",
      label: `${manifest.ui.shortLabel} CLI`,
      detail: "Authentication is verified by the provider CLI when a turn starts.",
    },
    install: {
      status: "unknown",
      command,
    },
    status: {
      state: "unknown",
    },
    models: modelValuesFromManifest(manifest),
    options: manifest.controls.map(optionDescriptorFromControl),
    capabilities: capabilitiesFromManifest(manifest),
    slashCommands: [],
  };
}

export function listManifestProviderSnapshots(): ProviderSnapshot[] {
  return listProviderManifests().map(snapshotFromProviderManifest);
}

function snapshotsToMap(snapshots: readonly ProviderSnapshot[]): ProviderSnapshotMap {
  const map: ProviderSnapshotMap = {};
  for (const snapshot of snapshots) {
    map[snapshot.id] = snapshot;
  }
  return map;
}

function manifestSnapshotMap(): ProviderSnapshotMap {
  return snapshotsToMap(listManifestProviderSnapshots());
}

function mergeSnapshotWithFallback(snapshot: ProviderSnapshot, fallback: ProviderSnapshot): ProviderSnapshot {
  return {
    ...fallback,
    ...snapshot,
    display: {
      ...fallback.display,
      ...snapshot.display,
    },
    auth: {
      ...fallback.auth,
      ...snapshot.auth,
    },
    install: {
      ...fallback.install,
      ...snapshot.install,
    },
    status: {
      ...fallback.status,
      ...snapshot.status,
    },
    models: snapshot.models.length > 0 ? snapshot.models : fallback.models,
    options: snapshot.options.length > 0 ? snapshot.options : fallback.options,
    capabilities: {
      ...fallback.capabilities,
      ...snapshot.capabilities,
      history: {
        ...fallback.capabilities.history,
        ...snapshot.capabilities.history,
      },
    },
    slashCommands: snapshot.slashCommands.length > 0 ? snapshot.slashCommands : fallback.slashCommands,
  };
}

export function mergeProviderSnapshotsWithManifestFallback(
  backendSnapshots: readonly ProviderSnapshot[],
): ProviderSnapshot[] {
  const backendByProvider = new Map<ProviderId, ProviderSnapshot>();
  for (const snapshot of backendSnapshots) {
    if (isProviderId(snapshot.id)) {
      backendByProvider.set(snapshot.id, snapshot);
    }
  }

  return PROVIDER_IDS.map((provider) => {
    const fallback = snapshotFromProviderManifest(getProviderManifest(provider));
    const backend = backendByProvider.get(provider);
    return backend ? mergeSnapshotWithFallback(backend, fallback) : fallback;
  });
}

export async function loadProviderSnapshots(): Promise<ProviderSnapshot[]> {
  try {
    return mergeProviderSnapshotsWithManifestFallback(await listProviderSnapshots());
  } catch (error) {
    console.warn("[provider-snapshots] Falling back to frontend provider manifests:", error);
    return listManifestProviderSnapshots();
  }
}

let providerSnapshotLoadPromise: Promise<ProviderSnapshot[]> | null = null;

function ensureProviderSnapshotLoad(): Promise<ProviderSnapshot[]> {
  providerSnapshotLoadPromise ??= loadProviderSnapshots();
  return providerSnapshotLoadPromise;
}

export function useProviderSnapshots(): ProviderSnapshotMap {
  const [snapshots, setSnapshots] = useState<ProviderSnapshotMap>(() => manifestSnapshotMap());

  useEffect(() => {
    let cancelled = false;
    ensureProviderSnapshotLoad()
      .then((loaded) => {
        if (!cancelled) setSnapshots(snapshotsToMap(loaded));
      })
      .catch((error) => {
        console.warn("[provider-snapshots] Failed to load provider snapshots:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return snapshots;
}

function snapshotForProvider(provider: ProviderId, snapshots?: ProviderSnapshotMap): ProviderSnapshot {
  return snapshots?.[provider] ?? snapshotFromProviderManifest(getProviderManifest(provider));
}

function statusLabel(snapshot: ProviderSnapshot): string | undefined {
  if (snapshot.status.message) return snapshot.status.message;
  if (snapshot.install.status === "missing") return "Not installed";
  if (snapshot.status.state === "available" || snapshot.status.state === "unknown") return undefined;
  return snapshot.status.state.charAt(0).toUpperCase() + snapshot.status.state.slice(1);
}

function displaySummary(snapshot: ProviderSnapshot): ProviderSnapshotDisplaySummary {
  const summary: ProviderSnapshotDisplaySummary = {
    provider: snapshot.id,
    label: snapshot.display.label,
    shortLabel: snapshot.display.shortLabel,
    brandTitle: snapshot.display.brandTitle,
    emptyStateLabel: snapshot.display.emptyStateLabel,
    defaultSessionName: snapshot.display.defaultSessionName,
    installed: snapshot.install.status === "unknown" ? null : snapshot.install.status === "installed",
    enabled: snapshot.status.state !== "unavailable",
  };
  const label = statusLabel(snapshot);
  if (label) summary.statusLabel = label;
  return summary;
}

export function getProviderSnapshotDisplay(
  provider: ProviderId,
  snapshots?: ProviderSnapshotMap,
): ProviderSnapshotDisplaySummary {
  return displaySummary(snapshotForProvider(provider, snapshots));
}

export function listProviderSnapshotDisplays(snapshots?: ProviderSnapshotMap): ProviderSnapshotDisplaySummary[] {
  return PROVIDER_IDS.map((provider) => getProviderSnapshotDisplay(provider, snapshots));
}

function toControl(descriptor: ProviderSnapshotOptionDescriptor): ProviderSnapshotControl {
  return descriptor;
}

export function listProviderSnapshotControls(
  provider: ProviderId,
  snapshots?: ProviderSnapshotMap,
  scope?: ProviderControlScope,
): ProviderSnapshotControl[] {
  const controls = snapshotForProvider(provider, snapshots).options.map(toControl);
  return scope ? controls.filter((control) => control.scope === scope) : controls;
}

export function providerSnapshotSupports(
  provider: ProviderId,
  feature: ProviderFeature,
  snapshots?: ProviderSnapshotMap,
): boolean {
  return snapshotForProvider(provider, snapshots).capabilities[feature];
}

export function getProviderSnapshotPermissionInputPresentation(
  provider: ProviderId,
  permissionId: string,
  snapshots?: ProviderSnapshotMap,
): ProviderSnapshotPermissionPresentation | null {
  const permissionControl = listProviderSnapshotControls(provider, snapshots, "composer")[0];
  const option = permissionControl?.options.find((candidate) => candidate.id === permissionId || providerSnapshotOptionValue(candidate) === permissionId)
    ?? permissionControl?.options.find((candidate) => providerSnapshotOptionValue(candidate) === permissionControl.defaultValue)
    ?? permissionControl?.options[0];
  if (!permissionControl || !option) return null;
  const inputLabel = option.inputLabel ?? option.label.toLowerCase();
  const suffix = permissionControl.inputSuffix ?? getProviderInputPermissionControl(provider)?.inputSuffix;
  return {
    label: suffix ? `${inputLabel} ${suffix}` : inputLabel,
    color: option.color ?? "#89b4fa",
  };
}

const CAPABILITY_LABELS: Array<[ProviderFeature, string]> = [
  ["mcp", "MCP"],
  ["plan", "Plan"],
  ["fork", "Fork"],
  ["rewind", "Rewind"],
  ["images", "Images"],
  ["hookLog", "Hooks"],
  ["nativeSlashCommands", "Slash commands"],
  ["compact", "Compact"],
];

export function getProviderSnapshotCapabilityLabels(
  provider: ProviderId,
  snapshots?: ProviderSnapshotMap,
): string[] {
  const snapshot = snapshotForProvider(provider, snapshots);
  return CAPABILITY_LABELS
    .filter(([feature]) => snapshot.capabilities[feature])
    .map(([, label]) => label);
}

export function getProviderSnapshotModelSummary(
  provider: ProviderId,
  snapshots?: ProviderSnapshotMap,
): string {
  const models = snapshotForProvider(provider, snapshots).models;
  if (models.length === 0) return "";
  const shown = models.slice(0, 3).map((model) => model.label).join(", ");
  const remaining = models.length - 3;
  return remaining > 0 ? `${shown} +${remaining}` : shown;
}
