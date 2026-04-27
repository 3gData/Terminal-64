import { listen } from "@tauri-apps/api/event";
import type { ChatMessage, HookEventPayload, ToolCall } from "./types";

const FORWARDING_PREFIX = "[Update from";
const REPORT_DONE_TOOL = "report_done";
const RECENT_REPORT_DONE_SCAN_LIMIT = 5;

export type DelegationCompletionDecision =
  | { kind: "none" }
  | { kind: "report_done"; summary: string; messageId: string | null }
  | { kind: "idle_candidate"; summary: string; messageId: string };

interface DelegationCompletionInput {
  messages: ChatMessage[];
  lastForwardedMessageId?: string;
}

interface NormalizedReportDone {
  summary: string;
  messageId: string | null;
}

interface ClaudeHookCompletionSourceOptions {
  isDelegationChildActive: (sessionId: string) => boolean;
  isSessionQuiescent: (sessionId: string) => boolean;
  onCompletionHint: (sessionId: string) => void;
  onActivity: (sessionId: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractText(value: unknown): string | null {
  const parsed = parseJsonValue(value);
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    return trimmed || null;
  }
  if (Array.isArray(parsed)) {
    const parts = parsed.map(extractText).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : null;
  }
  const record = asRecord(parsed);
  if (!record) return null;

  for (const key of ["summary", "message", "text", "content", "result"]) {
    const direct = stringField(record, key);
    if (direct) return direct;
    const nested = extractText(record[key]);
    if (nested) return nested;
  }
  return null;
}

function reportDoneSummaryFromInput(input: Record<string, unknown>): string | null {
  const direct = stringField(input, "summary");
  if (direct) return direct;

  for (const key of ["arguments", "args", "tool_input", "input"]) {
    const nested = asRecord(parseJsonValue(input[key]));
    if (!nested) continue;
    const summary = reportDoneSummaryFromInput(nested);
    if (summary) return summary;
  }
  return null;
}

export function normalizeToolName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  return raw.trim().toLowerCase();
}

export function isReportDoneToolName(name: unknown): boolean {
  const normalized = normalizeToolName(name);
  if (!normalized) return false;
  if (normalized === REPORT_DONE_TOOL) return true;
  const segments = normalized.split(/__|[/.:\s]+/).filter(Boolean);
  return segments[segments.length - 1] === REPORT_DONE_TOOL;
}

export function normalizeReportDoneToolCall(toolCall: ToolCall): string | null {
  const input = toolCall.input;
  const toolName = input.tool_name ?? input.name ?? toolCall.name;
  if (!isReportDoneToolName(toolCall.name) && !isReportDoneToolName(toolName)) return null;

  return reportDoneSummaryFromInput(input)
    ?? extractText(toolCall.result)
    ?? "(agent reported done)";
}

export function extractReportDone(messages: ChatMessage[]): NormalizedReportDone | null {
  const start = Math.max(0, messages.length - RECENT_REPORT_DONE_SCAN_LIMIT);
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (let j = message.toolCalls.length - 1; j >= 0; j--) {
      const toolCall = message.toolCalls[j];
      if (!toolCall) continue;
      const summary = normalizeReportDoneToolCall(toolCall);
      if (summary) return { summary, messageId: message.id };
    }
  }
  return null;
}

export function describeDelegationToolAction(toolCall: ToolCall): string {
  const detail = toolCall.input.file_path
    ?? toolCall.input.filePath
    ?? toolCall.input.command
    ?? toolCall.input.pattern
    ?? "";
  const suffix = detail ? ` ${String(detail).split(/[/\\]/).pop()?.slice(0, 40)}` : "";
  return `${toolCall.name}${suffix}`;
}

export function summarizeToolCalls(message: ChatMessage): string {
  if (!message.toolCalls?.length) return "";
  const actions = message.toolCalls.map((toolCall) => describeDelegationToolAction(toolCall));
  return `Completed actions: ${actions.join(", ")}`;
}

export function evaluateDelegationCompletion(input: DelegationCompletionInput): DelegationCompletionDecision {
  const reportDone = extractReportDone(input.messages);
  if (reportDone) {
    return {
      kind: "report_done",
      summary: reportDone.summary,
      messageId: reportDone.messageId,
    };
  }

  const lastAssistant = [...input.messages].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) return { kind: "none" };
  if (lastAssistant.id === input.lastForwardedMessageId) return { kind: "none" };
  if (lastAssistant.content.startsWith(FORWARDING_PREFIX)) return { kind: "none" };

  return {
    kind: "idle_candidate",
    messageId: lastAssistant.id,
    summary: lastAssistant.content || summarizeToolCalls(lastAssistant),
  };
}

export async function startClaudeHookCompletionSource(
  options: ClaudeHookCompletionSourceOptions,
): Promise<() => void> {
  const unlistens: (() => void)[] = [];

  const stopUnlisten = await listen<HookEventPayload>("claude-hook-SubagentStop", (event) => {
    const { session_id: sessionId } = event.payload;
    if (!options.isDelegationChildActive(sessionId)) return;
    if (options.isSessionQuiescent(sessionId)) {
      options.onCompletionHint(sessionId);
    }
  });
  unlistens.push(stopUnlisten);

  const startUnlisten = await listen<HookEventPayload>("claude-hook-SubagentStart", (event) => {
    const { session_id: sessionId } = event.payload;
    if (options.isDelegationChildActive(sessionId)) {
      options.onActivity(sessionId);
    }
  });
  unlistens.push(startUnlisten);

  return () => {
    for (const unlisten of unlistens) unlisten();
  };
}
