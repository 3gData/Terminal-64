import {
  buildProviderToolCall,
  buildProviderToolResult,
  type ProviderToolCall,
  type ProviderToolResult,
} from "../contracts/providerEvents";

export interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

export interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ClaudeContentBlock[];
  tool_use_id?: string;
  is_error?: boolean;
  parentToolUseId?: string;
}

export interface ClaudeQuestion {
  question?: string;
  text?: string;
  description?: string;
  header?: string;
  options?: (string | { label?: string; description?: string })[];
  multiSelect?: boolean;
}

export interface ClaudeMcpServerRaw {
  name?: string;
  status?: string;
  error?: string;
  type?: string;
  transport?: string;
  scope?: string;
  tools?: { name?: string; description?: string }[];
}

export interface ClaudeModelUsageEntry {
  contextWindow?: number;
  [key: string]: unknown;
}

export interface PermissionRequestPayload {
  request_id: string;
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface ClaudeAttachment {
  type: string;
  message?: string;
  path?: string;
  stderr?: string;
  max_turns?: number;
}

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  event?: ClaudeStreamEvent;
  parent_tool_use_id?: string;
  model?: string;
  mcp_servers?: ClaudeMcpServerRaw[];
  content_block?: { type: string; id?: string; name?: string; thinking?: string };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
  };
  message?: {
    content?: ClaudeContentBlock[];
    usage?: ClaudeUsage;
    stop_reason?: string;
    attachments?: ClaudeAttachment[];
  };
  content?: ClaudeContentBlock[];
  usage?: ClaudeUsage;
  total_cost_usd?: number;
  output_tokens?: number;
  is_error?: boolean;
  result?: string;
  modelUsage?: Record<string, ClaudeModelUsageEntry>;
  error?: { type?: string; message?: string } | string;
  message_text?: string;
}

export function getClaudeContextWindowForModel(model: string): number {
  if (/\[1m\]|-1m\b|:1m\b/i.test(model)) return 1_000_000;
  return 200_000;
}

export function claudeBlockToProviderToolCall(
  block: ClaudeContentBlock,
  parentToolUseId?: string,
): ProviderToolCall | null {
  if (block.type !== "tool_use" || !block.id) return null;
  return buildProviderToolCall({
    id: block.id,
    name: block.name ?? "",
    input: block.input ?? {},
    ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
  });
}

export function claudeToolResultText(block: ClaudeContentBlock): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((contentBlock) => contentBlock.type === "text" ? contentBlock.text : JSON.stringify(contentBlock))
      .join("\n");
  }
  return JSON.stringify(block.content);
}

export function claudeBlockToProviderToolResult(block: ClaudeContentBlock): ProviderToolResult | null {
  if (block.type !== "tool_result" || !block.tool_use_id) return null;
  return buildProviderToolResult({
    id: block.tool_use_id,
    result: claudeToolResultText(block),
    isError: block.is_error || false,
  });
}
