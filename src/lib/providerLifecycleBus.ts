import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { NormalizedProviderEvent } from "../contracts/providerEvents";
import { resolveSessionProviderState, useProviderSessionStore } from "../stores/providerSessionStore";
import type { ProviderId } from "./providers";

export type ProviderLifecycleSource = "claude_hook" | "provider_event" | "store";

interface ProviderLifecycleBase {
  sessionId: string;
  provider: ProviderId;
  source: ProviderLifecycleSource;
  timestamp: number;
}

export type ProviderLifecycleEvent =
  | (ProviderLifecycleBase & { kind: "turn_started" })
  | (ProviderLifecycleBase & { kind: "turn_completed"; error?: string })
  | (ProviderLifecycleBase & { kind: "agent_harness_started"; harnessId?: string })
  | (ProviderLifecycleBase & { kind: "agent_harness_completed"; harnessId?: string; reason?: string });

type ProviderLifecycleListener = (event: ProviderLifecycleEvent) => void;

const lifecycleListeners = new Set<ProviderLifecycleListener>();

let lifecycleSourceRefs = 0;
let lifecycleSourceStart: Promise<() => void> | null = null;
let activeLifecycleDispose: (() => void) | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function subscribeProviderLifecycle(listener: ProviderLifecycleListener): () => void {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
}

export function publishProviderLifecycle(event: ProviderLifecycleEvent) {
  for (const listener of [...lifecycleListeners]) {
    try {
      listener(event);
    } catch (err) {
      console.warn("[provider-lifecycle] listener failed", err);
    }
  }
}

export function normalizeProviderLifecycleFromProviderEvent(input: {
  sessionId: string;
  provider: ProviderId;
  event: NormalizedProviderEvent;
  timestamp?: number;
}): ProviderLifecycleEvent | null {
  const timestamp = input.timestamp ?? Date.now();
  if (input.event.kind === "turn_started") {
    return {
      kind: "turn_started",
      sessionId: input.sessionId,
      provider: input.provider,
      source: "provider_event",
      timestamp,
    };
  }
  if (input.event.kind === "turn_completed") {
    return {
      kind: "turn_completed",
      sessionId: input.sessionId,
      provider: input.provider,
      source: "provider_event",
      timestamp,
      ...(input.event.error ? { error: input.event.error } : {}),
    };
  }
  return null;
}

export function publishProviderLifecycleFromProviderEvent(input: {
  sessionId: string;
  provider: ProviderId;
  event: NormalizedProviderEvent;
  timestamp?: number;
}): ProviderLifecycleEvent | null {
  const lifecycleEvent = normalizeProviderLifecycleFromProviderEvent(input);
  if (lifecycleEvent) publishProviderLifecycle(lifecycleEvent);
  return lifecycleEvent;
}

export function normalizeClaudeHookLifecycleEvent(
  payload: unknown,
  expectedHookType?: "SubagentStart" | "SubagentStop",
  timestamp = Date.now(),
): ProviderLifecycleEvent | null {
  const record = asRecord(payload);
  if (!record) return null;

  const nested = asRecord(record.payload);
  const eventName = stringField(record, "event_name")
    ?? stringField(record, "hook_type")
    ?? stringField(nested, "hook_event_name")
    ?? expectedHookType
    ?? "";
  if (eventName !== "SubagentStart" && eventName !== "SubagentStop") return null;

  const sessionId = stringField(record, "session_id") ?? stringField(nested, "session_id");
  if (!sessionId) return null;

  const harnessId = stringField(record, "subagent_id")
    ?? stringField(nested, "subagent_id")
    ?? stringField(record, "agent_id")
    ?? stringField(nested, "agent_id");
  const reason = stringField(record, "reason") ?? stringField(nested, "reason");

  const base = {
    sessionId,
    provider: "anthropic" as const,
    source: "claude_hook" as const,
    timestamp,
  };
  if (eventName === "SubagentStart") {
    return {
      ...base,
      kind: "agent_harness_started",
      ...(harnessId ? { harnessId } : {}),
    };
  }
  return {
    ...base,
    kind: "agent_harness_completed",
    ...(harnessId ? { harnessId } : {}),
    ...(reason ? { reason } : {}),
  };
}

async function startClaudeHookLifecycleSource(): Promise<() => void> {
  const hookTypes = ["SubagentStart", "SubagentStop"] as const;
  const unlistens: UnlistenFn[] = await Promise.all(
    hookTypes.map((hookType) => listen<unknown>(`claude-hook-${hookType}`, (event) => {
      const lifecycleEvent = normalizeClaudeHookLifecycleEvent(event.payload, hookType);
      if (lifecycleEvent) publishProviderLifecycle(lifecycleEvent);
    })),
  );

  return () => {
    for (const unlisten of unlistens) unlisten();
  };
}

function startProviderStoreTurnLifecycleSource(): () => void {
  return useProviderSessionStore.subscribe((state, prev) => {
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      const wasStreaming = prev.sessions[sessionId]?.isStreaming ?? false;
      if (wasStreaming === session.isStreaming) continue;

      const provider = resolveSessionProviderState(session).provider;
      publishProviderLifecycle({
        kind: session.isStreaming ? "turn_started" : "turn_completed",
        sessionId,
        provider,
        source: "store",
        timestamp: Date.now(),
      });
    }
  });
}

async function startProviderLifecycleSources(): Promise<() => void> {
  const disposers: (() => void)[] = [startProviderStoreTurnLifecycleSource()];
  try {
    const disposeClaudeHooks = await startClaudeHookLifecycleSource();
    disposers.push(disposeClaudeHooks);
  } catch (err) {
    for (const dispose of disposers) dispose();
    throw err;
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export async function retainProviderLifecycleSources(): Promise<() => void> {
  lifecycleSourceRefs += 1;
  if (!lifecycleSourceStart) {
    lifecycleSourceStart = startProviderLifecycleSources()
      .then((dispose) => {
        activeLifecycleDispose = dispose;
        return dispose;
      })
      .catch((err: unknown) => {
        lifecycleSourceRefs = 0;
        lifecycleSourceStart = null;
        activeLifecycleDispose = null;
        throw err;
      });
  }

  await lifecycleSourceStart;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lifecycleSourceRefs = Math.max(0, lifecycleSourceRefs - 1);
    if (lifecycleSourceRefs === 0) {
      activeLifecycleDispose?.();
      activeLifecycleDispose = null;
      lifecycleSourceStart = null;
    }
  };
}
