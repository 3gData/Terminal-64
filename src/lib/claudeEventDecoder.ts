import {
  buildProviderToolCall,
  buildProviderToolResult,
  type NormalizedProviderEvent,
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

function totalClaudeInputTokens(usage: ClaudeUsage | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
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

interface PendingClaudeBlock {
  id: string;
  type: string;
  name?: string;
  inputJson: string;
  parentToolUseId?: string;
}

function eventWithDefined<T extends NormalizedProviderEvent>(event: T): T {
  return event;
}

export class ClaudeLiveEventDecoder {
  private readonly pendingBlocks = new Map<string, PendingClaudeBlock[]>();
  private readonly assistantFinalized = new Set<string>();

  resetSession(sessionId: string) {
    this.pendingBlocks.delete(sessionId);
    this.assistantFinalized.delete(sessionId);
  }

  decode(sessionId: string, data: string): NormalizedProviderEvent[] {
    let parsed: ClaudeStreamEvent;
    try {
      parsed = JSON.parse(data) as ClaudeStreamEvent;
    } catch (err) {
      console.warn("[claude] Failed to parse event:", data.slice(0, 200), err);
      return [{
        kind: "error",
        message: "Failed to parse Claude response - the session may need to be restarted.",
        terminal: false,
      }];
    }

    let streamParentToolUseId: string | undefined;
    if (parsed.type === "stream_event" && parsed.event) {
      streamParentToolUseId = parsed.parent_tool_use_id;
      parsed = parsed.event;
    }

    const type = parsed.type;

    if (type === "system" && parsed.subtype === "init") {
      const model = String(parsed.model || "");
      const events: NormalizedProviderEvent[] = [
        eventWithDefined({
          kind: "session_started",
          model,
          contextMax: getClaudeContextWindowForModel(model),
        }),
      ];
      if (Array.isArray(parsed.mcp_servers)) {
        events.push({ kind: "mcp_status", servers: parsed.mcp_servers });
      }
      return events;
    }

    if (type === "error") {
      const message =
        typeof parsed.error === "string"
          ? parsed.error
          : parsed.error?.message || parsed.result || parsed.message_text || "Claude reported an error.";
      this.resetSession(sessionId);
      return [{ kind: "error", message }];
    }

    if (type === "stream_request_start") {
      this.resetSession(sessionId);
      return [{ kind: "turn_started" }];
    }

    if (type === "content_block_start") {
      const cb = parsed.content_block;
      if (cb?.type === "tool_use" && cb.id && cb.name) {
        const blocks = this.pendingBlocks.get(sessionId) || [];
        blocks.push({
          id: cb.id,
          type: "tool_use",
          name: cb.name,
          inputJson: "",
          ...(streamParentToolUseId !== undefined ? { parentToolUseId: streamParentToolUseId } : {}),
        });
        this.pendingBlocks.set(sessionId, blocks);
      }
      return [];
    }

    if (type === "content_block_delta") {
      const d = parsed.delta;
      if (d?.type === "text_delta" && d.text) {
        return [{ kind: "assistant_delta", text: d.text }];
      }
      if (d?.type === "input_json_delta" && d.partial_json) {
        const blocks = this.pendingBlocks.get(sessionId);
        const last = blocks && blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
        if (last && last.type === "tool_use") {
          last.inputJson += d.partial_json;
        }
      }
      return [];
    }

    if (type === "message_start") {
      this.pendingBlocks.delete(sessionId);
      this.assistantFinalized.delete(sessionId);
      return [{ kind: "turn_started", resetStreamingText: true }];
    }

    if (type === "assistant") {
      const events: NormalizedProviderEvent[] = [];
      const usage = parsed.message?.usage || parsed.usage;
      const inputTokens = totalClaudeInputTokens(usage);
      if (inputTokens > 0) {
        events.push({ kind: "usage", inputTokens });
      }

      const content = parsed.message?.content || parsed.content;
      if (Array.isArray(content)) {
        const decoded = this.decodeContentArray(content);
        events.push(decoded);
        this.assistantFinalized.add(sessionId);
        this.pendingBlocks.delete(sessionId);
      }
      return events;
    }

    if (type === "message_stop") {
      if (this.assistantFinalized.has(sessionId)) {
        this.resetSession(sessionId);
        return [];
      }

      const toolCalls = this.pendingToolCalls(sessionId);
      this.resetSession(sessionId);
      return [{
        kind: "assistant_message",
        text: "",
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        useBufferedText: true,
      }];
    }

    if (type === "message_delta") {
      const events: NormalizedProviderEvent[] = [];
      const inputTokens = totalClaudeInputTokens(parsed.usage);
      if (inputTokens > 0) {
        events.push({ kind: "usage", inputTokens });
      }
      const stopReason = parsed.delta?.stop_reason;
      if (stopReason === "refusal") {
        events.push({ kind: "error", message: "Claude declined to continue (policy refusal).", terminal: false });
      } else if (stopReason === "max_tokens") {
        events.push({ kind: "error", message: "Response cut off - hit max_tokens. Ask Claude to continue.", terminal: false });
      }
      return events;
    }

    if (type === "user") {
      const events: NormalizedProviderEvent[] = [];
      const content = parsed.message?.content || parsed.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const toolResult = claudeBlockToProviderToolResult(block);
          if (toolResult) events.push({ kind: "tool_result", toolResult });
        }
      }
      this.resetSession(sessionId);
      return events;
    }

    if (type === "result") {
      const resultUsage = parsed.usage || {};
      const inputTokens = totalClaudeInputTokens(resultUsage);
      const outputTokens = resultUsage.output_tokens || parsed.output_tokens || 0;
      let contextMax: number | undefined;
      if (parsed.modelUsage) {
        for (const modelData of Object.values(parsed.modelUsage)) {
          if (modelData?.contextWindow && modelData.contextWindow > 0) {
            contextMax = modelData.contextWindow;
            break;
          }
        }
      }
      const message = parsed.is_error && parsed.result ? parsed.result : undefined;
      this.resetSession(sessionId);
      return [eventWithDefined({
        kind: "turn_completed",
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(parsed.total_cost_usd !== undefined ? { costUsd: parsed.total_cost_usd } : {}),
        ...(contextMax !== undefined ? { contextMax } : {}),
        ...(parsed.is_error !== undefined ? { isError: parsed.is_error } : {}),
        ...(message !== undefined ? { error: message } : {}),
      })];
    }

    return [];
  }

  private decodeContentArray(content: ClaudeContentBlock[]): NormalizedProviderEvent {
    let text = "";
    const toolCalls: ProviderToolCall[] = [];
    for (const block of content) {
      if (block.type === "text") {
        text += block.text || "";
      } else if (block.type === "tool_use") {
        const toolCall = claudeBlockToProviderToolCall(block, block.parentToolUseId);
        if (toolCall) toolCalls.push(toolCall);
      }
    }
    return {
      kind: "assistant_message",
      text: text.trim(),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private pendingToolCalls(sessionId: string): ProviderToolCall[] {
    const blocks = this.pendingBlocks.get(sessionId) || [];
    const toolCalls: ProviderToolCall[] = [];
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(block.inputJson || "{}") as Record<string, unknown>;
      } catch {
        input = {};
      }
      const toolCall = claudeBlockToProviderToolCall({
        type: "tool_use",
        id: block.id,
        input,
        ...(block.name !== undefined ? { name: block.name } : {}),
        ...(block.parentToolUseId !== undefined ? { parentToolUseId: block.parentToolUseId } : {}),
      });
      if (toolCall) toolCalls.push(toolCall);
    }
    return toolCalls;
  }
}
