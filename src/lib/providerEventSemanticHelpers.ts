import {
  providerToolChangedPaths,
  type NormalizedProviderEvent,
  type ProviderToolCall,
  type ProviderToolInput,
} from "../contracts/providerEvents";
import {
  isStartDelegationTool,
  parseLegacyDelegationBlock as parseWorkflowLegacyDelegationBlock,
  parseStartDelegationJsonText as parseWorkflowStartDelegationJsonText,
  parseStartDelegationToolInput as parseWorkflowStartDelegationToolInput,
} from "./delegationWorkflow";
import type {
  ProviderDelegationRequest,
  ProviderSemanticEvent,
  ProviderSemanticMcpServerStatus,
  ProviderSemanticMcpTool,
  ProviderSemanticPendingQuestionItem,
  ProviderSemanticQuestionOption,
  ProviderSemanticTaskStatus,
} from "./providerEventSemanticTypes";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTaskStatus(value: unknown): ProviderSemanticTaskStatus | null {
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

export function normalizeMcpServerStatus(raw: unknown): ProviderSemanticMcpServerStatus | null {
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

export function toolQuestions(input: ProviderToolInput): ProviderSemanticPendingQuestionItem[] {
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

export function visibleAssistantMessageEvent(
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

export function delegationRequestEventForMcpTool(toolCall: ProviderToolCall): ProviderSemanticEvent | null {
  if (!isStartDelegationToolCall(toolCall)) return null;
  const request = parseStartDelegationToolInput(toolCall.input);
  if (!request) return null;
  return {
    kind: "delegation_request",
    request,
    source: "tool",
    toolId: toolCall.id,
  };
}

export function delegationRequestEventsFromText(text: string): ProviderSemanticEvent[] {
  const jsonRequest = parseStartDelegationJsonText(text);
  if (jsonRequest) {
    return [{ kind: "delegation_request", request: jsonRequest, source: "json_tag" }];
  }
  const legacyRequest = parseLegacyDelegationBlock(text);
  if (legacyRequest) {
    return [{ kind: "delegation_request", request: legacyRequest, source: "legacy_block" }];
  }
  return [];
}

export function changedPathsFromInput(input: ProviderToolInput): string[] {
  return providerToolChangedPaths(input);
}
