import type {
  ProviderCapabilities,
  ProviderControlKind,
  ProviderControlScope,
  ProviderControlValue,
  ProviderId,
  ProviderLegacyControlSlot,
} from "../lib/providers";

export type ProviderSnapshotAuthStatus = "authenticated" | "unauthenticated" | "unknown";
export type ProviderSnapshotInstallStatus = "installed" | "missing" | "unknown";
export type ProviderSnapshotState = "available" | "unavailable" | "degraded" | "unknown";
export type ProviderSnapshotOptionKind = ProviderControlKind;
export type ProviderSnapshotControlValue = Exclude<ProviderControlValue, null>;
export type ProviderSnapshotModelSwitchMode = "in-session" | "unsupported";

export interface ProviderSnapshotDisplay {
  label: string;
  shortLabel: string;
  brandTitle: string;
  emptyStateLabel: string;
  defaultSessionName: string;
}

export interface ProviderSnapshotAuth {
  status: ProviderSnapshotAuthStatus;
  label: string;
  detail?: string;
}

export interface ProviderSnapshotInstall {
  status: ProviderSnapshotInstallStatus;
  command: string;
  path?: string;
  version?: string;
}

export interface ProviderSnapshotStatus {
  state: ProviderSnapshotState;
  message?: string;
}

export interface ProviderSnapshotOptionValue {
  id: string;
  label: string;
  value?: ProviderSnapshotControlValue;
  description?: string;
  color?: string;
  inputLabel?: string;
  default?: boolean;
}

export interface ProviderSnapshotOptionDescriptor {
  id: string;
  label: string;
  kind: ProviderSnapshotOptionKind;
  scope: ProviderControlScope;
  defaultValue: ProviderSnapshotControlValue;
  options: readonly ProviderSnapshotOptionValue[];
  inputSuffix?: string;
  legacySlot?: ProviderLegacyControlSlot;
}

export interface ProviderSnapshotHistoryCapabilities {
  hydrate: boolean;
  fork: boolean;
  rewind: boolean;
  delete: boolean;
}

export interface ProviderSnapshotCapabilities extends ProviderCapabilities {
  sessionModelSwitch: ProviderSnapshotModelSwitchMode;
  history: ProviderSnapshotHistoryCapabilities;
}

export interface ProviderSnapshotSlashCommand {
  name: string;
  description: string;
  source: string;
}

export interface ProviderSnapshot {
  id: ProviderId;
  display: ProviderSnapshotDisplay;
  auth: ProviderSnapshotAuth;
  install: ProviderSnapshotInstall;
  status: ProviderSnapshotStatus;
  models: readonly ProviderSnapshotOptionValue[];
  options: readonly ProviderSnapshotOptionDescriptor[];
  capabilities: ProviderSnapshotCapabilities;
  slashCommands: readonly ProviderSnapshotSlashCommand[];
}
