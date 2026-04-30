import type {
  NormalizedProviderEvent,
  ProviderToolCall,
  ProviderToolResult,
} from "../contracts/providerEvents";
import type { ProviderId } from "./providers";

export type ProviderSemanticTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface ProviderSemanticMcpTool {
  name: string;
  description?: string;
}

export interface ProviderSemanticMcpServerStatus {
  name: string;
  status: string;
  error?: string;
  transport?: string;
  scope?: string;
  tools?: ProviderSemanticMcpTool[];
  toolCount?: number;
}

export interface ProviderSemanticQuestionOption {
  label: string;
  description?: string;
}

export interface ProviderSemanticPendingQuestionItem {
  question: string;
  header?: string;
  options: ProviderSemanticQuestionOption[];
  multiSelect: boolean;
}

export interface ProviderSemanticTask {
  id: string;
  subject: string;
  description?: string;
  status: ProviderSemanticTaskStatus;
}

export interface ProviderDelegationTask {
  description: string;
}

export interface ProviderDelegationRequest {
  context: string;
  tasks: ProviderDelegationTask[];
}

export type ProviderDelegationRequestSource = "tool" | "json_tag" | "legacy_block";

export type ProviderSemanticEvent =
  | { kind: "mcp_status"; servers: ProviderSemanticMcpServerStatus[] }
  | { kind: "tool_visibility"; toolId: string; toolName: string; hidden: boolean }
  | { kind: "plan_mode"; active: boolean; toolId: string }
  | { kind: "pending_questions"; toolUseId: string; items: ProviderSemanticPendingQuestionItem[] }
  | { kind: "task_created"; task: ProviderSemanticTask }
  | {
      kind: "task_updated";
      taskId: string;
      update: Partial<Pick<ProviderSemanticTask, "subject" | "description" | "status">>;
    }
  | { kind: "task_id_resolved"; oldTaskId: string; newTaskId: string }
  | { kind: "modified_files"; toolResultId: string; paths: string[] }
  | {
      kind: "delegation_request";
      request: ProviderDelegationRequest;
      source: ProviderDelegationRequestSource;
      toolId?: string;
    };

export interface ProviderEventSemanticProjection {
  visibleEvent: NormalizedProviderEvent | null;
  semanticEvents: ProviderSemanticEvent[];
}

export interface ProviderEventSemanticProjectorInput {
  sessionId: string;
  provider: ProviderId;
  event: NormalizedProviderEvent;
}

export interface RememberToolOptions {
  trackModifiedFileInput?: boolean;
}

export interface ProviderEventSemanticProjectorContext {
  rememberToolCall(toolCall: ProviderToolCall, options?: RememberToolOptions): void;
  rememberToolName(toolId: string, toolName: string): void;
  rememberToolPatch(toolId: string, result: ProviderToolResult, options?: RememberToolOptions): void;
  toolNameForId(toolId: string): string | undefined;
  changedPathsForToolResult(toolResult: ProviderToolResult): string[];
}

export type ProviderEventSemanticProjector = (
  input: ProviderEventSemanticProjectorInput,
  context: ProviderEventSemanticProjectorContext,
) => ProviderEventSemanticProjection;

export interface ProviderDelegationRequestEvent {
  sessionId: string;
  provider: ProviderId;
  request: ProviderDelegationRequest;
  source: ProviderDelegationRequestSource;
  toolId?: string;
}
