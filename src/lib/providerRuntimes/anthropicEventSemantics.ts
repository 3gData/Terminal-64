import type { ProviderToolCall, ProviderToolResult } from "../../contracts/providerEvents";
import {
  changedPathsFromInput,
  delegationRequestEventsFromText,
  normalizeMcpServerStatus,
  normalizeTaskStatus,
  stringValue,
  toolQuestions,
  visibleAssistantMessageEvent,
} from "../providerEventSemanticHelpers";
import type {
  ProviderEventSemanticProjector,
  ProviderEventSemanticProjectorContext,
  ProviderSemanticEvent,
  ProviderSemanticMcpServerStatus,
  ProviderSemanticTask,
} from "../providerEventSemanticTypes";

const HIDDEN_ANTHROPIC_TOOL_NAMES = new Set([
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskStop",
]);

const ANTHROPIC_FILE_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit"]);

function isHiddenAnthropicToolName(name: string | undefined): boolean {
  return Boolean(name && HIDDEN_ANTHROPIC_TOOL_NAMES.has(name));
}

function isAnthropicFileToolName(name: string | undefined): boolean {
  return Boolean(name && ANTHROPIC_FILE_TOOL_NAMES.has(name));
}

function rememberAnthropicToolCall(
  context: ProviderEventSemanticProjectorContext,
  toolCall: ProviderToolCall,
) {
  context.rememberToolCall(toolCall, {
    trackModifiedFileInput: isAnthropicFileToolName(toolCall.name),
  });
}

function semanticEventsForToolCall(
  context: ProviderEventSemanticProjectorContext,
  toolCall: ProviderToolCall,
): ProviderSemanticEvent[] {
  rememberAnthropicToolCall(context, toolCall);
  const events: ProviderSemanticEvent[] = [{
    kind: "tool_visibility",
    toolId: toolCall.id,
    toolName: toolCall.name,
    hidden: isHiddenAnthropicToolName(toolCall.name),
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

  return events;
}

function semanticEventsForToolResult(
  context: ProviderEventSemanticProjectorContext,
  toolResult: ProviderToolResult,
  options?: { trackModifiedFiles?: boolean },
): ProviderSemanticEvent[] {
  const toolName = toolResult.patch?.name ?? context.toolNameForId(toolResult.id);
  context.rememberToolPatch(toolResult.id, toolResult, {
    trackModifiedFileInput: isAnthropicFileToolName(toolName),
  });
  const events: ProviderSemanticEvent[] = [];

  if (toolName === "TaskCreate" && toolResult.result) {
    const match = toolResult.result.match(/#(\d+)/);
    const newId = match?.[1];
    if (newId) {
      events.push({ kind: "task_id_resolved", oldTaskId: toolResult.id, newTaskId: newId });
    }
  }

  if (!toolResult.isError && options?.trackModifiedFiles !== false) {
    const changedPaths = context.changedPathsForToolResult(toolResult);
    if (changedPaths.length > 0) {
      events.push({ kind: "modified_files", toolResultId: toolResult.id, paths: changedPaths });
    }
  }

  return events;
}

function hiddenToolForEvent(
  context: ProviderEventSemanticProjectorContext,
  toolId: string,
  fallbackName?: string,
): boolean {
  const toolName = fallbackName || context.toolNameForId(toolId);
  return isHiddenAnthropicToolName(toolName);
}

function hasChangedPathInput(toolCall: ProviderToolCall): boolean {
  return changedPathsFromInput(toolCall.input).length > 0;
}

export const anthropicEventSemanticProjector: ProviderEventSemanticProjector = ({ event }, context) => {
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
      semanticEvents.push(...semanticEventsForToolCall(context, toolCall));
      if (!isHiddenAnthropicToolName(toolCall.name)) visibleToolCalls.push(toolCall);
    }
    semanticEvents.push(...delegationRequestEventsFromText(event.text));
    return {
      visibleEvent: visibleAssistantMessageEvent(event, visibleToolCalls),
      semanticEvents,
    };
  }

  if (event.kind === "tool_call") {
    semanticEvents.push(...semanticEventsForToolCall(context, event.toolCall));
    return {
      visibleEvent: isHiddenAnthropicToolName(event.toolCall.name) ? null : event,
      semanticEvents,
    };
  }

  if (event.kind === "tool_update") {
    const fallbackName = event.patch.name;
    if (event.result) {
      semanticEvents.push(...semanticEventsForToolResult(context, event.result, { trackModifiedFiles: false }));
    } else if (fallbackName) {
      context.rememberToolName(event.id, fallbackName);
      if (event.patch.input && isAnthropicFileToolName(fallbackName) && hasChangedPathInput({
        id: event.id,
        name: fallbackName,
        input: event.patch.input,
      })) {
        context.rememberToolCall({ id: event.id, name: fallbackName, input: event.patch.input }, {
          trackModifiedFileInput: true,
        });
      }
    }
    return {
      visibleEvent: hiddenToolForEvent(context, event.id, fallbackName) ? null : event,
      semanticEvents,
    };
  }

  if (event.kind === "tool_result") {
    semanticEvents.push(...semanticEventsForToolResult(context, event.toolResult));
    return {
      visibleEvent: hiddenToolForEvent(context, event.toolResult.id, event.toolResult.patch?.name) ? null : event,
      semanticEvents,
    };
  }

  return { visibleEvent: event, semanticEvents };
};
