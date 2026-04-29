import {
  providerToolChangedPaths,
  type NormalizedProviderEvent,
  type ProviderToolCall,
  type ProviderToolInput,
  type ProviderToolResult,
} from "../contracts/providerEvents";
import {
  isStartDelegationTool,
  parseLegacyDelegationBlock as parseWorkflowLegacyDelegationBlock,
  parseStartDelegationJsonText as parseWorkflowStartDelegationJsonText,
  parseStartDelegationToolInput as parseWorkflowStartDelegationToolInput,
} from "./delegationWorkflow";
import type { ProviderId } from "./providers";

const MAX_TOOL_MAP_ENTRIES = 2000;

const HIDDEN_TOOL_NAMES = new Set([
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskStop",
]);

const sessionToolMaps = new Map<string, Map<string, string>>();
const sessionFilePathMaps = new Map<string, Map<string, string>>();

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

export interface ProviderDelegationRequestEvent {
  sessionId: string;
  provider: ProviderId;
  request: ProviderDelegationRequest;
  source: ProviderDelegationRequestSource;
  toolId?: string;
}

type ProviderDelegationRequestListener = (event: ProviderDelegationRequestEvent) => void;

const delegationRequestListeners = new Set<ProviderDelegationRequestListener>();

function getSessionMap<V>(store: Map<string, Map<string, V>>, sessionId: string): Map<string, V> {
  let map = store.get(sessionId);
  if (!map) {
    map = new Map<string, V>();
    store.set(sessionId, map);
  }
  return map;
}

function evictIfNeeded<V>(map: Map<string, V>) {
  if (map.size <= MAX_TOOL_MAP_ENTRIES) return;
  const excess = map.size - MAX_TOOL_MAP_ENTRIES;
  const iter = map.keys();
  for (let i = 0; i < excess; i += 1) {
    const next = iter.next();
    if (next.done) break;
    map.delete(next.value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTaskStatus(value: unknown): ProviderSemanticTaskStatus | null {
  const normalized = stringValue(value).replace(/[-\s]+/g, "_").toLowerCase();
  if (
    normalized === "pending" ||
    normalized === "in_progress" ||
    normalized === "completed" ||
    normalized === "deleted"
  ) {
    return normalized;
  }
  return null;
}

function isHiddenProviderToolName(name: string | undefined): boolean {
  return Boolean(name && HIDDEN_TOOL_NAMES.has(name));
}

function normalizeMcpServerStatus(raw: unknown): ProviderSemanticMcpServerStatus | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const name = obj.name ?? obj.server ?? obj.serverName;
  if (typeof name !== "string" || !name) return null;
  const rawStatus = obj.status ?? obj.startupStatus;
  const status = rawStatus === "ready" ? "connected" : String(rawStatus || "unknown");
  const tools = Array.isArray(obj.tools)
    ? obj.tools
      .map((tool): ProviderSemanticMcpTool | null => {
        const toolRecord = asRecord(tool);
        if (!toolRecord) return null;
        const toolName = String(toolRecord.name || "");
        if (!toolName) return null;
        const out: ProviderSemanticMcpTool = { name: toolName };
        if (toolRecord.description) out.description = String(toolRecord.description);
        return out;
      })
      .filter((tool): tool is ProviderSemanticMcpTool => tool != null)
    : undefined;

  const server: ProviderSemanticMcpServerStatus = { name, status };
  if (obj.error) server.error = String(obj.error);
  const transport = obj.type ?? obj.transport;
  if (transport) server.transport = String(transport);
  if (obj.scope) server.scope = String(obj.scope);
  if (tools) {
    server.tools = tools;
    server.toolCount = tools.length;
  }
  return server;
}

function mcpServerKey(name: string): string {
  return name === "t64" || name === "terminal-64" ? "terminal-64" : name;
}

export function mergeProviderMcpServerStatuses(
  current: ProviderSemanticMcpServerStatus[],
  incoming: ProviderSemanticMcpServerStatus[],
): ProviderSemanticMcpServerStatus[] {
  const merged = new Map<string, ProviderSemanticMcpServerStatus>();
  for (const server of current) {
    merged.set(mcpServerKey(server.name), server);
  }
  for (const server of incoming) {
    const key = mcpServerKey(server.name);
    const previous = merged.get(key);
    const next: ProviderSemanticMcpServerStatus = {
      ...previous,
      ...server,
      name: key === "terminal-64" ? "terminal-64" : server.name,
    };
    const transport = server.transport ?? previous?.transport;
    if (transport) next.transport = transport;
    const scope = server.scope ?? previous?.scope;
    if (scope) next.scope = scope;
    const tools = server.tools ?? previous?.tools;
    if (tools) next.tools = tools;
    const toolCount = server.toolCount ?? previous?.toolCount;
    if (toolCount != null) next.toolCount = toolCount;
    merged.set(key, next);
  }
  return Array.from(merged.values());
}

function questionOptions(rawOptions: unknown): ProviderSemanticQuestionOption[] {
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions.map((option): ProviderSemanticQuestionOption => {
    if (typeof option === "string") return { label: option };
    const optionRecord = asRecord(option);
    if (!optionRecord) return { label: String(option) };
    const out: ProviderSemanticQuestionOption = {
      label: stringValue(optionRecord.label) || String(option),
    };
    if (optionRecord.description !== undefined) out.description = String(optionRecord.description);
    return out;
  });
}

function toolQuestions(input: ProviderToolInput): ProviderSemanticPendingQuestionItem[] {
  const rawInput: unknown = input;
  const candidates = Array.isArray(rawInput)
    ? rawInput
    : input.question || input.options
      ? [input]
      : [Object.values(input).find((value) => Array.isArray(value)) ?? input];

  return candidates
    .flatMap((candidate) => Array.isArray(candidate) ? candidate : [candidate])
    .map((candidate): ProviderSemanticPendingQuestionItem | null => {
      const record = asRecord(candidate);
      if (!record) return null;
      const question =
        stringValue(record.question) ||
        stringValue(record.text) ||
        stringValue(record.description) ||
        "The assistant has a question";
      const item: ProviderSemanticPendingQuestionItem = {
        question,
        options: questionOptions(record.options),
        multiSelect: Boolean(record.multiSelect),
      };
      if (record.header !== undefined) item.header = String(record.header);
      return item;
    })
    .filter((item): item is ProviderSemanticPendingQuestionItem => item != null);
}

export function isStartDelegationToolCall(toolCall: ProviderToolCall): boolean {
  return isStartDelegationTool(toolCall);
}

export function parseStartDelegationToolInput(input: ProviderToolInput): ProviderDelegationRequest | null {
  return parseWorkflowStartDelegationToolInput(input);
}

export function parseStartDelegationJsonText(text: string): ProviderDelegationRequest | null {
  return parseWorkflowStartDelegationJsonText(text);
}

export function parseLegacyDelegationBlock(text: string): ProviderDelegationRequest | null {
  return parseWorkflowLegacyDelegationBlock(text);
}

function rememberToolCall(sessionId: string, toolCall: ProviderToolCall) {
  const toolMap = getSessionMap(sessionToolMaps, sessionId);
  toolMap.set(toolCall.id, toolCall.name);
  evictIfNeeded(toolMap);

  if ((toolCall.name === "Write" || toolCall.name === "Edit" || toolCall.name === "MultiEdit") && toolCall.input.file_path) {
    const fileMap = getSessionMap(sessionFilePathMaps, sessionId);
    fileMap.set(toolCall.id, String(toolCall.input.file_path));
    evictIfNeeded(fileMap);
  }
}

function rememberToolPatch(sessionId: string, toolId: string, result: ProviderToolResult) {
  const name = result.patch?.name;
  if (name) {
    const toolMap = getSessionMap(sessionToolMaps, sessionId);
    if (!toolMap.has(toolId)) {
      toolMap.set(toolId, name);
      evictIfNeeded(toolMap);
    }
  }
  const input = result.patch?.input;
  if ((name === "Write" || name === "Edit" || name === "MultiEdit") && input?.file_path) {
    const fileMap = getSessionMap(sessionFilePathMaps, sessionId);
    if (!fileMap.has(toolId)) {
      fileMap.set(toolId, String(input.file_path));
      evictIfNeeded(fileMap);
    }
  }
}

function semanticEventsForToolCall(sessionId: string, toolCall: ProviderToolCall): ProviderSemanticEvent[] {
  rememberToolCall(sessionId, toolCall);
  const events: ProviderSemanticEvent[] = [{
    kind: "tool_visibility",
    toolId: toolCall.id,
    toolName: toolCall.name,
    hidden: isHiddenProviderToolName(toolCall.name),
  }];

  if (toolCall.name === "EnterPlanMode") {
    events.push({ kind: "plan_mode", active: true, toolId: toolCall.id });
  } else if (toolCall.name === "ExitPlanMode") {
    events.push({ kind: "plan_mode", active: false, toolId: toolCall.id });
  } else if (toolCall.name === "AskUserQuestion") {
    const items = toolQuestions(toolCall.input);
    if (items.length > 0) {
      events.push({ kind: "pending_questions", toolUseId: toolCall.id, items });
    }
  } else if (toolCall.name === "TaskCreate") {
    const task: ProviderSemanticTask = {
      id: toolCall.id,
      subject: stringValue(toolCall.input.subject) || stringValue(toolCall.input.title) || "Task",
      status: "pending",
    };
    if (toolCall.input.description) task.description = String(toolCall.input.description);
    events.push({ kind: "task_created", task });
  } else if (toolCall.name === "TaskUpdate") {
    const taskId = stringValue(toolCall.input.taskId);
    const update: Partial<Pick<ProviderSemanticTask, "subject" | "description" | "status">> = {};
    const status = normalizeTaskStatus(toolCall.input.status);
    if (status) update.status = status;
    const subject = stringValue(toolCall.input.subject);
    if (subject) update.subject = subject;
    const description = stringValue(toolCall.input.description);
    if (description) update.description = description;
    if (taskId && Object.keys(update).length > 0) {
      events.push({ kind: "task_updated", taskId, update });
    }
  }

  const delegationRequest = isStartDelegationToolCall(toolCall)
    ? parseStartDelegationToolInput(toolCall.input)
    : null;
  if (delegationRequest) {
    events.push({
      kind: "delegation_request",
      request: delegationRequest,
      source: "tool",
      toolId: toolCall.id,
    });
  }

  return events;
}

function semanticEventsForToolResult(
  sessionId: string,
  toolResult: ProviderToolResult,
  options?: { trackModifiedFiles?: boolean },
): ProviderSemanticEvent[] {
  rememberToolPatch(sessionId, toolResult.id, toolResult);
  const events: ProviderSemanticEvent[] = [];
  const toolName = getSessionMap(sessionToolMaps, sessionId).get(toolResult.id);

  if (toolName === "TaskCreate" && toolResult.result) {
    const match = toolResult.result.match(/#(\d+)/);
    const newId = match?.[1];
    if (newId) {
      events.push({ kind: "task_id_resolved", oldTaskId: toolResult.id, newTaskId: newId });
    }
  }

  if (!toolResult.isError && options?.trackModifiedFiles !== false) {
    const changedPaths = new Set<string>();
    const filePath = getSessionMap(sessionFilePathMaps, sessionId).get(toolResult.id);
    if (filePath) changedPaths.add(filePath);
    for (const path of providerToolChangedPaths(toolResult.patch?.input ?? {})) {
      changedPaths.add(path);
    }
    if (changedPaths.size > 0) {
      events.push({ kind: "modified_files", toolResultId: toolResult.id, paths: [...changedPaths] });
    }
  }

  return events;
}

function hiddenToolForEvent(sessionId: string, toolId: string, fallbackName?: string): boolean {
  const toolName = fallbackName || getSessionMap(sessionToolMaps, sessionId).get(toolId);
  return isHiddenProviderToolName(toolName);
}

function visibleAssistantMessageEvent(
  event: Extract<NormalizedProviderEvent, { kind: "assistant_message" }>,
  toolCalls: ProviderToolCall[],
): NormalizedProviderEvent {
  const out: Extract<NormalizedProviderEvent, { kind: "assistant_message" }> = {
    kind: "assistant_message",
    text: event.text,
  };
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  if (event.useBufferedText !== undefined) out.useBufferedText = event.useBufferedText;
  return out;
}

export function projectProviderEventSemantics(input: {
  sessionId: string;
  provider: ProviderId;
  event: NormalizedProviderEvent;
}): ProviderEventSemanticProjection {
  const { sessionId, event } = input;
  const semanticEvents: ProviderSemanticEvent[] = [];

  if (event.kind === "mcp_status") {
    const servers = event.servers
      .map((server) => normalizeMcpServerStatus(server))
      .filter((server): server is ProviderSemanticMcpServerStatus => server != null);
    if (servers.length > 0) semanticEvents.push({ kind: "mcp_status", servers });
    return { visibleEvent: null, semanticEvents };
  }

  if (event.kind === "assistant_message") {
    const visibleToolCalls: ProviderToolCall[] = [];
    for (const toolCall of event.toolCalls || []) {
      semanticEvents.push(...semanticEventsForToolCall(sessionId, toolCall));
      if (!isHiddenProviderToolName(toolCall.name)) visibleToolCalls.push(toolCall);
    }
    const jsonRequest = parseStartDelegationJsonText(event.text);
    if (jsonRequest) {
      semanticEvents.push({ kind: "delegation_request", request: jsonRequest, source: "json_tag" });
    } else {
      const legacyRequest = parseLegacyDelegationBlock(event.text);
      if (legacyRequest) {
        semanticEvents.push({ kind: "delegation_request", request: legacyRequest, source: "legacy_block" });
      }
    }
    return {
      visibleEvent: visibleAssistantMessageEvent(event, visibleToolCalls),
      semanticEvents,
    };
  }

  if (event.kind === "tool_call") {
    semanticEvents.push(...semanticEventsForToolCall(sessionId, event.toolCall));
    return {
      visibleEvent: isHiddenProviderToolName(event.toolCall.name) ? null : event,
      semanticEvents,
    };
  }

  if (event.kind === "tool_update") {
    const fallbackName = event.patch.name;
    if (event.result) {
      semanticEvents.push(...semanticEventsForToolResult(sessionId, event.result, { trackModifiedFiles: false }));
    } else if (fallbackName) {
      const toolMap = getSessionMap(sessionToolMaps, sessionId);
      if (!toolMap.has(event.id)) {
        toolMap.set(event.id, fallbackName);
        evictIfNeeded(toolMap);
      }
    }
    return {
      visibleEvent: hiddenToolForEvent(sessionId, event.id, fallbackName) ? null : event,
      semanticEvents,
    };
  }

  if (event.kind === "tool_result") {
    semanticEvents.push(...semanticEventsForToolResult(sessionId, event.toolResult));
    return {
      visibleEvent: hiddenToolForEvent(sessionId, event.toolResult.id, event.toolResult.patch?.name) ? null : event,
      semanticEvents,
    };
  }

  return { visibleEvent: event, semanticEvents };
}

export function resetProviderEventSemantics(sessionId: string) {
  sessionToolMaps.delete(sessionId);
  sessionFilePathMaps.delete(sessionId);
}

export function subscribeProviderDelegationRequests(listener: ProviderDelegationRequestListener): () => void {
  delegationRequestListeners.add(listener);
  return () => {
    delegationRequestListeners.delete(listener);
  };
}

export function publishProviderDelegationRequest(event: ProviderDelegationRequestEvent) {
  for (const listener of [...delegationRequestListeners]) {
    try {
      listener(event);
    } catch (err) {
      console.warn("[provider-semantics] delegation listener failed", err);
    }
  }
}
