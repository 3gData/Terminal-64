import type { ProviderId } from "../lib/providers";

export type ProviderIpcPayload = unknown;

export interface ProviderIpcRequestEnvelope<
  TProvider extends string = ProviderId,
  TRequest = ProviderIpcPayload,
> {
  provider: TProvider;
  req: TRequest;
}

export interface ProviderCreateRequestMap {}
export interface ProviderSendRequestMap {}
export interface ProviderHistoryTruncateRequestMap {}
export interface ProviderHistoryForkRequestMap {}
export interface ProviderHistoryHydrateRequestMap {}
export interface ProviderHistoryDeleteRequestMap {}

type ProviderRequestPayload<TMap, TProvider extends ProviderId> =
  TProvider extends keyof TMap ? TMap[TProvider] : never;

type ProviderMappedRequest<TMap, TProvider extends ProviderId = ProviderId> =
  TProvider extends ProviderId
    ? ProviderIpcRequestEnvelope<TProvider, ProviderRequestPayload<TMap, TProvider>>
    : never;

export interface CreateCodexRequest {
  session_id: string;
  cwd: string;
  prompt: string;
  sandbox_mode?: string;
  approval_policy?: string;
  model?: string;
  effort?: string;
  full_auto?: boolean;
  yolo?: boolean;
  skip_git_repo_check?: boolean;
  mcp_env?: Record<string, string>;
  collaboration_mode?: "plan" | "default";
}

export type ProviderCreateRequest<TProvider extends ProviderId = ProviderId> =
  ProviderMappedRequest<ProviderCreateRequestMap, TProvider>;

export type ProviderSendRequest<TProvider extends ProviderId = ProviderId> =
  ProviderMappedRequest<ProviderSendRequestMap, TProvider>;

export interface ProviderSessionRequest<TProvider extends ProviderId = ProviderId> {
  provider: TProvider;
  sessionId: string;
}

export type ProviderHistoryTruncateRequest<TProvider extends ProviderId = ProviderId> =
  ProviderMappedRequest<ProviderHistoryTruncateRequestMap, TProvider>;

export type ProviderHistoryOperationStatus = "applied" | "skipped" | "unsupported";

export interface ProviderHistoryTruncateIpcResult {
  status?: ProviderHistoryOperationStatus;
  resume_at_uuid?: string | null;
  method?: string;
  turns?: number;
  details?: unknown;
  reason?: string;
  rollback_error?: string;
}

export type ProviderHistoryForkRequest<TProvider extends ProviderId = ProviderId> =
  ProviderMappedRequest<ProviderHistoryForkRequestMap, TProvider>;

export interface ProviderHistoryForkIpcResult {
  status?: ProviderHistoryOperationStatus;
  resume_at_uuid?: string | null;
  codex_thread_id?: string | null;
  reason?: string;
}

export type ProviderHistoryHydrateRequest<TProvider extends ProviderId = ProviderId> =
  ProviderMappedRequest<ProviderHistoryHydrateRequestMap, TProvider>;

export type ProviderHistoryHydrateIpcStatus = "messages" | "empty" | "skipped" | "unsupported";

export type ProviderHistoryDeleteRequest<TProvider extends ProviderId = ProviderId> =
  ProviderMappedRequest<ProviderHistoryDeleteRequestMap, TProvider>;

export interface ProviderHistoryDeleteIpcResult {
  status?: ProviderHistoryOperationStatus;
  method: "deleted" | "skipped" | "unsupported";
  reason?: string;
}

export interface SendCodexPromptRequest {
  session_id: string;
  thread_id?: string;
  cwd: string;
  prompt: string;
  sandbox_mode?: string;
  approval_policy?: string;
  model?: string;
  effort?: string;
  full_auto?: boolean;
  yolo?: boolean;
  skip_git_repo_check?: boolean;
  mcp_env?: Record<string, string>;
  collaboration_mode?: "plan" | "default";
}

export interface CreateCursorRequest {
  session_id: string;
  thread_id?: string;
  cwd: string;
  prompt: string;
  model?: string;
  mode?: "ask" | "plan";
  permission_mode?: string;
  force?: boolean;
  mcp_env?: Record<string, string>;
}

export interface SendCursorPromptRequest {
  session_id: string;
  thread_id?: string;
  cwd: string;
  prompt: string;
  model?: string;
  mode?: "ask" | "plan";
  permission_mode?: string;
  force?: boolean;
  mcp_env?: Record<string, string>;
}
