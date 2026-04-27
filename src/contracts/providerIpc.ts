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
