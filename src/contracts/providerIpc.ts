import type { CreateClaudeRequest, SendClaudePromptRequest } from "../lib/types";
import type { ProviderId } from "../lib/providers";

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

export type ProviderCreateRequest =
  | { provider: "anthropic"; req: CreateClaudeRequest }
  | { provider: "openai"; req: CreateCodexRequest };

export type ProviderSendRequest =
  | { provider: "anthropic"; req: SendClaudePromptRequest }
  | { provider: "openai"; req: SendCodexPromptRequest };

export interface ProviderSessionRequest {
  provider: ProviderId;
  sessionId: string;
}

export type ProviderHistoryTruncateRequest =
  | {
    provider: "anthropic";
    req: {
      session_id: string;
      cwd: string;
      keep_messages: number;
    };
  }
  | {
    provider: "openai";
    req: {
      thread_id: string;
      cwd: string;
      num_turns: number;
    };
  };

export interface ProviderHistoryTruncateIpcResult {
  resume_at_uuid?: string | null;
  method?: string;
  turns?: number;
  details?: unknown;
  rollback_error?: string;
}

export type ProviderHistoryForkRequest =
  | {
    provider: "anthropic";
    req: {
      parent_session_id: string;
      new_session_id: string;
      cwd: string;
      keep_messages: number;
    };
  }
  | {
    provider: "openai";
    req: {
      thread_id: string;
      cwd: string;
      drop_turns: number;
    };
  };

export interface ProviderHistoryForkIpcResult {
  resume_at_uuid?: string | null;
  codex_thread_id?: string | null;
}

export type ProviderHistoryHydrateRequest =
  | {
    provider: "anthropic";
    req: {
      session_id: string;
      cwd: string;
    };
  }
  | {
    provider: "openai";
    req: {
      thread_id: string;
    };
  };

export type ProviderHistoryDeleteRequest =
  | {
    provider: "anthropic";
    req: {
      session_id: string;
      cwd: string;
    };
  }
  | {
    provider: "openai";
    req: {
      thread_id?: string | null;
    };
  };

export interface ProviderHistoryDeleteIpcResult {
  method: "deleted" | "skipped";
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
