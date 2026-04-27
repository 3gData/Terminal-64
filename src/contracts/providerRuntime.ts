import type { ChatMessage, PermissionMode } from "../lib/types";
import type { ProviderId } from "../lib/providers";

export interface ProviderTurnInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  prompt: string;
  started: boolean;
  threadId?: string | null;
  selectedModel?: string | null | undefined;
  selectedEffort?: string | null | undefined;
  selectedCodexPermission?: string | null | undefined;
  permissionMode?: PermissionMode | undefined;
  permissionOverride?: PermissionMode | undefined;
  skipOpenwolf?: boolean | undefined;
  seedTranscript?: ChatMessage[] | null | undefined;
  resumeAtUuid?: string | null | undefined;
  forkParentSessionId?: string | null | undefined;
  codexCollaborationMode?: "plan" | "default" | undefined;
  disallowedTools?: string | undefined;
  mcpConfig?: string | undefined;
  mcpEnv?: Record<string, string> | undefined;
  noSessionPersistence?: boolean | undefined;
  skipGitRepoCheck?: boolean | undefined;
}

export interface ProviderTurnResult {
  clearSeedTranscript?: boolean;
  clearResumeAtUuid?: boolean;
  clearForkParentSessionId?: boolean;
}

export interface ProviderHistoryTruncateInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  keepMessages: number;
  preMessages: ChatMessage[];
  codexThreadId?: string | null | undefined;
}

export interface ProviderHistoryTruncateResult {
  resumeAtUuid?: string | null;
}

export interface ProviderForkInput {
  provider: ProviderId;
  parentSessionId: string;
  newSessionId: string;
  cwd: string;
  keepMessages: number;
  preMessages: ChatMessage[];
  codexThreadId?: string | null | undefined;
}

export interface ProviderForkResult {
  codexThreadId?: string | null;
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
  codexThreadId?: string | null | undefined;
  cacheEntry?: ProviderHydrationCacheEntry | null | undefined;
}

export interface ProviderHistoryDeleteInput {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  codexThreadId?: string | null | undefined;
}

export interface ProviderHistoryDeleteResult {
  method: "deleted" | "skipped";
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
  };

export interface ProviderRuntime {
  provider: ProviderId;
  create: (input: ProviderTurnInput) => Promise<ProviderTurnResult>;
  send: (input: ProviderTurnInput) => Promise<ProviderTurnResult>;
  cancel: (sessionId: string) => Promise<void>;
  close: (sessionId: string) => Promise<void>;
  rewind: (input: ProviderHistoryTruncateInput) => Promise<ProviderHistoryTruncateResult>;
  fork: (input: ProviderForkInput) => Promise<ProviderForkResult>;
  hydrate: (input: ProviderHydrateInput) => Promise<ProviderHydrateResult>;
  deleteHistory: (input: ProviderHistoryDeleteInput) => Promise<ProviderHistoryDeleteResult>;
}
