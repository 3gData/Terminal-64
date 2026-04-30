import type { ProviderTurnInput, ProviderTurnOptionsByProvider } from "../contracts/providerRuntime";
import type {
  ProviderControlValueMap,
  ProviderSelectedControlsMap,
  ProviderSessionState,
} from "../stores/providerSessionStore";
import {
  getProviderPermissionId,
  getProviderSelectedControlValues,
  resolveSessionProviderState,
} from "../stores/providerSessionStore";
import type { ChatMessage, DelegationChildRuntimeMetadata, PermissionMode } from "./types";
import {
  getProviderDefaultPermission,
  getProviderDelegationPolicy,
  getProviderPermissionOptions,
  type ProviderId,
} from "./providers";
import type { DelegationMcpTransport } from "./providers";

export type { DelegationMcpTransport } from "./providers";

interface DelegationParentSessionSource {
  providerState?: ProviderSessionState | undefined;
  provider?: ProviderId | undefined;
  codexThreadId?: string | null | undefined;
  seedTranscript?: ChatMessage[] | null | undefined;
  selectedControls?: ProviderSelectedControlsMap | undefined;
  selectedModel?: string | null | undefined;
  selectedEffort?: string | null | undefined;
  skipOpenwolf?: boolean | undefined;
}

export interface DelegationChildRuntimeSettings {
  provider: ProviderId;
  selectedControls: ProviderControlValueMap;
  selectedModel: string;
  selectedEffort: string;
  selectedProviderPermissionId: string;
  inheritSkipOpenwolf: boolean;
}

export interface ResolveDelegationChildRuntimeSettingsOptions {
  parentSession?: DelegationParentSessionSource | undefined;
  selectedProvider: ProviderId;
  selectedControls?: ProviderControlValueMap | undefined;
  selectedModel: string;
  selectedEffort: string;
  selectedProviderPermissionId: string;
}

export interface DelegationMcpConnection {
  delegationPort: number;
  delegationSecret: string;
  groupId: string;
  agentLabel: string;
}

export interface DelegationChildTurnOptions extends DelegationChildRuntimeSettings {
  sessionId: string;
  cwd: string;
  prompt: string;
  mcpConfigPath?: string | undefined;
  mcpEnv?: Record<string, string> | undefined;
}

export interface PrepareDelegationChildTurnOptions extends DelegationChildRuntimeSettings {
  sessionId: string;
  cwd: string;
  prompt: string;
  mcp: DelegationMcpConnection;
}

interface DelegationChildRuntimePermission {
  providerPermissionId: string;
  permissionOverride?: PermissionMode | undefined;
}

export function getDelegationMcpTransport(provider: ProviderId): DelegationMcpTransport {
  return getProviderDelegationPolicy(provider).mcpTransport;
}

function getDelegationBypassProviderPermissionId(provider: ProviderId): string {
  const permissions = getProviderPermissionOptions(provider);
  return permissions.find((permission) => permission.id === "bypass_all")?.id
    ?? permissions.find((permission) => permission.id === "yolo")?.id
    ?? getProviderDefaultPermission(provider);
}

export function resolveDelegationChildRuntimePermission(
  provider: ProviderId,
  selectedProviderPermissionId: string,
): DelegationChildRuntimePermission {
  const policy = getProviderDelegationPolicy(provider);
  if (policy.childRuntime.permissionPreset === "bypass_all") {
    return {
      providerPermissionId: getDelegationBypassProviderPermissionId(provider),
      permissionOverride: "bypass_all",
    };
  }

  return {
    providerPermissionId: selectedProviderPermissionId,
  };
}

export function resolveDelegationChildRuntimeSettings({
  parentSession,
  selectedProvider,
  selectedControls,
  selectedModel,
  selectedEffort,
  selectedProviderPermissionId,
}: ResolveDelegationChildRuntimeSettingsOptions): DelegationChildRuntimeSettings {
  const parentProviderState = resolveSessionProviderState(parentSession);
  const provider = parentSession ? parentProviderState.provider : selectedProvider;
  const inheritedControls = parentSession
    ? getProviderSelectedControlValues(parentProviderState, provider)
    : selectedControls ?? {};

  return {
    provider,
    selectedControls: inheritedControls,
    selectedModel: parentProviderState.selectedModel ?? selectedModel,
    selectedEffort: parentProviderState.selectedEffort ?? selectedEffort,
    selectedProviderPermissionId: parentSession
      ? getProviderPermissionId(parentProviderState, provider)
      : selectedProviderPermissionId ?? getProviderDefaultPermission(provider),
    inheritSkipOpenwolf: !!parentSession?.skipOpenwolf,
  };
}

export function buildDelegationMcpEnv({
  delegationPort,
  delegationSecret,
  groupId,
  agentLabel,
}: DelegationMcpConnection): Record<string, string> | undefined {
  if (delegationPort <= 0 || !delegationSecret) return undefined;
  return {
    T64_DELEGATION_PORT: String(delegationPort),
    T64_DELEGATION_SECRET: delegationSecret,
    T64_GROUP_ID: groupId,
    T64_AGENT_LABEL: agentLabel,
  };
}

export function buildDelegationChildProviderTurnInput({
  provider,
  sessionId,
  cwd,
  prompt,
  selectedModel,
  selectedEffort,
  selectedControls,
  selectedProviderPermissionId,
  inheritSkipOpenwolf,
  mcpConfigPath,
  mcpEnv,
}: DelegationChildTurnOptions): ProviderTurnInput {
  const policy = getProviderDelegationPolicy(provider);
  const permission = resolveDelegationChildRuntimePermission(provider, selectedProviderPermissionId);
  const providerOptions: ProviderTurnOptionsByProvider = {};
  if (provider === "anthropic") {
    const anthropicOptions = {
      ...(policy.mcpTransport === "temp-config" && mcpConfigPath ? { mcpConfig: mcpConfigPath } : {}),
      ...((policy.mcpTransport === "env" || policy.mcpTransport === "temp-config") && mcpEnv ? { mcpEnv } : {}),
      ...(policy.noSessionPersistence ? { noSessionPersistence: true } : {}),
    };
    if (Object.keys(anthropicOptions).length > 0) providerOptions.anthropic = anthropicOptions;
  } else if (provider === "openai") {
    const openAiOptions = {
      ...(policy.mcpTransport === "env" && mcpEnv ? { mcpEnv } : {}),
      ...(policy.skipGitRepoCheck ? { skipGitRepoCheck: true } : {}),
    };
    if (Object.keys(openAiOptions).length > 0) providerOptions.openai = openAiOptions;
  } else if (provider === "cursor") {
    const cursorOptions = {
      ...(policy.mcpTransport === "env" && mcpEnv ? { mcpEnv } : {}),
    };
    if (Object.keys(cursorOptions).length > 0) providerOptions.cursor = cursorOptions;
  }
  return {
    provider,
    sessionId,
    cwd,
    prompt,
    started: false,
    selectedControls,
    selectedModel,
    selectedEffort,
    providerPermissionId: permission.providerPermissionId,
    ...(permission.permissionOverride ? { permissionOverride: permission.permissionOverride } : {}),
    skipOpenwolf: policy.skipOpenwolf === "always" ? true : inheritSkipOpenwolf,
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  };
}

export function buildDelegationChildRuntimeMetadata(
  settings: DelegationChildRuntimeSettings,
  cwd: string,
): DelegationChildRuntimeMetadata {
  const permission = resolveDelegationChildRuntimePermission(
    settings.provider,
    settings.selectedProviderPermissionId,
  );
  return {
    providerId: settings.provider,
    model: settings.selectedModel,
    effort: settings.selectedEffort,
    providerPermissionId: permission.providerPermissionId,
    cwd,
    cleanupState: "active",
  };
}

export async function prepareDelegationChildProviderTurnInput({
  mcp,
  ...turnOptions
}: PrepareDelegationChildTurnOptions): Promise<ProviderTurnInput> {
  const mcpEnv = buildDelegationMcpEnv(mcp);

  return buildDelegationChildProviderTurnInput({
    ...turnOptions,
    ...(mcpEnv ? { mcpEnv } : {}),
  });
}
