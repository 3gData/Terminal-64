// Provider registry for UI manifests + session defaults.
//
// Each provider owns its model, effort, permission, and capability surface.
// UI components should read from this registry instead of branching on provider
// ids for labels or feature availability.

import type { PermissionMode } from "./types";

export type ProviderId = "anthropic" | "openai" | "cursor";
export type ProviderFeature =
  | "mcp"
  | "plan"
  | "fork"
  | "rewind"
  | "images"
  | "hookLog"
  | "nativeSlashCommands"
  | "compact";

export interface ModelOption {
  id: string;
  label: string;
}
export interface EffortOption {
  id: string;
  label: string;
}
// Note: PermissionMode is the Claude-shaped union ("default" | "plan" | …);
// for Codex we use string ids that are translated at the IPC boundary.
export interface PermissionOption {
  id: string;
  label: string;
  color: string;
  desc: string;
  inputLabel?: string;
}

export type ProviderControlId = "model" | "effort" | "permission";

export interface ProviderControlMetadata {
  id: ProviderControlId;
  label: string;
  inputSuffix?: string;
}

export type ProviderControlsMetadata = Partial<Record<ProviderControlId, ProviderControlMetadata>>;

export type ProviderPermissionPersistence = "provider-state";

export interface ProviderPermissionControlPolicy {
  persistence: ProviderPermissionPersistence;
  skipPermissionId?: PermissionMode;
}

// Provider-owned history/transcript source. The store uses this policy for
// local persistence choices; runtime/backend adapters own the actual IO.
export type ProviderHistorySource =
  | "claude-jsonl"
  | "codex-rollout"
  | "local-transcript"
  | "none";

export interface ProviderHistoryPolicy {
  source: ProviderHistorySource;
  hydrateFailureLabel: string;
}

export interface ProviderCapabilities {
  mcp: boolean;
  plan: boolean;
  fork: boolean;
  rewind: boolean;
  images: boolean;
  hookLog: boolean;
  nativeSlashCommands: boolean;
  compact: boolean;
}

export type DelegationMcpTransport = "temp-config" | "env";
export type DelegationOpenwolfPolicy = "inherit" | "always";
export type DelegationPermissionPresetPolicy = "selected" | "bypass_all";
export type DelegationPlannerPermissionPolicy = "inherit" | PermissionMode;

export interface ProviderDelegationPolicy {
  mcpTransport: DelegationMcpTransport;
  skipOpenwolf: DelegationOpenwolfPolicy;
  noSessionPersistence: boolean;
  skipGitRepoCheck: boolean;
  planner: {
    permissionOverride: DelegationPlannerPermissionPolicy;
  };
  childRuntime: {
    permissionPreset: DelegationPermissionPresetPolicy;
  };
}

export interface ProviderUiMetadata {
  label: string;
  shortLabel: string;
  brandTitle: string;
  emptyStateLabel: string;
  defaultSessionName: string;
  /** @deprecated Use controls.model.label. */
  modelMenuLabel: string;
  /** @deprecated Use controls.effort.label. */
  effortMenuLabel: string;
  /** @deprecated Use controls.permission.inputSuffix. */
  inputPermissionSuffix: string;
}

export interface ProviderManifest {
  id: ProviderId;
  ui: ProviderUiMetadata;
  capabilities: ProviderCapabilities;
  delegation: ProviderDelegationPolicy;
  permissionControl: ProviderPermissionControlPolicy;
  history: ProviderHistoryPolicy;
  controls: ProviderControlsMetadata;
  models: ModelOption[];
  efforts: EffortOption[];
  permissions: PermissionOption[];
  defaultModel: string;
  defaultEffort: string;
  defaultPermission: string;
}

const ANTHROPIC_MODELS: ModelOption[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
  { id: "opusplan", label: "Opus Plan" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "sonnet[1m]", label: "Sonnet 1M" },
  { id: "opus[1m]", label: "Opus 1M" },
  { id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M" },
];

const ANTHROPIC_EFFORTS: EffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Med" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
  { id: "xhigh", label: "X-High" },
];

const ANTHROPIC_PERMISSIONS: PermissionOption[] = [
  { id: "default", label: "Default", color: "#89b4fa", desc: "Ask before every tool", inputLabel: "ask permissions" },
  { id: "plan", label: "Plan", color: "#94e2d5", desc: "Read-only, no edits", inputLabel: "plan mode" },
  { id: "auto", label: "Auto", color: "#a6e3a1", desc: "Auto-approve safe ops", inputLabel: "auto-approve" },
  { id: "accept_edits", label: "Edits", color: "#cba6f7", desc: "Auto-approve all edits", inputLabel: "auto-accept edits" },
  { id: "bypass_all", label: "YOLO", color: "#f38ba8", desc: "Skip ALL permissions", inputLabel: "bypass permissions" },
];

// Models accepted by `codex exec` with a ChatGPT (Plus/Pro) account, verified
// 2026-04-25 against codex-cli-exec 0.121.0. The API-key path may allow more
// (o3 / o4-mini / gpt-5-codex / etc) but ChatGPT auth is whitelist-only —
// anything outside this set 400s with "model is not supported when using
// Codex with a ChatGPT account". Users on API keys can override via
// `~/.codex/config.toml`.
const OPENAI_MODELS: ModelOption[] = [
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.2", label: "GPT-5.2" },
];

// Canonical Codex `reasoning_effort` enum, matching upstream's
// `ClientRequest__ReasoningEffort` and t3code's `REASONING_EFFORT_LABELS`.
// Some combinations are server-rejected (e.g. `minimal` 400s if the model's
// auto-enabled web_search tool is on, with: "The following tools cannot be
// used with reasoning.effort 'minimal'") — surfaced as a runtime error
// rather than hidden from the picker. `none` is omitted; it's plan-mode
// territory and not useful from a chat composer.
const OPENAI_EFFORTS: EffortOption[] = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
];

// Codex's permission surface is two enums: `--sandbox` (the filesystem
// sandbox) and `-c approval_policy=…` (when to ask the human). We collapse
// the common pairs into preset "modes" the user picks, then expand them at
// the IPC boundary inside ClaudeChat → createCodexSession.
//
// id matches the preset name; sandbox/policy/full_auto/yolo are encoded in
// `decodeCodexPermission()` below.
const OPENAI_PERMISSIONS: PermissionOption[] = [
  { id: "read-only", label: "Read", color: "#89b4fa", desc: "No filesystem writes" },
  { id: "workspace", label: "Workspace", color: "#94e2d5", desc: "Write inside cwd" },
  { id: "full-auto", label: "Auto", color: "#a6e3a1", desc: "Workspace + auto-approve all" },
  { id: "yolo", label: "YOLO", color: "#f38ba8", desc: "No sandbox, no approvals" },
];

const CURSOR_MODELS: ModelOption[] = [
  { id: "auto", label: "Auto" },
  { id: "composer-2-fast", label: "Composer 2 Fast" },
  { id: "composer-2", label: "Composer 2" },
  { id: "composer-1.5", label: "Composer 1.5" },
  { id: "gpt-5.3-codex", label: "Codex 5.3" },
  { id: "gpt-5.3-codex-fast", label: "Codex 5.3 Fast" },
  { id: "gpt-5.3-codex-high", label: "Codex 5.3 High" },
  { id: "gpt-5.3-codex-xhigh", label: "Codex 5.3 Extra High" },
  { id: "gpt-5.3-codex-spark-preview", label: "Codex 5.3 Spark" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-5.5-medium", label: "GPT-5.5 1M" },
  { id: "gpt-5.5-high", label: "GPT-5.5 1M High" },
  { id: "gpt-5.5-extra-high", label: "GPT-5.5 1M Extra High" },
  { id: "gpt-5.4-medium", label: "GPT-5.4 1M" },
  { id: "gpt-5.4-high", label: "GPT-5.4 1M High" },
  { id: "gpt-5.4-xhigh", label: "GPT-5.4 1M Extra High" },
  { id: "gpt-5.4-mini-medium", label: "GPT-5.4 Mini" },
  { id: "claude-opus-4-7-medium", label: "Opus 4.7 1M Medium" },
  { id: "claude-opus-4-7-high", label: "Opus 4.7 1M High" },
  { id: "claude-opus-4-7-thinking-high", label: "Opus 4.7 1M High Thinking" },
  { id: "claude-4.6-sonnet-medium", label: "Sonnet 4.6 1M" },
  { id: "claude-4.6-sonnet-medium-thinking", label: "Sonnet 4.6 1M Thinking" },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash" },
  { id: "grok-4-20", label: "Grok 4.20" },
  { id: "grok-4-20-thinking", label: "Grok 4.20 Thinking" },
  { id: "kimi-k2.5", label: "Kimi K2.5" },
];

const CURSOR_EFFORTS: EffortOption[] = [
  { id: "default", label: "Default" },
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Plan" },
];

const CURSOR_PERMISSIONS: PermissionOption[] = [
  { id: "default", label: "Review", color: "#89b4fa", desc: "Propose changes without force-applying them", inputLabel: "review" },
  { id: "plan", label: "Plan", color: "#94e2d5", desc: "Planning prompt without direct writes", inputLabel: "plan" },
  { id: "bypass_all", label: "Force", color: "#f38ba8", desc: "Pass --force so Cursor can apply changes", inputLabel: "force" },
];

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderManifest> = {
  anthropic: {
    id: "anthropic",
    ui: {
      label: "Anthropic",
      shortLabel: "Claude",
      brandTitle: "Anthropic Claude",
      emptyStateLabel: "Claude Code",
      defaultSessionName: "Claude",
      modelMenuLabel: "Model",
      effortMenuLabel: "Effort",
      inputPermissionSuffix: "on",
    },
    capabilities: {
      mcp: true,
      plan: true,
      fork: true,
      rewind: true,
      images: true,
      hookLog: true,
      nativeSlashCommands: true,
      compact: true,
    },
    delegation: {
      mcpTransport: "temp-config",
      skipOpenwolf: "inherit",
      noSessionPersistence: true,
      skipGitRepoCheck: false,
      planner: {
        permissionOverride: "inherit",
      },
      childRuntime: {
        permissionPreset: "bypass_all",
      },
    },
    permissionControl: {
      persistence: "provider-state",
      skipPermissionId: "bypass_all",
    },
    history: {
      source: "claude-jsonl",
      hydrateFailureLabel: "Claude JSONL",
    },
    controls: {
      model: { id: "model", label: "Model" },
      effort: { id: "effort", label: "Effort" },
      permission: { id: "permission", label: "Permissions", inputSuffix: "on" },
    },
    models: ANTHROPIC_MODELS,
    efforts: ANTHROPIC_EFFORTS,
    permissions: ANTHROPIC_PERMISSIONS,
    defaultModel: "sonnet",
    defaultEffort: "high",
    defaultPermission: "default",
  },
  openai: {
    id: "openai",
    ui: {
      label: "OpenAI",
      shortLabel: "Codex",
      brandTitle: "OpenAI Codex",
      emptyStateLabel: "Codex",
      defaultSessionName: "Codex",
      modelMenuLabel: "Model",
      effortMenuLabel: "Effort",
      inputPermissionSuffix: "sandbox",
    },
    capabilities: {
      mcp: true,
      plan: true,
      fork: true,
      rewind: true,
      images: true,
      hookLog: false,
      nativeSlashCommands: false,
      compact: false,
    },
    delegation: {
      mcpTransport: "env",
      skipOpenwolf: "always",
      noSessionPersistence: false,
      skipGitRepoCheck: true,
      planner: {
        permissionOverride: "inherit",
      },
      childRuntime: {
        permissionPreset: "selected",
      },
    },
    permissionControl: {
      persistence: "provider-state",
    },
    history: {
      source: "codex-rollout",
      hydrateFailureLabel: "Codex",
    },
    controls: {
      model: { id: "model", label: "Model" },
      effort: { id: "effort", label: "Effort" },
      permission: { id: "permission", label: "Sandbox", inputSuffix: "sandbox" },
    },
    models: OPENAI_MODELS,
    efforts: OPENAI_EFFORTS,
    permissions: OPENAI_PERMISSIONS,
    defaultModel: "gpt-5.5",
    defaultEffort: "medium",
    defaultPermission: "workspace",
  },
  cursor: {
    id: "cursor",
    ui: {
      label: "Cursor",
      shortLabel: "Cursor",
      brandTitle: "Cursor Agent",
      emptyStateLabel: "Cursor Agent",
      defaultSessionName: "Cursor",
      modelMenuLabel: "Model",
      effortMenuLabel: "Mode",
      inputPermissionSuffix: "mode",
    },
    capabilities: {
      mcp: true,
      plan: true,
      fork: false,
      rewind: false,
      images: false,
      hookLog: false,
      nativeSlashCommands: false,
      compact: false,
    },
    delegation: {
      mcpTransport: "env",
      skipOpenwolf: "always",
      noSessionPersistence: false,
      skipGitRepoCheck: true,
      planner: {
        permissionOverride: "bypass_all",
      },
      childRuntime: {
        permissionPreset: "selected",
      },
    },
    permissionControl: {
      persistence: "provider-state",
      skipPermissionId: "bypass_all",
    },
    history: {
      source: "local-transcript",
      hydrateFailureLabel: "Cursor local transcript",
    },
    controls: {
      model: { id: "model", label: "Model" },
      effort: { id: "effort", label: "Mode" },
      permission: { id: "permission", label: "Mode", inputSuffix: "mode" },
    },
    models: CURSOR_MODELS,
    efforts: CURSOR_EFFORTS,
    permissions: CURSOR_PERMISSIONS,
    defaultModel: "composer-2-fast",
    defaultEffort: "default",
    defaultPermission: "default",
  },
};

export const PROVIDER_CONFIG = PROVIDER_REGISTRY;

export const PROVIDER_IDS = Object.keys(PROVIDER_REGISTRY) as ProviderId[];

export function getProviderManifest(provider: ProviderId): ProviderManifest {
  return PROVIDER_REGISTRY[provider];
}

export function getProviderDelegationPolicy(provider: ProviderId): ProviderDelegationPolicy {
  return PROVIDER_REGISTRY[provider].delegation;
}

export function getProviderPermissionControlPolicy(provider: ProviderId): ProviderPermissionControlPolicy {
  return PROVIDER_REGISTRY[provider].permissionControl;
}

export function getProviderControl(provider: ProviderId, control: ProviderControlId): ProviderControlMetadata | undefined {
  return PROVIDER_REGISTRY[provider].controls[control];
}

export function providerHasControl(provider: ProviderId, control: ProviderControlId): boolean {
  return !!getProviderControl(provider, control);
}

export function getProviderHistoryPolicy(provider: ProviderId): ProviderHistoryPolicy {
  return PROVIDER_REGISTRY[provider].history;
}

export function providerPersistsLocalTranscript(provider: ProviderId): boolean {
  return getProviderHistoryPolicy(provider).source === "local-transcript";
}

export function listProviderManifests(): ProviderManifest[] {
  return PROVIDER_IDS.map((provider) => PROVIDER_REGISTRY[provider]);
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, value);
}

export function providerSupports(provider: ProviderId, feature: ProviderFeature): boolean {
  return PROVIDER_REGISTRY[provider].capabilities[feature];
}

export function isCodexPermissionId(id: string): boolean {
  return PROVIDER_REGISTRY.openai.permissions.some((p) => p.id === id);
}
export function isClaudePermissionId(id: string): id is PermissionMode {
  return PROVIDER_REGISTRY.anthropic.permissions.some((p) => p.id === id);
}

/**
 * Translate a Codex preset id into the four wire fields our backend expects:
 *   sandbox_mode | approval_policy | full_auto | yolo
 *
 * Mapping:
 *   "read-only"    → sandbox=read-only,        policy=never
 *   "workspace"    → sandbox=workspace-write,  policy=never
 *   "full-auto"    → full_auto=true (CLI implies workspace-write + never-ask)
 *   "yolo"         → yolo=true     (CLI bypasses sandbox AND approvals)
 */
export function decodeCodexPermission(id: string): {
  sandbox_mode?: string;
  approval_policy?: string;
  full_auto?: boolean;
  yolo?: boolean;
} {
  switch (id) {
    case "read-only":
      return { sandbox_mode: "read-only", approval_policy: "never" };
    case "workspace":
      return { sandbox_mode: "workspace-write", approval_policy: "never" };
    case "full-auto":
      return { full_auto: true };
    case "yolo":
      return { yolo: true };
    default:
      return { sandbox_mode: "workspace-write", approval_policy: "never" };
  }
}
