import type { ChatMessage, PermissionMode } from "../lib/types";
import type { ProviderControlValue, ProviderHistorySource, ProviderId } from "../lib/providers";

export type ProviderCollaborationMode = "plan" | "default";

export interface AnthropicTurnOptions {
  disallowedTools?: string | undefined;
  mcpConfig?: string | undefined;
  mcpEnv?: Record<string, string> | undefined;
  noSessionPersistence?: boolean | undefined;
}

export interface OpenAiTurnOptions {
  collaborationMode?: ProviderCollaborationMode | undefined;
  mcpEnv?: Record<string, string> | undefined;
  skipGitRepoCheck?: boolean | undefined;
}

export interface CursorTurnOptions {
  mcpEnv?: Record<string, string> | undefined;
}

export interface ProviderTurnOptionsByProvider {
  anthropic?: AnthropicTurnOptions | undefined;
  openai?: OpenAiTurnOptions | undefined;
  cursor?: CursorTurnOptions | undefined;
}

export type ProviderTurnOptionsFor<TProvider extends ProviderId = ProviderId> =
  Pick<ProviderTurnOptionsByProvider, TProvider>;

export interface ProviderTurnInput<TProvider extends ProviderId = ProviderId> {
  provider: TProvider;
  sessionId: string;
  cwd: string;
  prompt: string;
  started: boolean;
  runtimeMetadata?: ProviderSessionRuntimeMetadata | undefined;
  /** @deprecated Use runtimeMetadata.resume.id for provider-owned resume/thread ids. */
  threadId?: string | null;
  selectedControls?: Record<string, ProviderControlValue> | undefined;
  /** @deprecated Use selectedControls and provider control descriptors. */
  selectedModel?: string | null | undefined;
  /** @deprecated Use selectedControls and provider control descriptors. */
  selectedEffort?: string | null | undefined;
  providerPermissionId?: string | null | undefined;
  permissionMode?: PermissionMode | undefined;
  permissionOverride?: PermissionMode | undefined;
  skipOpenwolf?: boolean | undefined;
  seedTranscript?: ChatMessage[] | null | undefined;
  resumeAtUuid?: string | null | undefined;
  forkParentSessionId?: string | null | undefined;
  providerOptions?: ProviderTurnOptionsFor<TProvider> | undefined;
}

export interface ProviderTurnResult {
  clearSeedTranscript?: boolean;
  clearResumeAtUuid?: boolean;
  clearForkParentSessionId?: boolean;
}

export interface ProviderSessionResumeMetadata {
  id: string | null;
}

export interface ProviderSessionRuntimeMetadata {
  historySource: ProviderHistorySource;
  resume: ProviderSessionResumeMetadata;
  runtimePayload: Record<string, unknown>;
}

export type ProviderSessionRuntimeMetadataMap = Partial<Record<ProviderId, ProviderSessionRuntimeMetadata>>;

export function getProviderTurnResumeId(input: Pick<ProviderTurnInput, "runtimeMetadata" | "threadId">): string | null {
  const runtimeResumeId = input.runtimeMetadata?.resume.id;
  if (runtimeResumeId) return runtimeResumeId;
  return input.threadId ?? null;
}

export function hasProviderTurnResumeId(input: Pick<ProviderTurnInput, "runtimeMetadata" | "threadId">): boolean {
  return getProviderTurnResumeId(input) !== null;
}

export interface ProviderSessionRuntimeMetadataPatch {
  historySource?: ProviderHistorySource | undefined;
  resume?: ProviderSessionResumeMetadata | null | undefined;
  runtimePayload?: Record<string, unknown> | undefined;
}

export type ProviderHistoryCapability = "hydrate" | "fork" | "rewind" | "delete";

export interface ProviderHistoryCapabilities {
  hydrate: boolean;
  fork: boolean;
  rewind: boolean;
  delete: boolean;
}

export type ProviderHistoryOperationStatus = "applied" | "skipped" | "unsupported";

export interface ProviderHistoryOperationResult {
  status?: ProviderHistoryOperationStatus;
  reason?: string;
}

export interface ProviderHistoryTruncateInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  keepMessages: number;
  preMessages: ChatMessage[];
}

export interface ProviderHistoryTruncateResult extends ProviderHistoryOperationResult {
  resumeAtUuid?: string | null;
}

export interface ProviderForkInput {
  provider: ProviderId;
  parentSessionId: string;
  newSessionId: string;
  cwd: string;
  keepMessages: number;
  preMessages: ChatMessage[];
}

export interface ProviderForkResult extends ProviderHistoryOperationResult {
  seedTranscript?: boolean;
}

export interface ProviderHydrationCacheEntry {
  mtimeMs: number;
  size: number;
  messages: ChatMessage[];
}

export interface ProviderHydrateInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  resumeAtUuid?: string | null | undefined;
  cacheEntry?: ProviderHydrationCacheEntry | null | undefined;
}

export interface ProviderHistoryDeleteInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
}

export interface ProviderHistoryDeleteResult extends ProviderHistoryOperationResult {
  method: "deleted" | "skipped" | "unsupported";
  reason?: string;
}

export type ProviderHydrateResult =
  | {
    status: "messages";
    messages: ChatMessage[];
    cacheWrite?: ProviderHydrationCacheEntry;
    clearCache?: boolean;
  }
  | {
    status: "empty";
    clearCache?: boolean;
  }
  | {
    status: "skipped" | "unsupported";
    reason?: string;
    clearCache?: boolean;
  };

export interface ProviderHistoryRuntime {
  source: ProviderHistorySource;
  capabilities: ProviderHistoryCapabilities;
  rewind?: (input: ProviderHistoryTruncateInput) => Promise<ProviderHistoryTruncateResult>;
  fork?: (input: ProviderForkInput) => Promise<ProviderForkResult>;
  hydrate?: (input: ProviderHydrateInput) => Promise<ProviderHydrateResult>;
  deleteHistory?: (input: ProviderHistoryDeleteInput) => Promise<ProviderHistoryDeleteResult>;
}

export interface ProviderRuntime<TProvider extends ProviderId = ProviderId> {
  provider: TProvider;
  prepareTurn?: (input: ProviderTurnInput<TProvider>) => Promise<ProviderTurnInput<TProvider>> | ProviderTurnInput<TProvider>;
  create: (input: ProviderTurnInput<TProvider>) => Promise<ProviderTurnResult>;
  send: (input: ProviderTurnInput<TProvider>) => Promise<ProviderTurnResult>;
  cancel: (sessionId: string) => Promise<void>;
  close: (sessionId: string) => Promise<void>;
  history: ProviderHistoryRuntime;
}
