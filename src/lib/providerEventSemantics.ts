import {
  providerToolChangedPaths,
  type NormalizedProviderEvent,
  type ProviderToolCall,
  type ProviderToolInput,
  type ProviderToolResult,
} from "../contracts/providerEvents";
import { anthropicEventSemanticProjector } from "./providerRuntimes/anthropicEventSemantics";
import { cursorEventSemanticProjector } from "./providerRuntimes/cursorEventSemantics";
import { openAiEventSemanticProjector } from "./providerRuntimes/openaiEventSemantics";
import {
  delegationRequestEventForMcpTool,
  isStartDelegationToolCall,
  mergeProviderMcpServerStatuses,
  parseLegacyDelegationBlock,
  parseStartDelegationJsonText,
  parseStartDelegationToolInput,
} from "./providerEventSemanticHelpers";
import type { ProviderId } from "./providers";
import type {
  ProviderDelegationRequestEvent,
  ProviderEventSemanticProjection,
  ProviderEventSemanticProjector,
  ProviderEventSemanticProjectorContext,
  ProviderSemanticEvent,
  RememberToolOptions,
} from "./providerEventSemanticTypes";
export type {
  ProviderDelegationRequest,
  ProviderDelegationRequestEvent,
  ProviderDelegationRequestSource,
  ProviderDelegationTask,
  ProviderEventSemanticProjection,
  ProviderSemanticEvent,
  ProviderSemanticMcpServerStatus,
  ProviderSemanticMcpTool,
  ProviderSemanticPendingQuestionItem,
  ProviderSemanticQuestionOption,
  ProviderSemanticTask,
  ProviderSemanticTaskStatus,
} from "./providerEventSemanticTypes";
export {
  isStartDelegationToolCall,
  mergeProviderMcpServerStatuses,
  parseLegacyDelegationBlock,
  parseStartDelegationJsonText,
  parseStartDelegationToolInput,
};

const MAX_TOOL_MAP_ENTRIES = 2000;

const sessionToolMaps = new Map<string, Map<string, string>>();
const sessionFilePathMaps = new Map<string, Map<string, Set<string>>>();

type ProviderDelegationRequestListener = (event: ProviderDelegationRequestEvent) => void;

const delegationRequestListeners = new Set<ProviderDelegationRequestListener>();

const PROVIDER_EVENT_SEMANTIC_PROJECTORS = {
  anthropic: anthropicEventSemanticProjector,
  openai: openAiEventSemanticProjector,
  cursor: cursorEventSemanticProjector,
} satisfies Record<ProviderId, ProviderEventSemanticProjector>;

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

function rememberToolName(sessionId: string, toolId: string, toolName: string) {
  if (!toolName) return;
  const toolMap = getSessionMap(sessionToolMaps, sessionId);
  if (!toolMap.has(toolId)) {
    toolMap.set(toolId, toolName);
    evictIfNeeded(toolMap);
  }
}

function rememberToolFilePaths(sessionId: string, toolId: string, input: ProviderToolInput | undefined) {
  if (!input) return;
  const paths = providerToolChangedPaths(input);
  if (paths.length === 0) return;
  const fileMap = getSessionMap(sessionFilePathMaps, sessionId);
  const existing = fileMap.get(toolId) ?? new Set<string>();
  for (const path of paths) {
    existing.add(path);
  }
  fileMap.set(toolId, existing);
  evictIfNeeded(fileMap);
}

function createProjectorContext(sessionId: string): ProviderEventSemanticProjectorContext {
  return {
    rememberToolCall(toolCall: ProviderToolCall, options?: RememberToolOptions) {
      rememberToolName(sessionId, toolCall.id, toolCall.name);
      if (options?.trackModifiedFileInput) {
        rememberToolFilePaths(sessionId, toolCall.id, toolCall.input);
      }
    },
    rememberToolName(toolId: string, toolName: string) {
      rememberToolName(sessionId, toolId, toolName);
    },
    rememberToolPatch(toolId: string, result: ProviderToolResult, options?: RememberToolOptions) {
      const name = result.patch?.name;
      if (name) rememberToolName(sessionId, toolId, name);
      if (options?.trackModifiedFileInput) {
        rememberToolFilePaths(sessionId, toolId, result.patch?.input);
      }
    },
    toolNameForId(toolId: string): string | undefined {
      return getSessionMap(sessionToolMaps, sessionId).get(toolId);
    },
    changedPathsForToolResult(toolResult: ProviderToolResult): string[] {
      const changedPaths = new Set<string>();
      const rememberedPaths = getSessionMap(sessionFilePathMaps, sessionId).get(toolResult.id);
      if (rememberedPaths) {
        for (const path of rememberedPaths) changedPaths.add(path);
      }
      for (const path of providerToolChangedPaths(toolResult.patch?.input ?? {})) {
        changedPaths.add(path);
      }
      return [...changedPaths];
    },
  };
}

function providerNeutralMcpToolConventionEvents(event: NormalizedProviderEvent): ProviderSemanticEvent[] {
  const toolCalls: ProviderToolCall[] = [];
  if (event.kind === "assistant_message") {
    toolCalls.push(...(event.toolCalls || []));
  } else if (event.kind === "tool_call") {
    toolCalls.push(event.toolCall);
  }

  const events: ProviderSemanticEvent[] = [];
  for (const toolCall of toolCalls) {
    const delegationEvent = delegationRequestEventForMcpTool(toolCall);
    if (delegationEvent) events.push(delegationEvent);
  }
  return events;
}

function semanticEventKey(event: ProviderSemanticEvent): string {
  if (event.kind === "delegation_request") {
    return `${event.kind}:${event.source}:${event.toolId ?? ""}:${JSON.stringify(event.request)}`;
  }
  return JSON.stringify(event);
}

function mergeSemanticEvents(
  providerEvents: ProviderSemanticEvent[],
  fallbackEvents: ProviderSemanticEvent[],
): ProviderSemanticEvent[] {
  if (fallbackEvents.length === 0) return providerEvents;
  const seen = new Set(providerEvents.map(semanticEventKey));
  const merged = [...providerEvents];
  for (const event of fallbackEvents) {
    const key = semanticEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged;
}

export function dispatchProviderEventSemantics(input: {
  sessionId: string;
  provider: ProviderId;
  event: NormalizedProviderEvent;
}): ProviderEventSemanticProjection {
  const projector = PROVIDER_EVENT_SEMANTIC_PROJECTORS[input.provider];
  const projection = projector(input, createProjectorContext(input.sessionId));
  return {
    visibleEvent: projection.visibleEvent,
    semanticEvents: mergeSemanticEvents(
      projection.semanticEvents,
      providerNeutralMcpToolConventionEvents(input.event),
    ),
  };
}

/** @deprecated Use dispatchProviderEventSemantics. */
export const projectProviderEventSemantics = dispatchProviderEventSemantics;

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
