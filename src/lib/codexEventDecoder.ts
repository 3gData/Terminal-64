import {
  buildProviderToolCall,
  buildProviderToolResult,
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
