import type { ProviderToolCall, ProviderToolResult } from "../../contracts/providerEvents";
import {
  changedPathsFromInput,
  delegationRequestEventsFromText,
  normalizeMcpServerStatus,
  visibleAssistantMessageEvent,
} from "../providerEventSemanticHelpers";
import type {
  ProviderEventSemanticProjector,
  ProviderEventSemanticProjectorContext,
  ProviderSemanticEvent,
  ProviderSemanticMcpServerStatus,
} from "../providerEventSemanticTypes";

function hasChangedPathInput(toolCall: ProviderToolCall): boolean {
  return changedPathsFromInput(toolCall.input).length > 0;
}

function rememberOpenAiToolCall(
  context: ProviderEventSemanticProjectorContext,
  toolCall: ProviderToolCall,
) {
  context.rememberToolCall(toolCall, {
    trackModifiedFileInput: hasChangedPathInput(toolCall),
  });
}

function rememberOpenAiToolResult(
  context: ProviderEventSemanticProjectorContext,
  toolResult: ProviderToolResult,
) {
  context.rememberToolPatch(toolResult.id, toolResult, {
    trackModifiedFileInput: changedPathsFromInput(toolResult.patch?.input ?? {}).length > 0,
  });
}

function modifiedFileEventsForToolResult(
  context: ProviderEventSemanticProjectorContext,
  toolResult: ProviderToolResult,
): ProviderSemanticEvent[] {
  rememberOpenAiToolResult(context, toolResult);
  if (toolResult.isError) return [];
  const changedPaths = context.changedPathsForToolResult(toolResult);
  return changedPaths.length > 0
    ? [{ kind: "modified_files", toolResultId: toolResult.id, paths: changedPaths }]
    : [];
}

export const openAiEventSemanticProjector: ProviderEventSemanticProjector = ({ event }, context) => {
  const semanticEvents: ProviderSemanticEvent[] = [];

  if (event.kind === "mcp_status") {
    const servers = event.servers
      .map((server) => normalizeMcpServerStatus(server))
      .filter((server): server is ProviderSemanticMcpServerStatus => server != null);
    if (servers.length > 0) semanticEvents.push({ kind: "mcp_status", servers });
    return { visibleEvent: null, semanticEvents };
  }

  if (event.kind === "assistant_message") {
    for (const toolCall of event.toolCalls || []) {
      rememberOpenAiToolCall(context, toolCall);
    }
    semanticEvents.push(...delegationRequestEventsFromText(event.text));
    return {
      visibleEvent: visibleAssistantMessageEvent(event, event.toolCalls || []),
      semanticEvents,
    };
  }

  if (event.kind === "tool_call") {
    rememberOpenAiToolCall(context, event.toolCall);
    return { visibleEvent: event, semanticEvents };
  }

  if (event.kind === "tool_update") {
    if (event.patch.name) context.rememberToolName(event.id, event.patch.name);
    if (event.result) rememberOpenAiToolResult(context, event.result);
    return { visibleEvent: event, semanticEvents };
  }

  if (event.kind === "tool_result") {
    semanticEvents.push(...modifiedFileEventsForToolResult(context, event.toolResult));
    return { visibleEvent: event, semanticEvents };
  }

  return { visibleEvent: event, semanticEvents };
};
