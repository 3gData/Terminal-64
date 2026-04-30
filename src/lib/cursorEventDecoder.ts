import {
  buildProviderToolCall,
  buildProviderToolResult,
  isProviderRuntimeEvent,
  type NormalizedProviderEvent,
  providerRuntimeEventToNormalized,
  type ProviderRuntimeEvent,
  type ProviderToolCall,
  type ProviderToolInput,
} from "../contracts/providerEvents";

interface CursorContentBlock {
  type?: string;
  text?: string;
}

interface CursorMessage {
  role?: string;
  content?: CursorContentBlock[];
}

interface CursorToolCallShape {
  args?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  output?: unknown;
}

interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  permissionMode?: string;
  servers?: unknown[];
  mcp_servers?: unknown[];
  message?: CursorMessage;
  call_id?: string;
  tool_call?: Record<string, CursorToolCallShape>;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  error?: { message?: string } | string;
}

function textFromMessage(message: CursorMessage | undefined): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "")
    .join("");
}

function cursorToolName(toolCall: Record<string, CursorToolCallShape> | undefined): string {
  if (!toolCall) return "tool";
  const key = Object.keys(toolCall)[0] ?? "tool";
  const payload = toolCall[key];
  const args = payload?.args;
  const explicitName = args?.name ?? args?.toolName ?? args?.tool_name;
  return typeof explicitName === "string" && explicitName.trim() ? explicitName : key;
}

function cursorToolPayload(toolCall: Record<string, CursorToolCallShape> | undefined): CursorToolCallShape {
  if (!toolCall) return {};
  const key = Object.keys(toolCall)[0] ?? "tool";
  return toolCall[key] ?? {};
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeToolInput(name: string, args: Record<string, unknown> | undefined): ProviderToolInput {
  const nestedArguments = args?.arguments ?? args?.args;
  let parsedArguments: Record<string, unknown> | null = null;
  if (nestedArguments && typeof nestedArguments === "object" && !Array.isArray(nestedArguments)) {
    parsedArguments = nestedArguments as Record<string, unknown>;
  } else if (typeof nestedArguments === "string" && nestedArguments.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(nestedArguments) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsedArguments = parsed as Record<string, unknown>;
      }
    } catch {
      parsedArguments = null;
    }
  }
  const input: ProviderToolInput = parsedArguments ? { ...parsedArguments } : { ...(args ?? {}) };
  if (typeof args?.name === "string" && !input.name) input.name = args.name;
  if (typeof args?.toolName === "string" && !input.name) input.name = args.toolName;
  if (typeof args?.tool_name === "string" && !input.name) input.name = args.tool_name;
  const path = input.path ?? input.file ?? input.filePath;
  if (typeof path === "string") {
    input.path = path;
    input.file_path = path;
  }
  if (name === "shellToolCall" && typeof input.command !== "string" && typeof input.cmd === "string") {
    input.command = input.cmd;
  }
  return input;
}

function cursorToolCallToProvider(event: CursorStreamEvent): ProviderToolCall | null {
  const id = event.call_id;
  if (!id) return null;
  const name = cursorToolName(event.tool_call);
  const payload = cursorToolPayload(event.tool_call);
  return buildProviderToolCall({
    id,
    name,
    input: normalizeToolInput(name, payload.args),
  });
}

export class CursorLiveEventDecoder {
  private sessionsWithAssistantText = new Set<string>();

  resetSession(sessionId: string) {
    this.sessionsWithAssistantText.delete(sessionId);
  }

  private decodeRuntimeEvent(sessionId: string, event: ProviderRuntimeEvent): NormalizedProviderEvent[] {
    const normalized = providerRuntimeEventToNormalized(event);

    if (
      (event.type === "provider.session" && event.phase === "started")
      || (event.type === "provider.turn" && event.phase === "started")
    ) {
      this.sessionsWithAssistantText.delete(sessionId);
      return normalized;
    }

    if (event.type === "provider.content" && event.text) {
      this.sessionsWithAssistantText.add(sessionId);
      return normalized;
    }

    if (event.type === "provider.turn" && event.phase === "completed") {
      const events: NormalizedProviderEvent[] = [];
      if (event.isError) {
        const message = stringifyToolResult(event.error ?? event.message ?? event.result)
          || "Cursor reported an error.";
        events.push({ kind: "error", message });
      } else if (event.result !== undefined && !this.sessionsWithAssistantText.has(sessionId)) {
        const text = stringifyToolResult(event.result);
        if (text) events.push({ kind: "assistant_message", text });
      }
      events.push(...normalized);
      return events;
    }

    return normalized;
  }

  decode(sessionId: string, data: string): NormalizedProviderEvent[] {
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(data) as unknown;
    } catch (err) {
      console.warn("[cursor] Dropped malformed stream event:", data.slice(0, 200), err);
      return [];
    }

    if (isProviderRuntimeEvent(parsedUnknown)) {
      return this.decodeRuntimeEvent(sessionId, parsedUnknown);
    }

    const parsed = parsedUnknown as CursorStreamEvent;
    const type = parsed.type ?? "";
    if (!type) return [];

    if (type === "system" && parsed.subtype === "init") {
      this.sessionsWithAssistantText.delete(sessionId);
      return [
        {
          kind: "session_started",
          ...(parsed.session_id ? { threadId: parsed.session_id } : {}),
          ...(parsed.model ? { model: parsed.model } : {}),
        },
        { kind: "turn_started" },
      ];
    }

    if (type === "mcp_status" || type === "mcp.status.updated") {
      const servers = Array.isArray(parsed.servers)
        ? parsed.servers
        : Array.isArray(parsed.mcp_servers)
          ? parsed.mcp_servers
          : [];
      return servers.length > 0 ? [{ kind: "mcp_status", servers }] : [];
    }

    if (type === "assistant") {
      const text = textFromMessage(parsed.message);
      if (!text) return [];
      this.sessionsWithAssistantText.add(sessionId);
      return [{ kind: "assistant_delta", text }];
    }

    if (type === "tool_call" && parsed.subtype === "started") {
      const toolCall = cursorToolCallToProvider(parsed);
      return toolCall ? [{ kind: "tool_call", toolCall }] : [];
    }

    if (type === "tool_call" && parsed.subtype === "completed") {
      const id = parsed.call_id;
      if (!id) return [];
      const name = cursorToolName(parsed.tool_call);
      const payload = cursorToolPayload(parsed.tool_call);
      const result = stringifyToolResult(payload.result ?? payload.output ?? payload.error);
      return [{
        kind: "tool_result",
        toolResult: buildProviderToolResult({
          id,
          result,
          isError: payload.error !== undefined,
          patch: {
            name,
            input: normalizeToolInput(name, payload.args),
          },
        }),
      }];
    }

    if (type === "result") {
      const events: NormalizedProviderEvent[] = [];
      if (parsed.is_error) {
        events.push({
          kind: "error",
          message: parsed.result || "Cursor reported an error.",
        });
      } else if (parsed.result && !this.sessionsWithAssistantText.has(sessionId)) {
        events.push({
          kind: "assistant_message",
          text: parsed.result,
        });
      }
      events.push({
        kind: "turn_completed",
        ...(parsed.is_error ? { isError: true } : {}),
        ...(parsed.is_error && parsed.result ? { error: parsed.result } : {}),
      });
      return events;
    }

    if (type === "error") {
      const message = typeof parsed.error === "string"
        ? parsed.error
        : parsed.error?.message || parsed.result || "Cursor reported an error.";
      return [{ kind: "error", message }];
    }

    return [];
  }
}
