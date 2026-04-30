import {
  isProviderRuntimeEvent,
  providerRuntimeEventToNormalized,
  type NormalizedProviderEvent,
  type ProviderRuntimeEvent,
} from "../contracts/providerEvents";
import { ClaudeLiveEventDecoder, getClaudeContextWindowForModel } from "./claudeEventDecoder";
import { CodexLiveEventDecoder, getCodexContextWindow } from "./codexEventDecoder";
import { CursorLiveEventDecoder } from "./cursorEventDecoder";
import { isProviderId, type ProviderId } from "./providers";
import { onClaudeDone, onClaudeEvent, onCodexDone, onCodexEvent, onProviderEvent } from "./tauriApi";

export type ProviderIngestionMessage =
  | {
      type: "event";
      provider: ProviderId;
      sessionId: string;
      event: NormalizedProviderEvent;
    }
  | {
      type: "done";
      provider: ProviderId;
      sessionId: string;
    };

export type ProviderIngestionListener = (message: ProviderIngestionMessage) => void;

type ContextWindowResolver = (model: string | undefined | null) => number;
export type ProviderLiveEventDecoder = {
  decode(sessionId: string, data: string): NormalizedProviderEvent[];
  decodeRuntimeEvent?: (sessionId: string, event: ProviderRuntimeEvent) => NormalizedProviderEvent[];
  resetSession(sessionId: string): void;
};

export type ProviderLiveEventDecoders = Record<ProviderId, ProviderLiveEventDecoder>;

export interface ProviderEventEnvelopePayload {
  provider: string;
  sessionId: string;
  data: string;
  event?: unknown;
}

export interface ProviderProcessEventPayload {
  session_id: string;
  data: string;
}

export interface ProviderProcessDonePayload {
  session_id: string;
}

export interface ProviderEventIngestionRouter {
  handleProviderEvent(payload: ProviderEventEnvelopePayload): void;
  handleLegacyEvent(provider: ProviderId, payload: ProviderProcessEventPayload): void;
  handleDone(provider: ProviderId, payload: ProviderProcessDonePayload): void;
  hasProviderEventSession(provider: ProviderId, sessionId: string): boolean;
}

const contextWindowResolvers: Partial<Record<ProviderId, ContextWindowResolver>> = {
  anthropic: (model) => getClaudeContextWindowForModel(model || ""),
  openai: getCodexContextWindow,
  cursor: () => 200_000,
};

function providerEventSessionKey(provider: ProviderId, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function createProviderLiveEventDecoders(): ProviderLiveEventDecoders {
  const claudeDecoder = new ClaudeLiveEventDecoder();
  const codexDecoder = new CodexLiveEventDecoder();
  const cursorDecoder = new CursorLiveEventDecoder();
  return {
    anthropic: claudeDecoder,
    openai: codexDecoder,
    cursor: {
      decode: (sessionId, data) => cursorDecoder.decode(sessionId, data),
      decodeRuntimeEvent: (sessionId, event) => cursorDecoder.decode(sessionId, JSON.stringify(event)),
      resetSession: (sessionId) => cursorDecoder.resetSession(sessionId),
    },
  };
}

function runtimeEventFromData(data: string): ProviderRuntimeEvent | null {
  if (!data.includes('"provider.')) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return isProviderRuntimeEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function runtimeEventFromPayload(payload: ProviderEventEnvelopePayload): ProviderRuntimeEvent | null {
  if (isProviderRuntimeEvent(payload.event)) return payload.event;
  return runtimeEventFromData(payload.data);
}

function dataFromProviderEventPayload(payload: ProviderEventEnvelopePayload): string {
  if (payload.event === undefined || payload.event === null) return payload.data;
  const serialized = JSON.stringify(payload.event);
  return typeof serialized === "string" ? serialized : payload.data;
}

function runtimeEventMatchesEnvelope(
  provider: ProviderId,
  sessionId: string,
  event: ProviderRuntimeEvent,
): boolean {
  return event.provider === provider && event.sessionId === sessionId;
}

export function getProviderEventContextWindow(
  provider: ProviderId,
  model: string | undefined | null,
): number {
  return contextWindowResolvers[provider]?.(model) ?? 200_000;
}

export function createProviderEventIngestionRouter(
  listener: ProviderIngestionListener,
  decoders: ProviderLiveEventDecoders = createProviderLiveEventDecoders(),
): ProviderEventIngestionRouter {
  const sessionsWithProviderEvents = new Set<string>();
  const emit = (message: ProviderIngestionMessage) => {
    try {
      listener(message);
    } catch (err) {
      console.warn("[provider-events] listener failed", err);
    }
  };

  const emitDecodedEvents = (provider: ProviderId, sessionId: string, data: string) => {
    for (const event of decoders[provider].decode(sessionId, data)) {
      emit({
        type: "event",
        provider,
        sessionId,
        event,
      });
    }
  };

  const emitRuntimeEvent = (provider: ProviderId, sessionId: string, event: ProviderRuntimeEvent) => {
    const decodeRuntimeEvent = decoders[provider].decodeRuntimeEvent ?? (
      (_sessionId: string, runtimeEvent: ProviderRuntimeEvent) => providerRuntimeEventToNormalized(runtimeEvent)
    );
    for (const normalized of decodeRuntimeEvent(sessionId, event)) {
      emit({
        type: "event",
        provider,
        sessionId,
        event: normalized,
      });
    }
  };

  return {
    handleProviderEvent(payload) {
      if (!isProviderId(payload.provider)) {
        console.warn("[provider-events] unknown provider-event provider", payload.provider);
        return;
      }
      const provider = payload.provider;
      const runtimeEvent = runtimeEventFromPayload(payload);
      if (runtimeEvent) {
        if (!runtimeEventMatchesEnvelope(provider, payload.sessionId, runtimeEvent)) {
          console.warn("[provider-events] dropping mismatched ProviderRuntimeEvent envelope", {
            envelopeProvider: provider,
            envelopeSessionId: payload.sessionId,
            eventProvider: runtimeEvent.provider,
            eventSessionId: runtimeEvent.sessionId,
          });
          return;
        }
        sessionsWithProviderEvents.add(providerEventSessionKey(provider, payload.sessionId));
        emitRuntimeEvent(provider, payload.sessionId, runtimeEvent);
        return;
      }
      sessionsWithProviderEvents.add(providerEventSessionKey(provider, payload.sessionId));
      emitDecodedEvents(provider, payload.sessionId, dataFromProviderEventPayload(payload));
    },
    handleLegacyEvent(provider, payload) {
      if (sessionsWithProviderEvents.has(providerEventSessionKey(provider, payload.session_id))) return;
      emitDecodedEvents(provider, payload.session_id, payload.data);
    },
    handleDone(provider, payload) {
      decoders[provider].resetSession(payload.session_id);
      emit({
        type: "done",
        provider,
        sessionId: payload.session_id,
      });
    },
    hasProviderEventSession(provider, sessionId) {
      return sessionsWithProviderEvents.has(providerEventSessionKey(provider, sessionId));
    },
  };
}

export async function subscribeProviderEventIngestion(
  listener: ProviderIngestionListener,
): Promise<() => void> {
  const unlistens: (() => void)[] = [];
  let disposed = false;
  const router = createProviderEventIngestionRouter((message) => {
    if (!disposed) listener(message);
  });

  const providerEventUnlisten = await onProviderEvent((payload) => {
    router.handleProviderEvent(payload);
  });
  unlistens.push(providerEventUnlisten);
  if (disposed) {
    providerEventUnlisten();
    return () => {};
  }

  const claudeEventUnlisten = await onClaudeEvent((payload) => {
    router.handleLegacyEvent("anthropic", payload);
  });
  unlistens.push(claudeEventUnlisten);
  if (disposed) {
    claudeEventUnlisten();
    return () => {};
  }

  const claudeDoneUnlisten = await onClaudeDone((payload) => {
    router.handleDone("anthropic", payload);
  });
  unlistens.push(claudeDoneUnlisten);
  if (disposed) {
    claudeDoneUnlisten();
    return () => {};
  }

  const codexEventUnlisten = await onCodexEvent((payload) => {
    router.handleLegacyEvent("openai", payload);
  });
  unlistens.push(codexEventUnlisten);
  if (disposed) {
    codexEventUnlisten();
    return () => {};
  }

  const codexDoneUnlisten = await onCodexDone((payload) => {
    router.handleDone("openai", payload);
  });
  unlistens.push(codexDoneUnlisten);

  return () => {
    disposed = true;
    for (const unlisten of unlistens) unlisten();
  };
}
