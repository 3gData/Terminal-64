import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  providerToolChangedPaths,
  type NormalizedProviderEvent,
  type ProviderToolCall,
  type ProviderToolInput,
  type ProviderToolResult,
} from "../contracts/providerEvents";
import { publishProviderLifecycleFromProviderEvent } from "../lib/providerLifecycleBus";
import {
  getProviderEventContextWindow,
  subscribeProviderEventIngestion,
  type ProviderIngestionMessage,
} from "../lib/providerEventIngestion";
import { cancelProviderSession } from "../lib/tauriApi";
import { getProviderManifest, providerSupports, type ProviderId } from "../lib/providers";
import { runProviderTurn } from "../lib/providerRuntime";
import type { HookEvent, HookEventPayload, HookEventType, ToolCall } from "../lib/types";
import type { PermissionRequestPayload } from "../lib/claudeEventDecoder";
import { useSettingsStore } from "../stores/settingsStore";
import {
  getOpenAiProviderSessionMetadata,
  resolveSessionProviderState,
  useProviderSessionStore,
  type ProviderTask,
  type McpServerStatus,
  type PendingQuestionItem,
} from "../stores/claudeStore";

const sessionToolMaps = new Map<string, Map<string, string>>();
const sessionFilePathMaps = new Map<string, Map<string, string>>();

const MAX_TOOL_MAP_ENTRIES = 2000;
function getSessionMap<V>(store: Map<string, Map<string, V>>, sessionId: string): Map<string, V> {
  let map = store.get(sessionId);
  if (!map) {
    map = new Map<string, V>();
    store.set(sessionId, map);
  }
  return map;
}

function evictIfNeeded<V>(map: Map<string, V>) {
  if (map.size > MAX_TOOL_MAP_ENTRIES) {
    const excess = map.size - MAX_TOOL_MAP_ENTRIES;
    const iter = map.keys();
    for (let i = 0; i < excess; i++) { map.delete(iter.next().value!); }
  }
}

function normalizeMcpServerStatus(raw: unknown): McpServerStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = obj.name ?? obj.server ?? obj.serverName;
  if (typeof name !== "string" || !name) return null;
  const rawStatus = obj.status ?? obj.startupStatus;
  const status = rawStatus === "ready" ? "connected" : String(rawStatus || "unknown");
  const tools = Array.isArray(obj.tools) ? obj.tools.map((tool) => {
    if (!tool || typeof tool !== "object") return { name: "" };
    const t = tool as Record<string, unknown>;
    return {
      name: String(t.name || ""),
      ...(t.description ? { description: String(t.description) } : {}),
    };
  }).filter((tool) => tool.name.length > 0) : undefined;
  return {
    name,
    status,
    ...(obj.error ? { error: String(obj.error) } : {}),
    ...(obj.type || obj.transport ? { transport: String(obj.type || obj.transport) } : {}),
    ...(obj.scope ? { scope: String(obj.scope) } : {}),
    ...(tools ? { tools, toolCount: tools.length } : {}),
  };
}

function mcpServerKey(name: string): string {
  return name === "t64" || name === "terminal-64" ? "terminal-64" : name;
}

function mergeMcpServerStatuses(current: McpServerStatus[], incoming: McpServerStatus[]): McpServerStatus[] {
  const merged = new Map<string, McpServerStatus>();
  for (const server of current) {
    merged.set(mcpServerKey(server.name), server);
  }
  for (const server of incoming) {
    const key = mcpServerKey(server.name);
    const previous = merged.get(key);
    const next: McpServerStatus = {
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

// Tools hidden from the UI (handled internally by the wrapper).
const HIDDEN_TOOLS = new Set([
  "EnterPlanMode", "ExitPlanMode",
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop",
]);

interface ProviderQuestion {
  question?: string;
  text?: string;
  description?: string;
  header?: string;
  options?: (string | { label?: string; description?: string })[];
  multiSelect?: boolean;
}

async function runAutoCompact(sessionId: string) {
  const store = useProviderSessionStore.getState();
  const session = store.sessions[sessionId];
  if (!session || session.isStreaming) return;

  const providerState = resolveSessionProviderState(session);
  if (!providerSupports(providerState.provider, "compact")) return;

  const manifest = getProviderManifest(providerState.provider);
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
      selectedModel: providerState.selectedModel ?? manifest.defaultModel,
      selectedEffort: providerState.selectedEffort ?? manifest.defaultEffort,
      selectedCodexPermission: openAiMetadata?.selectedCodexPermission ?? manifest.defaultPermission,
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

function toolQuestions(input: ProviderToolInput): ProviderQuestion[] {
  const rawInput: unknown = input;
  if (Array.isArray(rawInput)) return rawInput as ProviderQuestion[];
  if (input.question || input.options) return [input as ProviderQuestion];
  const vals = Object.values(input);
  const arr = vals.find((v) => Array.isArray(v));
  if (arr) return arr as ProviderQuestion[];
  return [{ question: (input.description as string) || (input.text as string) || "The assistant has a question", options: [] }];
}

function applyToolCallSideEffects(
  sessionId: string,
  provider: ProviderId,
  toolCall: ProviderToolCall,
  store: ReturnType<typeof useProviderSessionStore.getState>,
): ToolCall | null {
  const name = toolCall.name;
  const toolId = toolCall.id;
  const input = toolCall.input;
  const toolMap = getSessionMap(sessionToolMaps, sessionId);
  toolMap.set(toolId, name);
  evictIfNeeded(toolMap);

  if ((name === "Write" || name === "Edit" || name === "MultiEdit") && input.file_path) {
    const fileMap = getSessionMap(sessionFilePathMaps, sessionId);
    fileMap.set(toolId, String(input.file_path));
    evictIfNeeded(fileMap);
  }

  if (name === "EnterPlanMode") {
    store.setPlanMode(sessionId, true);
  } else if (name === "ExitPlanMode") {
    store.setPlanMode(sessionId, false);
  } else if (name === "AskUserQuestion") {
    const items: PendingQuestionItem[] = toolQuestions(input).map((q) => ({
      question: q.question || q.text || q.description || "Question",
      ...(q.header !== undefined ? { header: q.header } : {}),
      options: (q.options || []).map((o) =>
        typeof o === "string"
          ? { label: o }
          : {
              label: o.label || String(o),
              ...(o.description !== undefined ? { description: o.description } : {}),
            }
      ),
      multiSelect: q.multiSelect || false,
    }));

    if (items.length > 0) {
      store.setPendingQuestions(sessionId, {
        toolUseId: toolId,
        items,
        currentIndex: 0,
        answers: [],
      });
      cancelProviderSession(sessionId, provider).catch(() => {});
      store.setStreaming(sessionId, false);
    }
  } else if (name === "TaskCreate") {
    const task: ProviderTask = {
      id: toolId,
      subject: String(input.subject || input.title || "Task"),
      status: "pending",
      ...(input.description ? { description: String(input.description) } : {}),
    };
    store.addTask(sessionId, task);
  } else if (name === "TaskUpdate") {
    if (input.taskId) {
      store.updateTask(sessionId, String(input.taskId), {
        ...(input.status ? { status: String(input.status) as ProviderTask["status"] } : {}),
        ...(input.subject ? { subject: String(input.subject) } : {}),
      });
    }
  }

  return HIDDEN_TOOLS.has(name) ? null : toolCall;
}

function applyAssistantMessage(
  sessionId: string,
  provider: ProviderId,
  event: Extract<NormalizedProviderEvent, { kind: "assistant_message" }>,
  store: ReturnType<typeof useProviderSessionStore.getState>,
) {
  const session = store.sessions[sessionId];
  const text = event.useBufferedText && !event.text
    ? session?.streamingText || ""
    : event.text;
  const visibleToolCalls: ToolCall[] = [];
  for (const toolCall of event.toolCalls || []) {
    const visible = applyToolCallSideEffects(sessionId, provider, toolCall, store);
    if (visible) visibleToolCalls.push(visible);
  }

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
  options?: { trackModifiedFiles?: boolean },
) {
  const toolName = getSessionMap(sessionToolMaps, sessionId).get(toolResult.id);

  if (toolName === "TaskCreate" && toolResult.result) {
    const match = toolResult.result.match(/#(\d+)/);
    const newId = match?.[1];
    if (newId) {
      const s = useProviderSessionStore.getState();
      const session = s.sessions[sessionId];
      if (session) {
        const newTasks = session.tasks.map((t) =>
          t.id === toolResult.id ? { ...t, id: newId } : t
        );
        useProviderSessionStore.setState({
          sessions: { ...s.sessions, [sessionId]: { ...session, tasks: newTasks } },
        });
      }
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
      store.addModifiedFiles(sessionId, [...changedPaths]);
    }
  }

  if (toolName && HIDDEN_TOOLS.has(toolName)) return;
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

function handleMcpStatus(
  sessionId: string,
  event: Extract<NormalizedProviderEvent, { kind: "mcp_status" }>,
  store: ReturnType<typeof useProviderSessionStore.getState>,
) {
  const incoming = event.servers
    .map((server) => normalizeMcpServerStatus(server))
    .filter((server): server is McpServerStatus => server != null);
  if (incoming.length === 0) return;
  const current = store.sessions[sessionId]?.mcpServers ?? [];
  store.setMcpServers(sessionId, mergeMcpServerStatuses(current, incoming));
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
  store: ReturnType<typeof useProviderSessionStore.getState>,
) {
  flushBeforeFinalization();
  const session = store.sessions[sessionId];
  if (session?.streamingText?.trim()) {
    store.finalizeAssistantMessage(sessionId, session.streamingText.trim());
  }

  store.setStreaming(sessionId, false);
  store.clearStreamingText(sessionId);

  if (event.costUsd) store.addCost(sessionId, event.costUsd);
  const totalTokens = event.totalTokens
    ?? ((event.inputTokens ?? event.usage?.input_tokens ?? 0) + (event.outputTokens ?? event.usage?.output_tokens ?? 0));
  if (totalTokens > 0) store.addTokens(sessionId, totalTokens);

  const latestSession = useProviderSessionStore.getState().sessions[sessionId];
  if (latestSession) {
    const providerState = resolveSessionProviderState(latestSession);
    const model = providerState.selectedModel ?? latestSession.model ?? null;
    const modelContextMax = getProviderEventContextWindow(provider, model);
    let contextMax = event.contextMax ?? latestSession.contextMax ?? modelContextMax;
    if (modelContextMax > contextMax) contextMax = modelContextMax;
    if (contextMax !== (latestSession.contextMax || 0)) {
      store.setContextUsage(sessionId, latestSession.contextUsed || 0, contextMax);
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

  if (event.error) store.setError(sessionId, event.error);
}

function cleanupSessionTracking(sessionId: string) {
  sessionToolMaps.delete(sessionId);
  sessionFilePathMaps.delete(sessionId);
  pendingText.delete(sessionId);
}

function handleProviderEvent(message: ProviderIngestionMessage) {
  const store = useProviderSessionStore.getState();
  const { sessionId, provider } = message;

  if (message.type === "done") {
    flushBeforeFinalization();
    const session = store.sessions[sessionId];
    if (session?.streamingText?.trim()) {
      store.finalizeAssistantMessage(sessionId, session.streamingText.trim());
    }
    const current = useProviderSessionStore.getState().sessions[sessionId];
    if (current && !current.isStreaming) {
      store.setStreaming(sessionId, true);
    }
    store.setStreaming(sessionId, false);
    store.clearStreamingText(sessionId);
    cleanupSessionTracking(sessionId);
    return;
  }

  const event = message.event;
  const wasStreaming = !!store.sessions[sessionId]?.isStreaming;
  markProviderEventLive(sessionId, event, store);

  if (event.kind === "assistant_message" || event.kind === "turn_completed") {
    flushBeforeFinalization();
  }

  switch (event.kind) {
    case "session_started":
      handleSessionStarted(sessionId, provider, event, store);
      break;
    case "mcp_status":
      handleMcpStatus(sessionId, event, store);
      break;
    case "turn_started":
      store.setStreaming(sessionId, true);
      if (event.resetStreamingText) store.clearStreamingText(sessionId);
      break;
    case "assistant_delta": {
      const existing = pendingText.get(sessionId) || "";
      pendingText.set(sessionId, existing + event.text);
      scheduleFlush();
      break;
    }
    case "assistant_message":
      applyAssistantMessage(sessionId, provider, event, store);
      break;
    case "tool_call":
      applyAssistantMessage(sessionId, provider, { kind: "assistant_message", text: "", toolCalls: [event.toolCall] }, store);
      break;
    case "tool_update":
      store.updateToolCall(sessionId, event.id, event.patch);
      if (event.result) applyToolResult(sessionId, event.result, store, { trackModifiedFiles: false });
      break;
    case "tool_result":
      applyToolResult(sessionId, event.toolResult, store);
      break;
    case "usage":
      handleUsage(sessionId, provider, event, store);
      break;
    case "turn_completed":
      handleTurnCompleted(sessionId, provider, event, store);
      break;
    case "error":
      store.setError(sessionId, event.message);
      if (event.terminal !== false) {
        store.setStreaming(sessionId, false);
        store.clearStreamingText(sessionId);
        cleanupSessionTracking(sessionId);
      }
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

/** @deprecated Use useProviderEvents. */
export const useClaudeEvents = useProviderEvents;
