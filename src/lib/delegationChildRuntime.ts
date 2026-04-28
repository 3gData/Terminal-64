import type { ProviderTurnInput } from "../contracts/providerRuntime";
import type { ProviderSessionState } from "../stores/claudeStore";
import { getOpenAiProviderSessionMetadata, resolveSessionProviderState } from "../stores/claudeStore";
import type { ChatMessage, DelegationChildRuntimeMetadata } from "./types";
import { createMcpConfigFile } from "./tauriApi";
import { getProviderDelegationPolicy, getProviderManifest, type ProviderId } from "./providers";
import type { DelegationMcpTransport } from "./providers";

export type { DelegationMcpTransport } from "./providers";

interface DelegationParentSessionSource {
  providerState?: ProviderSessionState | undefined;
  provider?: ProviderId | undefined;
  codexThreadId?: string | null | undefined;
  seedTranscript?: ChatMessage[] | null | undefined;
  selectedModel?: string | null | undefined;
  selectedEffort?: string | null | undefined;
  selectedCodexPermission?: string | null | undefined;
  skipOpenwolf?: boolean | undefined;
}

export interface DelegationChildRuntimeSettings {
  provider: ProviderId;
  selectedModel: string;
  selectedEffort: string;
  selectedCodexPermission: string;
  inheritSkipOpenwolf: boolean;
}

export interface ResolveDelegationChildRuntimeSettingsOptions {
  parentSession?: DelegationParentSessionSource | undefined;
  selectedProvider: ProviderId;
  selectedModel: string;
  selectedEffort: string;
  selectedCodexPermission: string;
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

export function getDelegationMcpTransport(provider: ProviderId): DelegationMcpTransport {
  return getProviderDelegationPolicy(provider).mcpTransport;
}

export function resolveDelegationChildRuntimeSettings({
  parentSession,
  selectedProvider,
  selectedModel,
  selectedEffort,
  selectedCodexPermission,
}: ResolveDelegationChildRuntimeSettingsOptions): DelegationChildRuntimeSettings {
  const parentProviderState = resolveSessionProviderState(parentSession);
  const parentOpenAiMetadata = getOpenAiProviderSessionMetadata(parentProviderState);
  const provider = parentSession ? parentProviderState.provider : selectedProvider;

  return {
    provider,
    selectedModel: parentProviderState.selectedModel ?? selectedModel,
    selectedEffort: parentProviderState.selectedEffort ?? selectedEffort,
    selectedCodexPermission: parentOpenAiMetadata?.selectedCodexPermission
      ?? selectedCodexPermission
      ?? getProviderManifest("openai").defaultPermission,
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
  selectedCodexPermission,
  inheritSkipOpenwolf,
  mcpConfigPath,
  mcpEnv,
}: DelegationChildTurnOptions): ProviderTurnInput {
  const policy = getProviderDelegationPolicy(provider);
  return {
    provider,
    sessionId,
    cwd,
    prompt,
    started: false,
    selectedModel,
    selectedEffort,
    selectedCodexPermission,
    permissionOverride: "bypass_all",
    skipOpenwolf: policy.skipOpenwolf === "always" ? true : inheritSkipOpenwolf,
    ...(policy.mcpTransport === "temp-config" && mcpConfigPath ? { mcpConfig: mcpConfigPath } : {}),
    ...(policy.mcpTransport === "env" && mcpEnv ? { mcpEnv } : {}),
    ...(policy.noSessionPersistence ? { noSessionPersistence: true } : {}),
    ...(policy.skipGitRepoCheck ? { skipGitRepoCheck: true } : {}),
  };
}

export function buildDelegationChildRuntimeMetadata(
  settings: DelegationChildRuntimeSettings,
  cwd: string,
): DelegationChildRuntimeMetadata {
  const policy = getProviderDelegationPolicy(settings.provider);
  return {
    providerId: settings.provider,
    model: settings.selectedModel,
    effort: settings.selectedEffort,
    permissionPreset: policy.childRuntime.permissionPreset === "selected"
      ? settings.selectedCodexPermission
      : "bypass_all",
    cwd,
    cleanupState: "active",
  };
}

export async function prepareDelegationChildProviderTurnInput({
  mcp,
  ...turnOptions
}: PrepareDelegationChildTurnOptions): Promise<ProviderTurnInput> {
  const mcpEnv = buildDelegationMcpEnv(mcp);
  let mcpConfigPath = "";

  if (getDelegationMcpTransport(turnOptions.provider) === "temp-config" && mcpEnv) {
    mcpConfigPath = await createMcpConfigFile(
      mcp.delegationPort,
      mcp.delegationSecret,
      mcp.groupId,
      mcp.agentLabel,
    );
  }

  return buildDelegationChildProviderTurnInput({
    ...turnOptions,
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...(mcpEnv ? { mcpEnv } : {}),
  });
}
