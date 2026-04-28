import {
  buildProviderToolCall,
  buildProviderToolResult,
  type NormalizedProviderEvent,
  providerToolChangedPaths,
  type ProviderToolCall,
  type ProviderToolChange,
  type ProviderToolInput,
  type ProviderToolPatch,
  type ProviderToolResult,
} from "../contracts/providerEvents";

export interface CodexItem {
  id?: string;
  item_type?: string;
  type?: string;
  text?: string;
  command?: string | string[];
  args?: string[];
  exit_code?: number;
  path?: string;
  file_path?: string;
  filePath?: string;
  change?: string;
  diff?: string;
  unified_diff?: string;
  unifiedDiff?: string;
  changes?: Array<{
    path?: string;
    file_path?: string;
    filePath?: string;
    diff?: string;
    unified_diff?: string;
    unifiedDiff?: string;
    kind?: string | { type?: string; move_path?: string | null };
  }>;
  tool_name?: string;
  server?: string;
  query?: string;
  action?: { type?: string; query?: string; queries?: string[] };
  output?: unknown;
  status?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexNdjsonEvent {
  type: string;
  thread_id?: string;
  threadId?: string;
  turn_id?: string;
  message?: string;
  text?: string;
  delta?: string;
  error?: { message?: string } | string;
  item?: CodexItem;
  command?: string;
  output?: string;
  result?: unknown;
  usage?: CodexUsage;
  payload?: { usage?: CodexUsage };
  context_window?: number | null;
}

export interface CodexPendingItem {
  itemId: string;
  kind: "agent_message" | "reasoning" | "tool" | "other";
  toolName: string;
  text: string;
  outputText: string;
  inputArgs: Record<string, unknown>;
}

function appendOrReplaceAccumulated(prev: string, next: string): string {
  if (!next) return prev;
  if (!prev) return next;
  if (next.startsWith(prev)) return next;
  return prev + next;
}

export function classifyCodexItem(itemType: string | undefined): CodexPendingItem["kind"] {
  if (!itemType) return "other";
  if (itemType === "agent_message" || itemType === "assistant_message") return "agent_message";
  if (itemType === "reasoning" || itemType === "agent_reasoning") return "reasoning";
  if (
    itemType === "command_execution" ||
    itemType === "local_shell_call" ||
    itemType === "file_change" ||
    itemType === "mcp_tool_call" ||
    itemType === "collab_tool_call" ||
    itemType === "custom_tool_call" ||
    itemType === "web_search" ||
    itemType === "web_search_call" ||
    itemType === "dynamic_tool_call"
  ) {
    return "tool";
  }
  return "other";
}

function codexCommandString(item: CodexItem): string {
  if (typeof item.command === "string") return item.command;
  if (Array.isArray(item.command)) return item.command.join(" ");
  if (Array.isArray(item.args)) return item.args.join(" ");
  return "";
}

function codexRawToolName(item: CodexItem): string {
  return String(item.name || item.tool_name || "");
}

function codexIsShellTool(item: CodexItem): boolean {
  const raw = codexRawToolName(item);
  return raw === "exec_command" || raw === "write_stdin" || raw === "local_shell" || raw === "shell";
}

function codexBasename(p: string): string {
  const m = p.split(/[/\\]/).filter(Boolean);
  return m.length > 0 ? m[m.length - 1]! : p;
}

function codexChangePath(change: NonNullable<CodexItem["changes"]>[number]): string | undefined {
  return change.path || change.file_path || change.filePath;
}

function codexChangeDiff(change: NonNullable<CodexItem["changes"]>[number]): string | undefined {
  return change.diff || change.unified_diff || change.unifiedDiff;
}

function codexNormalizedChange(change: NonNullable<CodexItem["changes"]>[number]): ProviderToolChange {
  const out: ProviderToolChange = {};
  const path = codexChangePath(change);
  if (path) {
    out.path = path;
    out.file_path = path;
  }
  const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
  if (kind) out.kind = kind;
  if (typeof change.kind === "object" && (typeof change.kind.move_path === "string" || change.kind.move_path === null)) {
    out.move_path = change.kind.move_path;
  }
  const diff = codexChangeDiff(change);
  if (diff) out.diff = diff;
  return out;
}

export function codexItemDisplayName(item: CodexItem): string {
  const kind = item.item_type ?? item.type ?? "";
  if (kind === "command_execution" || kind === "local_shell_call") {
    return "Bash";
  }
  if (kind === "file_change") {
    const paths = Array.isArray(item.changes)
      ? item.changes.map(codexChangePath).filter(Boolean)
      : [];
    const allPaths = [item.path || item.file_path || item.filePath, ...paths].filter(Boolean);
    if (new Set(allPaths).size > 1) return "MultiEdit";
    return "Edit";
  }
  if (kind === "mcp_tool_call") {
    if (item.server && item.tool_name) return `${item.server}/${item.tool_name}`;
    return item.tool_name || item.name || "mcp_tool";
  }
  if (kind === "custom_tool_call" && item.name === "apply_patch") {
    return "Edit";
  }
  if ((kind === "custom_tool_call" || kind === "dynamic_tool_call") && codexIsShellTool(item)) {
    return "Bash";
  }
  if (kind === "web_search" || kind === "web_search_call") {
    return "WebSearch";
  }
  return item.name || kind || "tool";
}

export function codexItemInput(item: CodexItem): ProviderToolInput {
  const kind = item.item_type ?? item.type ?? "";
  const out: Record<string, unknown> = {};

  if (kind === "command_execution" || kind === "local_shell_call") {
    const cmd = codexCommandString(item);
    if (cmd) out.command = cmd;
  } else if (kind === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.map(codexChangePath).filter((path): path is string => Boolean(path));
    const primaryPath = item.path || item.file_path || item.filePath || paths[0];
    if (primaryPath) {
      out.file_path = primaryPath;
      out.path = primaryPath;
      out.display_path = codexBasename(primaryPath);
    }
    if (paths.length > 0) {
      out.paths = paths;
    }
    if (changes.length > 0) {
      out.changes = changes.map(codexNormalizedChange);
    }
    if (item.change) out.change = item.change;
    const diff = item.diff || item.unified_diff || item.unifiedDiff;
    if (diff) out.diff = diff;
  } else if (kind === "mcp_tool_call") {
    if (item.tool_name) out.tool_name = item.tool_name;
    if (item.server) out.server = item.server;
    if (item.arguments && typeof item.arguments === "object") out.arguments = item.arguments;
  } else if (kind === "custom_tool_call") {
    if (item.name) out.tool_name = item.name;
    if (item.arguments && typeof item.arguments === "object") {
      Object.assign(out, item.arguments as Record<string, unknown>);
    }
    if (codexIsShellTool(item)) {
      const command = typeof out.cmd === "string"
        ? out.cmd
        : typeof out.command === "string"
          ? out.command
          : typeof out.chars === "string"
            ? `stdin: ${out.chars.slice(0, 80)}`
            : codexRawToolName(item);
      out.command = command;
    }
  } else if (kind === "web_search" || kind === "web_search_call") {
    const q = item.action?.query || item.query;
    if (q) out.query = q;
    if (item.action?.queries) out.queries = item.action.queries;
  } else {
    if (item.command !== undefined) out.command = codexCommandString(item) || item.command;
    if (item.arguments && typeof item.arguments === "object") {
      Object.assign(out, item.arguments as Record<string, unknown>);
    }
    if (codexIsShellTool(item)) {
      const command = typeof out.cmd === "string"
        ? out.cmd
        : typeof out.command === "string"
          ? out.command
          : typeof out.chars === "string"
            ? `stdin: ${out.chars.slice(0, 80)}`
            : codexRawToolName(item);
      out.command = command;
    }
  }
  return out;
}

export function codexItemResultText(item: CodexItem): string {
  if (typeof item.output === "string") return item.output;
  if (item.result !== undefined) {
    return typeof item.result === "string" ? item.result : JSON.stringify(item.result);
  }
  if (typeof item.text === "string") return item.text;
  if (item.output !== undefined) return JSON.stringify(item.output);
  return "";
}

export function codexItemIsError(item: CodexItem): boolean {
  if (item.status === "failed" || item.status === "error") return true;
  if (typeof item.exit_code === "number" && item.exit_code !== 0) return true;
  return false;
}

export function codexItemToProviderToolCall(item: CodexItem, fallbackId?: string): ProviderToolCall | null {
  const id = item.id || fallbackId;
  if (!id) return null;
  return buildProviderToolCall({
    id,
    name: codexItemDisplayName(item),
    input: codexItemInput(item),
  });
}

export function codexItemToProviderToolPatch(item: CodexItem): ProviderToolPatch {
  return {
    name: codexItemDisplayName(item),
    input: codexItemInput(item),
  };
}

export function codexItemToProviderToolResult(
  item: CodexItem,
  options?: { id?: string; result?: string; input?: ProviderToolInput; name?: string },
): ProviderToolResult | null {
  const id = options?.id || item.id;
  if (!id) return null;
  const input = options?.input ?? codexItemInput(item);
  const name = options?.name ?? codexItemDisplayName(item);
  return buildProviderToolResult({
    id,
    result: options?.result ?? codexItemResultText(item),
    isError: codexItemIsError(item),
    patch: { name, input },
  });
}

export function codexItemChangedPaths(item: CodexItem): string[] {
  return providerToolChangedPaths(codexItemInput(item));
}

export function codexInputChangedPaths(input: ProviderToolInput): string[] {
  return providerToolChangedPaths(input);
}

export function getCodexContextWindow(model: string | undefined | null): number {
  if (!model) return 256_000;
  const m = model.toLowerCase();
  if (m.startsWith("gpt-5")) return 400_000;
  if (m.startsWith("o3") || m.startsWith("o4")) return 200_000;
  return 256_000;
}

function codexUsageEvent(
  usage: CodexUsage | undefined,
  contextWindow: number | null | undefined,
): NormalizedProviderEvent | null {
  if (!usage || typeof usage.input_tokens !== "number") return null;
  const inputTokens = usage.input_tokens;
  const event: NormalizedProviderEvent = {
    kind: "usage",
    inputTokens,
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(typeof contextWindow === "number" && contextWindow > 0 ? { contextMax: contextWindow } : {}),
  };
  return event;
}

export class CodexLiveEventDecoder {
  private readonly pending = new Map<string, Map<string, CodexPendingItem>>();
  private readonly assistantFinalized = new Set<string>();
  private readonly parseErrorCounts = new Map<string, number>();

  resetSession(sessionId: string) {
    this.pending.delete(sessionId);
    this.assistantFinalized.delete(sessionId);
    this.parseErrorCounts.delete(sessionId);
  }

  decode(sessionId: string, data: string): NormalizedProviderEvent[] {
    let parsed: CodexNdjsonEvent;
    try {
      parsed = JSON.parse(data) as CodexNdjsonEvent;
    } catch (err) {
      const count = (this.parseErrorCounts.get(sessionId) || 0) + 1;
      this.parseErrorCounts.set(sessionId, count);
      console.warn("[codex] Dropped malformed stream event:", data.slice(0, 200), err);
      return [];
    }
    this.parseErrorCounts.delete(sessionId);

    const type = parsed.type || "";
    if (!type) return [];

    if (type === "thread.started" || type === "session_configured") {
      const threadId = parsed.thread_id || parsed.threadId;
      this.pending.delete(sessionId);
      this.assistantFinalized.delete(sessionId);
      return [{
        kind: "session_started",
        ...(threadId ? { threadId } : {}),
      }];
    }

    if (type === "mcp.status.updated") {
      const mcpEvent = parsed as CodexNdjsonEvent & Record<string, unknown>;
      const servers: unknown[] = Array.isArray(mcpEvent.mcp_servers)
        ? mcpEvent.mcp_servers
        : Array.isArray(mcpEvent.servers)
          ? mcpEvent.servers
          : mcpEvent.server
            ? [mcpEvent.server]
            : [mcpEvent];
      return [{ kind: "mcp_status", servers }];
    }

    if (type === "turn.started") {
      this.assistantFinalized.delete(sessionId);
      return [{ kind: "turn_started" }];
    }

    if (type === "token_usage.updated") {
      const event = codexUsageEvent(parsed.usage ?? parsed.payload?.usage, parsed.context_window);
      return event ? [event] : [];
    }

    if (type === "item.started") {
      const item = parsed.item;
      if (!item || !item.id) return [];
      const kind = classifyCodexItem(item.item_type ?? item.type);
      const itemMap = this.getItemMap(sessionId);
      itemMap.set(item.id, {
        itemId: item.id,
        kind,
        toolName: codexItemDisplayName(item),
        text: typeof item.text === "string" ? item.text : "",
        outputText: "",
        inputArgs: codexItemInput(item),
      });

      if (kind === "tool") {
        const toolCall = codexItemToProviderToolCall(item);
        if (!toolCall) return [];
        this.assistantFinalized.add(sessionId);
        return [{ kind: "tool_call", toolCall }];
      }
      return [];
    }

    if (type === "item.updated" || type === "content.delta") {
      const item = parsed.item;
      if (!item?.id) return [];
      const itemMap = this.getItemMap(sessionId);
      const tracked = itemMap.get(item.id);
      if (tracked && tracked.kind === "agent_message") {
        const candidateText =
          (typeof parsed.delta === "string" ? parsed.delta : "") ||
          (typeof parsed.text === "string" ? parsed.text : "") ||
          (typeof item.text === "string" ? item.text : "");
        const deltaText =
          typeof parsed.delta === "string" || typeof parsed.text === "string"
            ? candidateText
            : candidateText.startsWith(tracked.text)
              ? candidateText.slice(tracked.text.length)
              : candidateText;
        if (!deltaText) return [];
        tracked.text = appendOrReplaceAccumulated(tracked.text, candidateText || deltaText);
        return [{ kind: "assistant_delta", text: deltaText }];
      }
      if (tracked && tracked.kind === "tool") {
        const patch = codexItemToProviderToolPatch(item);
        const input = patch.input ?? {};
        tracked.inputArgs = { ...tracked.inputArgs, ...input };
        const resultDelta = codexItemResultText(item);
        const hasResultDelta = resultDelta.length > 0 || codexItemIsError(item);
        if (!hasResultDelta) {
          return [{ kind: "tool_update", id: item.id, patch }];
        }
        tracked.outputText =
          typeof parsed.delta === "string"
            ? tracked.outputText + resultDelta
            : appendOrReplaceAccumulated(tracked.outputText, resultDelta);
        const result = codexItemToProviderToolResult(item, {
          result: tracked.outputText,
          input,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
        });
        return [{
          kind: "tool_update",
          id: item.id,
          patch,
          ...(result ? { result } : {}),
        }];
      }
      return [];
    }

    if (type === "agent_message") {
      const text = parsed.text || parsed.message || "";
      if (!text) return [];
      this.assistantFinalized.add(sessionId);
      return [{ kind: "assistant_message", text }];
    }

    if (type === "agent_reasoning") {
      return [];
    }

    if (type === "item.completed") {
      return this.decodeCompletedItem(sessionId, parsed.item);
    }

    if (type === "tool_use" || type === "tool_call_begin") {
      const item = parsed.item || {};
      const id = item.id || parsed.thread_id || `${type}-${Date.now()}`;
      const toolCall = codexItemToProviderToolCall(item, id);
      if (!toolCall) return [];
      this.assistantFinalized.add(sessionId);
      return [{ kind: "tool_call", toolCall }];
    }

    if (type === "tool_result" || type === "tool_call_end") {
      const item = parsed.item || {};
      const id = item.id || "";
      if (!id) return [];
      const result =
        (typeof parsed.output === "string" ? parsed.output : "") ||
        codexItemResultText(item);
      const toolResult = codexItemToProviderToolResult(item, { id, result });
      return toolResult ? [{ kind: "tool_result", toolResult }] : [];
    }

    if (type === "turn.completed" || type === "task_complete" || type === "task.completed") {
      const usage = parsed.usage ?? parsed.payload?.usage;
      const inputTokens = usage?.input_tokens ?? 0;
      const outputTokens = usage?.output_tokens ?? 0;
      const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;
      const completionError =
        (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ||
        parsed.message ||
        "";
      this.resetSession(sessionId);
      const events: NormalizedProviderEvent[] = [];
      const usageEvent = codexUsageEvent(usage, parsed.context_window);
      if (usageEvent) events.push(usageEvent);
      events.push({
        kind: "turn_completed",
        ...(usage ? { usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens } } : {}),
        ...(usage ? { inputTokens, outputTokens, totalTokens } : {}),
        ...(typeof parsed.context_window === "number" && parsed.context_window > 0 ? { contextMax: parsed.context_window } : {}),
        ...(completionError ? { error: completionError } : {}),
      });
      return events;
    }

    if (type === "turn.failed" || type === "turn.aborted" || type === "error") {
      const message =
        (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ||
        parsed.message ||
        "Codex reported an error.";
      this.resetSession(sessionId);
      return [{ kind: "error", message }];
    }

    return [];
  }

  private getItemMap(sessionId: string): Map<string, CodexPendingItem> {
    let map = this.pending.get(sessionId);
    if (!map) {
      map = new Map();
      this.pending.set(sessionId, map);
    }
    return map;
  }

  private decodeCompletedItem(sessionId: string, item: CodexItem | undefined): NormalizedProviderEvent[] {
    if (!item || !item.id) return [];
    const itemMap = this.getItemMap(sessionId);
    const tracked = itemMap.get(item.id);
    const kind = tracked?.kind ?? classifyCodexItem(item.item_type ?? item.type);

    if (kind === "agent_message") {
      itemMap.delete(item.id);
      const finalText =
        (typeof item.text === "string" && item.text) ||
        tracked?.text ||
        "";
      if (!finalText.trim()) return [{ kind: "assistant_message", text: "" }];
      this.assistantFinalized.add(sessionId);
      return [{ kind: "assistant_message", text: finalText.trim() }];
    }

    if (kind !== "tool") {
      itemMap.delete(item.id);
      return [];
    }

    const events: NormalizedProviderEvent[] = [];
    const completedResult = codexItemResultText(item);
    const completedPatch = codexItemToProviderToolPatch(item);
    const completedInput = completedPatch.input ?? {};
    const patchedInput = tracked
      ? { ...tracked.inputArgs, ...completedInput }
      : completedInput;
    const completedName = completedPatch.name ?? "";
    const completedInputIsEmpty = Object.keys(completedInput).length === 0;
    const patchedName = tracked?.toolName && (completedInputIsEmpty || completedName === "dynamic_tool_call")
      ? tracked.toolName
      : completedName || tracked?.toolName || "tool";

    if (!tracked) {
      const toolCall = codexItemToProviderToolCall(item);
      if (toolCall) {
        events.push({
          kind: "tool_call",
          toolCall: { ...toolCall, name: patchedName, input: patchedInput },
        });
      }
      this.assistantFinalized.add(sessionId);
    }

    const result = completedResult || tracked?.outputText || "";
    const toolResult = codexItemToProviderToolResult(item, {
      result,
      input: patchedInput,
      name: patchedName,
    });
    if (toolResult) events.push({ kind: "tool_result", toolResult });
    itemMap.delete(item.id);
    return events;
  }
}
