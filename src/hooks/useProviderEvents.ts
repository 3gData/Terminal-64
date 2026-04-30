import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  type NormalizedProviderEvent,
  type ProviderToolResult,
} from "../contracts/providerEvents";
import { publishProviderLifecycleFromProviderEvent } from "../lib/providerLifecycleBus";
import {
  getProviderEventContextWindow,
  subscribeProviderEventIngestion,
  type ProviderIngestionMessage,
} from "../lib/providerEventIngestion";
import {
  dispatchProviderEventSemantics,
  mergeProviderMcpServerStatuses,
  publishProviderDelegationRequest,
  resetProviderEventSemantics,
  type ProviderSemanticEvent,
} from "../lib/providerEventSemantics";
import { cancelProviderSession } from "../lib/tauriApi";
import {
  getProviderDefaultEffort,
  getProviderDefaultModel,
  providerSupports,
  type ProviderId,
} from "../lib/providers";
import { runProviderTurn } from "../lib/providerRuntime";
import type { HookEvent, HookEventPayload, HookEventType, ToolCall } from "../lib/types";
import type { PermissionRequestPayload } from "../lib/claudeEventDecoder";
import { useSettingsStore } from "../stores/settingsStore";
import {
  getOpenAiProviderSessionMetadata,
  getProviderPermissionId,
  resolveSessionProviderState,
  useProviderSessionStore,
  type ProviderTask,
  type PendingQuestionItem,
} from "../stores/providerSessionStore";

// RAF batching for streaming text — coalesces deltas into one store update per frame.
const pendingText = new Map<string, string>();
let rafId: number | null = null;

function flushPendingText() {
  rafId = null;
  if (pendingText.size === 0) return;
  const store = useProviderSessionStore.getState();
  for (const [sid, text] of pendingText) {
    store.appendStreamingText(sid, text);
  }
  pendingText.clear();
}

function scheduleFlush() {
  if (rafId === null) {
    rafId = requestAnimationFrame(flushPendingText);
  }
}

function flushBeforeFinalization() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  flushPendingText();
}

async function runAutoCompact(sessionId: string) {
  const store = useProviderSessionStore.getState();
  const session = store.sessions[sessionId];
  if (!session || session.isStreaming) return;

  const providerState = resolveSessionProviderState(session);
  if (!providerSupports(providerState.provider, "compact")) return;

  const openAiMetadata = getOpenAiProviderSessionMetadata(providerState);
  const prompt = "/compact";
  store.addUserMessage(sessionId, prompt);
  store.setStreaming(sessionId, true);

  try {
    const result = await runProviderTurn({
      provider: providerState.provider,
      sessionId,
      cwd: session.cwd || ".",
      prompt,
      started: session.hasBeenStarted,
      threadId: openAiMetadata?.codexThreadId ?? null,
      selectedControls: providerState.selectedControls[providerState.provider] ?? {},
      selectedModel: providerState.selectedModel ?? getProviderDefaultModel(providerState.provider),
      selectedEffort: providerState.selectedEffort ?? getProviderDefaultEffort(providerState.provider),
      providerPermissionId: providerState.providerPermissions[providerState.provider]
        ?? getProviderPermissionId(providerState, providerState.provider),
      permissionMode: "auto",
      skipOpenwolf: session.skipOpenwolf,
      seedTranscript: providerState.seedTranscript,
      resumeAtUuid: session.resumeAtUuid ?? null,
      forkParentSessionId: session.forkParentSessionId ?? null,
    });
    if (result.clearSeedTranscript) store.clearSeedTranscript(sessionId);
    if (result.clearResumeAtUuid) store.setResumeAtUuid(sessionId, null);
    if (result.clearForkParentSessionId) store.setForkParentSessionId(sessionId, null);
  } catch (err) {
    const latestStore = useProviderSessionStore.getState();
    latestStore.setError(sessionId, `Auto-compact failed: ${err}`);
    latestStore.setAutoCompactStatus(sessionId, "idle");
    latestStore.setStreaming(sessionId, false);
  }
}

function applyAssistantMessage(
  sessionId: string,
  event: Extract<NormalizedProviderEvent, { kind: "assistant_message" }>,
  store: ReturnType<typeof useProviderSessionStore.getState>,
) {
  const session = store.sessions[sessionId];
  const text = event.useBufferedText && !event.text
    ? session?.streamingText || ""
    : event.text;
  const visibleToolCalls: ToolCall[] = event.toolCalls || [];

  const trimmedText = text.trim();
  if (trimmedText || visibleToolCalls.length > 0) {
    store.finalizeAssistantMessage(
      sessionId,
      trimmedText,
      visibleToolCalls.length > 0 ? visibleToolCalls : undefined,
    );
  } else {
    store.clearStreamingText(sessionId);
  }
}

function applyToolResult(
  sessionId: string,
  toolResult: ProviderToolResult,
  store: ReturnType<typeof useProviderSessionStore.getState>,
) {
  store.updateToolResult(sessionId, toolResult.id, toolResult.result, toolResult.isError, toolResult.patch);
}

function markProviderEventLive(
  sessionId: string,
  event: NormalizedProviderEvent,
  store: ReturnType<typeof useProviderSessionStore.getState>,
) {
  if (event.kind === "turn_completed" || event.kind === "error") return;
  const sess = store.sessions[sessionId];
  if (sess && !sess.isStreaming) {
    store.setStreaming(sessionId, true);
  }
  store.touchLastEvent(sessionId);
}

function handleSessionStarted(
  sessionId: string,
  provider: ProviderId,
  event: Extract<NormalizedProviderEvent, { kind: "session_started" }>,
  store: ReturnType<typeof useProviderSessionStore.getState>,
) {
  if (event.threadId) store.setCodexThreadId(sessionId, event.threadId);
  if (event.model) store.setModel(sessionId, event.model);
  store.setStreaming(sessionId, true);
  const session = store.sessions[sessionId];
  const prevUsed = session?.contextUsed || 0;
  const model = event.model || (session ? resolveSessionProviderState(session).selectedModel : null) || session?.model || null;
  const contextMax = event.contextMax ?? (event.model ? getProviderEventContextWindow(provider, model) : 0);
  if (contextMax > 0) {
    store.setContextUsage(sessionId, prevUsed, contextMax);
  }
}

function updateProviderTaskId(sessionId: string, oldTaskId: string, newTaskId: string) {
  const state = useProviderSessionStore.getState();
  const session = state.sessions[sessionId];
  if (!session) return;
  const tasks = session.tasks.map((task) =>
    task.id === oldTaskId ? { ...task, id: newTaskId } : task
  );
  useProviderSessionStore.setState({
    sessions: { ...state.sessions, [sessionId]: { ...session, tasks } },
  });
}

function handleSemanticEvent(
  sessionId: string,
  provider: ProviderId,
  event: ProviderSemanticEvent,
  store: ReturnType<typeof useProviderSessionStore.getState>,
) {
  switch (event.kind) {
    case "mcp_status": {
      const current = store.sessions[sessionId]?.mcpServers ?? [];
      store.setMcpServers(sessionId, mergeProviderMcpServerStatuses(current, event.servers));
      break;
    }
    case "tool_visibility":
      break;
    case "plan_mode":
      store.setPlanMode(sessionId, event.active);
      break;
    case "pending_questions": {
      const items: PendingQuestionItem[] = event.items.map((item) => {
        const next: PendingQuestionItem = {
          question: item.question,
          options: item.options,
          multiSelect: item.multiSelect,
        };
        if (item.header !== undefined) next.header = item.header;
        return next;
      });
      if (items.length === 0) break;
      store.setPendingQuestions(sessionId, {
        toolUseId: event.toolUseId,
        items,
        currentIndex: 0,
        answers: [],
      });
      cancelProviderSession(sessionId, provider).catch(() => {});
      store.setStreaming(sessionId, false);
      break;
    }
    case "task_created":
      store.addTask(sessionId, event.task as ProviderTask);
      break;
    case "task_updated":
      store.updateTask(sessionId, event.taskId, event.update as Partial<ProviderTask>);
      break;
    case "task_id_resolved":
      updateProviderTaskId(sessionId, event.oldTaskId, event.newTaskId);
      break;
    case "modified_files":
      store.addModifiedFiles(sessionId, event.paths);
      break;
    case "delegation_request":
      publishProviderDelegationRequest({
        sessionId,
        provider,
        request: event.request,
        source: event.source,
        ...(event.toolId !== undefined ? { toolId: event.toolId } : {}),
      });
      break;
  }
}

function handleUsage(
  sessionId: string,
  provider: ProviderId,
  event: Extract<NormalizedProviderEvent, { kind: "usage" }>,
  store: ReturnType<typeof useProviderSessionStore.getState>,
) {
  if (event.inputTokens <= 0) return;
  const session = store.sessions[sessionId];
  const providerState = session ? resolveSessionProviderState(session) : null;
  const model = providerState?.selectedModel ?? session?.model ?? null;
  const contextMax = event.contextMax
    ?? session?.contextMax
    ?? getProviderEventContextWindow(provider, model);
  store.setContextUsage(sessionId, Math.min(event.inputTokens, contextMax), contextMax);
}

function handleTurnCompleted(
  sessionId: string,
  provider: ProviderId,
  event: Extract<NormalizedProviderEvent, { kind: "turn_completed" }>,
) {
  flushBeforeFinalization();
  const postFlushStore = useProviderSessionStore.getState();
  const session = postFlushStore.sessions[sessionId];
  if (session?.streamingText?.trim()) {
    postFlushStore.finalizeAssistantMessage(sessionId, session.streamingText.trim());
  }

  postFlushStore.setStreaming(sessionId, false);
  postFlushStore.clearStreamingText(sessionId);

  if (event.costUsd) postFlushStore.addCost(sessionId, event.costUsd);
  const totalTokens = event.totalTokens
    ?? ((event.inputTokens ?? event.usage?.input_tokens ?? 0) + (event.outputTokens ?? event.usage?.output_tokens ?? 0));
  if (totalTokens > 0) postFlushStore.addTokens(sessionId, totalTokens);

  const latestSession = useProviderSessionStore.getState().sessions[sessionId];
  if (latestSession) {
    const providerState = resolveSessionProviderState(latestSession);
    const model = providerState.selectedModel ?? latestSession.model ?? null;
    const modelContextMax = getProviderEventContextWindow(provider, model);
    let contextMax = event.contextMax ?? latestSession.contextMax ?? modelContextMax;
    if (modelContextMax > contextMax) contextMax = modelContextMax;
    if (contextMax !== (latestSession.contextMax || 0)) {
      postFlushStore.setContextUsage(sessionId, latestSession.contextUsed || 0, contextMax);
    }
  }

  const freshSess = useProviderSessionStore.getState().sessions[sessionId];
  const settings = useSettingsStore.getState();
  const freshProvider = freshSess ? resolveSessionProviderState(freshSess).provider : provider;
  if (
    settings.autoCompactEnabled &&
    freshSess &&
    providerSupports(freshProvider, "compact") &&
    freshSess.autoCompactStatus === "idle" &&
    freshSess.contextMax > 0 &&
    freshSess.contextUsed > 0 &&
    !event.isError
  ) {
    const pct = (freshSess.contextUsed / freshSess.contextMax) * 100;
    if (pct >= settings.autoCompactThreshold) {
      useProviderSessionStore.getState().setAutoCompactStatus(sessionId, "compacting");
      setTimeout(() => {
        runAutoCompact(sessionId);
      }, 500);
    }
  } else if (freshSess?.autoCompactStatus === "compacting") {
    useProviderSessionStore.getState().setAutoCompactStatus(sessionId, "done");
  }

  if (event.error) postFlushStore.setError(sessionId, event.error);
}

function cleanupSessionTracking(sessionId: string) {
  resetProviderEventSemantics(sessionId);
  pendingText.delete(sessionId);
}

function handleProviderEvent(message: ProviderIngestionMessage) {
  const store = useProviderSessionStore.getState();
  const { sessionId, provider } = message;

  if (message.type === "done") {
    flushBeforeFinalization();
    const postFlushStore = useProviderSessionStore.getState();
    const session = postFlushStore.sessions[sessionId];
    if (session?.streamingText?.trim()) {
      postFlushStore.finalizeAssistantMessage(sessionId, session.streamingText.trim());
    }
    const current = useProviderSessionStore.getState().sessions[sessionId];
    if (current && !current.isStreaming) {
      postFlushStore.setStreaming(sessionId, true);
    }
    postFlushStore.setStreaming(sessionId, false);
    postFlushStore.clearStreamingText(sessionId);
    cleanupSessionTracking(sessionId);
    return;
  }

  const event = message.event;
  const wasStreaming = !!store.sessions[sessionId]?.isStreaming;
  markProviderEventLive(sessionId, event, store);

  if (event.kind === "assistant_message" || event.kind === "turn_completed") {
    flushBeforeFinalization();
  }

  const projection = dispatchProviderEventSemantics({ sessionId, provider, event });
  for (const semanticEvent of projection.semanticEvents) {
    handleSemanticEvent(sessionId, provider, semanticEvent, store);
  }

  const visibleEvent = projection.visibleEvent;
  if (visibleEvent) switch (visibleEvent.kind) {
    case "session_started":
      handleSessionStarted(sessionId, provider, visibleEvent, store);
      break;
    case "turn_started":
      store.setStreaming(sessionId, true);
      if (visibleEvent.resetStreamingText) store.clearStreamingText(sessionId);
      break;
    case "assistant_delta": {
      const existing = pendingText.get(sessionId) || "";
      pendingText.set(sessionId, existing + visibleEvent.text);
      scheduleFlush();
      break;
    }
    case "assistant_message":
      applyAssistantMessage(sessionId, visibleEvent, store);
      break;
    case "tool_call":
      applyAssistantMessage(sessionId, { kind: "assistant_message", text: "", toolCalls: [visibleEvent.toolCall] }, store);
      break;
    case "tool_update":
      store.updateToolCall(sessionId, visibleEvent.id, visibleEvent.patch);
      if (visibleEvent.result) applyToolResult(sessionId, visibleEvent.result, store);
      break;
    case "tool_result":
      applyToolResult(sessionId, visibleEvent.toolResult, store);
      break;
    case "usage":
      handleUsage(sessionId, provider, visibleEvent, store);
      break;
    case "turn_completed":
      handleTurnCompleted(sessionId, provider, visibleEvent);
      break;
    case "error":
      store.setError(sessionId, visibleEvent.message);
      if (visibleEvent.terminal !== false) {
        store.setStreaming(sessionId, false);
        store.clearStreamingText(sessionId);
        cleanupSessionTracking(sessionId);
      }
      break;
    case "mcp_status":
      break;
  }

  const lifecycleNeedsDirectPublish =
    (event.kind === "turn_started" && wasStreaming) ||
    (event.kind === "turn_completed" && !wasStreaming);
  if (lifecycleNeedsDirectPublish) {
    publishProviderLifecycleFromProviderEvent({
      sessionId,
      provider,
      event,
    });
  }
}

export function useProviderEvents() {
  useEffect(() => {
    let unlistenProvider: (() => void) | null = null;
    let unlistenPerm: (() => void) | null = null;
    const unlistenHooks: (() => void)[] = [];
    let cancelled = false;

    // Fallback flush: RAF stops firing when the window is backgrounded,
    // so use a setInterval to ensure pending text is still delivered.
    const fallbackFlush = setInterval(() => {
      if (pendingText.size > 0) flushPendingText();
    }, 250);

    (async () => {
      const providerUnlisten = await subscribeProviderEventIngestion((message) => {
        if (!cancelled) handleProviderEvent(message);
      });
      if (cancelled) { providerUnlisten(); return; }
      unlistenProvider = providerUnlisten;

      // Listen for permission requests from the hook server.
      const fn4 = await listen<PermissionRequestPayload>(
        "permission-request",
        (event) => {
          if (cancelled) return;
          const { request_id, session_id, tool_name, tool_input } = event.payload;
          useProviderSessionStore.getState().setPendingPermission(session_id, {
            requestId: request_id,
            toolName: tool_name,
            toolInput: tool_input || {},
          });
        }
      );
      if (cancelled) { fn4(); return; }
      unlistenPerm = fn4;

      // Listen for Anthropic/Claude hook lifecycle events while that provider
      // is the only one emitting hook-server telemetry.
      const HOOK_EVENTS: HookEventType[] = [
        "PreToolUse", "PostToolUse", "Stop",
        "SubagentStart", "SubagentStop", "Notification",
        "PreCompact", "PostCompact", "SessionStart", "SessionEnd",
      ];
      for (const hookType of HOOK_EVENTS) {
        const fn = await listen<HookEventPayload>(
          `claude-hook-${hookType}`,
          (event) => {
            if (cancelled) return;
            const p = event.payload;
            const store = useProviderSessionStore.getState();
            const hookEvent: HookEvent = {
              type: hookType,
              sessionId: p.session_id,
              timestamp: Date.now(),
              ...(p.tool_name !== undefined && { toolName: p.tool_name }),
              ...(p.tool_input !== undefined && { toolInput: p.tool_input }),
              ...(p.tool_result !== undefined && { toolResult: p.tool_result }),
              ...(p.subagent_id !== undefined && { subagentId: p.subagent_id }),
              ...(p.message !== undefined && { message: p.message }),
              ...(p.reason !== undefined && { reason: p.reason }),
            };
            store.addHookEvent(p.session_id, hookEvent);

            if (hookType === "PostToolUse" && p.tool_name) {
              store.recordToolUsage(p.session_id, p.tool_name);
            } else if (hookType === "PostCompact") {
              store.incrementCompactionCount(p.session_id);
            } else if (hookType === "SubagentStart" && p.subagent_id) {
              store.addSubagent(p.session_id, p.subagent_id);
            } else if (hookType === "SubagentStop" && p.subagent_id) {
              store.removeSubagent(p.session_id, p.subagent_id);
            }
          }
        );
        if (cancelled) { fn(); return; }
        unlistenHooks.push(fn);
      }
    })();

    // Clean up module-scoped maps when sessions are removed from the store
    // (handles cases where provider-done never fires, e.g. user closes panel).
    const unsubStore = useProviderSessionStore.subscribe((state, prev) => {
      for (const id of Object.keys(prev.sessions)) {
        if (!state.sessions[id]) {
          cleanupSessionTracking(id);
        }
      }
    });

    return () => {
      cancelled = true;
      clearInterval(fallbackFlush);
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      flushPendingText();
      unsubStore();
      unlistenProvider?.();
      unlistenPerm?.();
      for (const u of unlistenHooks) u();
      pendingText.clear();
    };
  }, []);
}
