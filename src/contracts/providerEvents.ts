/**
 * Provider-neutral live event/tool contract.
 *
 * Claude, Codex, and future providers can expose different wire events, but
 * frontend state/rendering should only receive these normalized shapes.
 */

export interface ProviderToolChange {
  path?: string;
  file_path?: string;
  kind?: string;
  move_path?: string | null;
  diff?: string;
}

export type ProviderToolInput = Record<string, unknown>;

export interface ProviderToolCall {
  id: string;
  name: string;
  input: ProviderToolInput;
  result?: string;
  isError?: boolean;
  parentToolUseId?: string;
}

export interface ProviderToolPatch {
  name?: string;
  input?: ProviderToolInput;
}

export interface ProviderToolResult {
  id: string;
  result: string;
  isError: boolean;
  patch?: ProviderToolPatch;
}

export type ProviderRuntimeEventType =
  | "provider.session"
  | "provider.turn"
  | "provider.content"
  | "provider.tool"
  | "provider.mcp"
  | "provider.error";

export interface ProviderRuntimeEventBase {
  type: ProviderRuntimeEventType;
  provider: string;
  sessionId: string;
  eventId: string;
  createdAt: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  nativeType?: string;
  raw?: unknown;
}

export interface ProviderRuntimeSessionEvent extends ProviderRuntimeEventBase {
  type: "provider.session";
  phase: "started" | "configured" | "changed" | "exited";
  model?: string;
  contextMax?: number;
}

export interface ProviderRuntimeTurnEvent extends ProviderRuntimeEventBase {
  type: "provider.turn";
  phase: "started" | "completed" | "aborted";
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  contextMax?: number;
  result?: unknown;
  isError?: boolean;
  error?: unknown;
  message?: unknown;
  resetStreamingText?: boolean;
}

export interface ProviderRuntimeContentEvent extends ProviderRuntimeEventBase {
  type: "provider.content";
  phase: "delta" | "message";
  role?: "assistant" | "user" | string;
  text?: string;
  toolCalls?: ProviderToolCall[];
  useBufferedText?: boolean;
}

export interface ProviderRuntimeToolEvent extends ProviderRuntimeEventBase {
  type: "provider.tool";
  phase: "started" | "updated" | "completed";
  id?: string;
  name?: string;
  input?: ProviderToolInput;
  result?: unknown;
  isError?: boolean;
  toolCall?: ProviderToolCall;
  patch?: ProviderToolPatch;
  toolResult?: ProviderToolResult;
}

export interface ProviderRuntimeMcpEvent extends ProviderRuntimeEventBase {
  type: "provider.mcp";
  phase: "status";
  servers: unknown[];
}

export interface ProviderRuntimeErrorEvent extends ProviderRuntimeEventBase {
  type: "provider.error";
  phase: "error" | "warning";
  message: string;
  terminal?: boolean;
}

export type ProviderRuntimeEvent =
  | ProviderRuntimeSessionEvent
  | ProviderRuntimeTurnEvent
  | ProviderRuntimeContentEvent
  | ProviderRuntimeToolEvent
  | ProviderRuntimeMcpEvent
  | ProviderRuntimeErrorEvent;

const T64_MCP_TOOL_NAMES = new Set([
  "StartDelegation",
  "send_to_team",
  "read_team",
  "report_done",
]);

const CLAUDE_TOOL_NAME_ALIASES: Record<string, string> = {
  agent: "Task",
  applypatch: "Edit",
  askuser: "AskUserQuestion",
  askuserquestion: "AskUserQuestion",
  bash: "Bash",
  bashoutput: "BashOutput",
  codebasesearch: "Grep",
  commandexecution: "Bash",
  createfile: "Write",
  deletefile: "Edit",
  dynamictoolcall: "Task",
  edit: "Edit",
  editfile: "Edit",
  execcommand: "Bash",
  fetch: "WebFetch",
  fetchurl: "WebFetch",
  filechange: "Edit",
  filesearch: "Glob",
  findfile: "Glob",
  glob: "Glob",
  grep: "Grep",
  grepsearch: "Grep",
  killbash: "KillBash",
  listdir: "LS",
  localshell: "Bash",
  localshellcall: "Bash",
  ls: "LS",
  multiedit: "MultiEdit",
  notebookedit: "NotebookEdit",
  openfile: "Read",
  read: "Read",
  readfile: "Read",
  ripgrep: "Grep",
  runcommand: "Bash",
  runterminalcmd: "Bash",
  search: "Grep",
  searchfilecontent: "Grep",
  shell: "Bash",
  shelltoolcall: "Bash",
  skill: "Skill",
  subagent: "Task",
  task: "Task",
  todowrite: "TodoWrite",
  updateplan: "TodoWrite",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  write: "Write",
  writefile: "Write",
};

function canonicalToolKey(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function stringField(input: ProviderToolInput, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function normalizedMcpToolName(name: string, input: ProviderToolInput): string | null {
  if (/^mcp__.+__.+/i.test(name)) return name;

  const server = stringField(input, ["server", "mcp_server", "serverName"]);
  const tool = stringField(input, ["tool_name", "toolName"]);
  if (server && tool) return `mcp__${server}__${tool}`;

  const slash = name.match(/^([^/]+)\/(.+)$/);
  if (slash?.[1] && slash[2]) return `mcp__${slash[1]}__${slash[2]}`;

  const terminal64 = name.match(/^terminal-64[-_](.+)$/i);
  if (terminal64?.[1]) return `mcp__terminal-64__${terminal64[1]}`;

  if (T64_MCP_TOOL_NAMES.has(name)) return `mcp__terminal-64__${name}`;
  return null;
}

function normalizeToolInput(name: string, input: ProviderToolInput): ProviderToolInput {
  const normalized: ProviderToolInput = { ...input };
  const canonicalName = name.replace(/^mcp__.+__/i, "");
  const key = canonicalToolKey(canonicalName);

  const path = stringField(normalized, [
    "file_path",
    "path",
    "file",
    "filePath",
    "filepath",
    "target_file",
    "targetFile",
  ]);
  if (path) {
    normalized.file_path = path;
    normalized.path = path;
  }

  if (key === "bash" || key === "bashoutput" || name === "Bash") {
    const command = stringField(normalized, ["command", "cmd", "query"]);
    if (command) normalized.command = command;
    const chars = stringField(normalized, ["chars"]);
    if (!command && chars) normalized.command = `stdin: ${chars.slice(0, 80)}`;
  }

  if (name === "Grep") {
    const pattern = stringField(normalized, ["pattern", "query", "regex"]);
    if (pattern) normalized.pattern = pattern;
  }

  if (name === "Glob") {
    const pattern = stringField(normalized, ["pattern", "query", "glob"]);
    if (pattern) normalized.pattern = pattern;
  }

  if (name === "WebSearch") {
    const query = stringField(normalized, ["query", "q", "search"]);
    if (query) normalized.query = query;
  }

  if (name === "WebFetch") {
    const url = stringField(normalized, ["url", "uri", "href"]);
    if (url) normalized.url = url;
  }

  if ((name === "Edit" || name === "MultiEdit") && normalized.diff === undefined) {
    const diff = stringField(normalized, ["unified_diff", "unifiedDiff", "patch"]);
    if (diff) normalized.diff = diff;
  }

  return normalized;
}

export function normalizeProviderToolName(name: string, input: ProviderToolInput = {}): string {
  const trimmed = name.trim();
  const mcpName = normalizedMcpToolName(trimmed, input);
  if (mcpName) return mcpName;
  return CLAUDE_TOOL_NAME_ALIASES[canonicalToolKey(trimmed)] ?? trimmed;
}

export function normalizeProviderToolCall<T extends ProviderToolCall>(toolCall: T): T {
  const name = normalizeProviderToolName(toolCall.name, toolCall.input);
  return {
    ...toolCall,
    name,
    input: normalizeToolInput(name, toolCall.input),
  };
}

export function normalizeProviderToolPatch(patch: ProviderToolPatch): ProviderToolPatch {
  if (patch.name === undefined && patch.input === undefined) return patch;
  const input = patch.input ?? {};
  const name = patch.name !== undefined ? normalizeProviderToolName(patch.name, input) : undefined;
  const normalizedInput = name !== undefined ? normalizeToolInput(name, input) : normalizeToolInput("", input);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(patch.input !== undefined ? { input: normalizedInput } : {}),
  };
}

export type NormalizedProviderEvent =
  | { kind: "session_started"; threadId?: string; model?: string; contextMax?: number }
  | { kind: "mcp_status"; servers: unknown[] }
  | { kind: "turn_started"; resetStreamingText?: boolean }
  | { kind: "assistant_delta"; text: string }
  | { kind: "assistant_message"; text: string; toolCalls?: ProviderToolCall[]; useBufferedText?: boolean }
  | { kind: "tool_call"; toolCall: ProviderToolCall }
  | { kind: "tool_update"; id: string; patch: ProviderToolPatch; result?: ProviderToolResult }
  | { kind: "tool_result"; toolResult: ProviderToolResult }
  | { kind: "usage"; inputTokens: number; outputTokens?: number; totalTokens?: number; contextMax?: number }
  | {
      kind: "turn_completed";
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
      contextMax?: number;
      isError?: boolean;
      error?: string;
    }
  | { kind: "error"; message: string; terminal?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runtimeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function runtimeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function runtimeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringifyRuntimeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function runtimeInput(value: unknown): ProviderToolInput {
  return isRecord(value) ? value : {};
}

function runtimePatch(value: unknown): ProviderToolPatch | undefined {
  if (!isRecord(value)) return undefined;
  const patch: ProviderToolPatch = {};
  if (typeof value.name === "string") patch.name = value.name;
  if (isRecord(value.input)) patch.input = value.input;
  return patch.name !== undefined || patch.input !== undefined ? patch : undefined;
}

function runtimeToolCall(value: unknown): ProviderToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const id = runtimeString(value.id);
  const name = runtimeString(value.name);
  if (!id || !name) return undefined;
  return buildProviderToolCall({
    id,
    name,
    input: runtimeInput(value.input),
    ...(value.result !== undefined ? { result: stringifyRuntimeValue(value.result) } : {}),
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(typeof value.parentToolUseId === "string" ? { parentToolUseId: value.parentToolUseId } : {}),
  });
}

function runtimeToolResult(value: unknown): ProviderToolResult | undefined {
  if (!isRecord(value)) return undefined;
  const id = runtimeString(value.id);
  if (!id) return undefined;
  const patch = runtimePatch(value.patch);
  return buildProviderToolResult({
    id,
    result: stringifyRuntimeValue(value.result),
    isError: runtimeBoolean(value.isError) ?? false,
    ...(patch ? { patch } : {}),
  });
}

function runtimeTurnUsage(event: ProviderRuntimeTurnEvent) {
  const usage = isRecord(event.usage) ? event.usage : {};
  const inputTokens = event.inputTokens ?? runtimeNumber(usage.input_tokens);
  const outputTokens = event.outputTokens ?? runtimeNumber(usage.output_tokens);
  const totalTokens = event.totalTokens ?? runtimeNumber(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return null;
  }
  return {
    usage: {
      ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
      ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    },
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

export function isProviderRuntimeEvent(value: unknown): value is ProviderRuntimeEvent {
  if (!isRecord(value)) return false;
  return value.type === "provider.session"
    || value.type === "provider.turn"
    || value.type === "provider.content"
    || value.type === "provider.tool"
    || value.type === "provider.mcp"
    || value.type === "provider.error";
}

export function providerRuntimeEventToNormalized(event: ProviderRuntimeEvent): NormalizedProviderEvent[] {
  switch (event.type) {
    case "provider.session":
      if (event.phase !== "started" && event.phase !== "configured") return [];
      return [{
        kind: "session_started",
        ...(event.threadId ? { threadId: event.threadId } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(event.contextMax !== undefined ? { contextMax: event.contextMax } : {}),
      }];
    case "provider.mcp":
      return [{ kind: "mcp_status", servers: Array.isArray(event.servers) ? event.servers : [] }];
    case "provider.content": {
      const text = event.text ?? "";
      if (event.phase === "delta") return text ? [{ kind: "assistant_delta", text }] : [];
      return [{
        kind: "assistant_message",
        text,
        ...(Array.isArray(event.toolCalls) && event.toolCalls.length > 0 ? { toolCalls: event.toolCalls.map(normalizeProviderToolCall) } : {}),
        ...(event.useBufferedText !== undefined ? { useBufferedText: event.useBufferedText } : {}),
      }];
    }
    case "provider.tool": {
      const id = event.id || event.itemId || runtimeToolCall(event.toolCall)?.id || runtimeToolResult(event.toolResult)?.id || "";
      if (event.phase === "started") {
        const toolCall = runtimeToolCall(event.toolCall) ?? (
          id && event.name
            ? buildProviderToolCall({ id, name: event.name, input: event.input ?? {} })
            : undefined
        );
        return toolCall ? [{ kind: "tool_call", toolCall }] : [];
      }
      if (event.phase === "updated") {
        if (!id) return [];
        const patch = runtimePatch(event.patch) ?? {
          ...(event.name ? { name: event.name } : {}),
          ...(event.input ? { input: event.input } : {}),
        };
        return [{
          kind: "tool_update",
          id,
          patch: normalizeProviderToolPatch(patch),
        }];
      }
      const toolResult = runtimeToolResult(event.toolResult) ?? (
        id
          ? buildProviderToolResult({
              id,
              result: stringifyRuntimeValue(event.result),
              isError: event.isError ?? false,
              patch: {
                ...(event.name ? { name: event.name } : {}),
                ...(event.input ? { input: event.input } : {}),
              },
            })
          : undefined
      );
      return toolResult ? [{ kind: "tool_result", toolResult }] : [];
    }
    case "provider.turn":
      if (event.phase === "started") {
        return [{
          kind: "turn_started",
          ...(event.resetStreamingText !== undefined ? { resetStreamingText: event.resetStreamingText } : {}),
        }];
      }
      if (event.phase === "completed" || event.phase === "aborted") {
        const usage = runtimeTurnUsage(event);
        return [{
          kind: "turn_completed",
          ...(usage?.usage ? { usage: usage.usage } : {}),
          ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          ...(event.contextMax !== undefined ? { contextMax: event.contextMax } : {}),
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          ...(stringifyRuntimeValue(event.error || event.message) ? { error: stringifyRuntimeValue(event.error || event.message) } : {}),
        }];
      }
      return [];
    case "provider.error":
      return [{
        kind: "error",
        message: event.message,
        ...(event.terminal !== undefined ? { terminal: event.terminal } : {}),
      }];
  }
}

export function buildProviderToolCall(input: {
  id: string;
  name: string;
  input?: ProviderToolInput;
  result?: string;
  isError?: boolean;
  parentToolUseId?: string;
}): ProviderToolCall {
  return normalizeProviderToolCall({
    id: input.id,
    name: input.name,
    input: input.input ?? {},
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
    ...(input.parentToolUseId !== undefined ? { parentToolUseId: input.parentToolUseId } : {}),
  });
}

export function buildProviderToolResult(input: {
  id: string;
  result: string;
  isError?: boolean;
  patch?: ProviderToolPatch;
}): ProviderToolResult {
  return {
    id: input.id,
    result: input.result,
    isError: input.isError ?? false,
    ...(input.patch ? { patch: normalizeProviderToolPatch(input.patch) } : {}),
  };
}

export function getProviderToolFilePath(input: ProviderToolInput): string {
  const filePath = input.file_path ?? input.path;
  return typeof filePath === "string" ? filePath : "";
}

export function getProviderToolPaths(input: ProviderToolInput): string[] {
  const paths = new Set<string>();
  const primary = getProviderToolFilePath(input);
  if (primary) paths.add(primary);
  if (Array.isArray(input.paths)) {
    for (const path of input.paths) {
      if (typeof path === "string" && path.length > 0) paths.add(path);
    }
  }
  for (const change of getProviderToolChanges(input)) {
    const path = change.file_path || change.path;
    if (path) paths.add(path);
  }
  return [...paths];
}

export function getProviderToolChanges(input: ProviderToolInput): ProviderToolChange[] {
  if (!Array.isArray(input.changes)) return [];
  return input.changes
    .filter((change): change is Record<string, unknown> => Boolean(change) && typeof change === "object")
    .map((change) => {
      const out: ProviderToolChange = {};
      const path = change.path ?? change.file_path;
      if (typeof path === "string" && path.length > 0) {
        out.path = path;
        out.file_path = path;
      }
      if (typeof change.kind === "string") out.kind = change.kind;
      if (typeof change.move_path === "string" || change.move_path === null) out.move_path = change.move_path;
      if (typeof change.diff === "string") out.diff = change.diff;
      return out;
    });
}

export function getProviderToolDiff(input: ProviderToolInput): string {
  if (typeof input.diff === "string") return input.diff;
  const changeWithDiff = getProviderToolChanges(input).find((change) => typeof change.diff === "string" && change.diff.trim());
  return changeWithDiff?.diff ?? "";
}

export function providerToolChangedPaths(input: ProviderToolInput): string[] {
  return getProviderToolPaths(input);
}
