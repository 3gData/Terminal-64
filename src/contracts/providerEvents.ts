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

export function buildProviderToolCall(input: {
  id: string;
  name: string;
  input?: ProviderToolInput;
  result?: string;
  isError?: boolean;
  parentToolUseId?: string;
}): ProviderToolCall {
  return {
    id: input.id,
    name: input.name,
    input: input.input ?? {},
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
    ...(input.parentToolUseId !== undefined ? { parentToolUseId: input.parentToolUseId } : {}),
  };
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
    ...(input.patch ? { patch: input.patch } : {}),
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
