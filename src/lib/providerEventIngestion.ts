import type { NormalizedProviderEvent } from "../contracts/providerEvents";
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
type ProviderLiveEventDecoder = {
  decode(sessionId: string, data: string): NormalizedProviderEvent[];
  resetSession(sessionId: string): void;
};

const contextWindowResolvers: Partial<Record<ProviderId, ContextWindowResolver>> = {
  anthropic: (model) => getClaudeContextWindowForModel(model || ""),
  openai: getCodexContextWindow,
  cursor: () => 200_000,
};

export function getProviderEventContextWindow(
  provider: ProviderId,
  model: string | undefined | null,
): number {
  return contextWindowResolvers[provider]?.(model) ?? 200_000;
}

export async function subscribeProviderEventIngestion(
  listener: ProviderIngestionListener,
): Promise<() => void> {
  const claudeDecoder = new ClaudeLiveEventDecoder();
  const codexDecoder = new CodexLiveEventDecoder();
  const cursorDecoder = new CursorLiveEventDecoder();
  const decoders: Record<ProviderId, ProviderLiveEventDecoder> = {
    anthropic: claudeDecoder,
    openai: codexDecoder,
    cursor: cursorDecoder,
  };
  const providersWithUnifiedEvents = new Set<ProviderId>();
  const unlistens: (() => void)[] = [];
  let disposed = false;

  const emit = (message: ProviderIngestionMessage) => {
    if (disposed) return;
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

  const providerEventUnlisten = await onProviderEvent((payload) => {
    if (!isProviderId(payload.provider)) {
      console.warn("[provider-events] unknown provider-event provider", payload.provider);
      return;
    }
    providersWithUnifiedEvents.add(payload.provider);
    emitDecodedEvents(payload.provider, payload.sessionId, payload.data);
  });
  unlistens.push(providerEventUnlisten);
  if (disposed) {
    providerEventUnlisten();
    return () => {};
  }

  const claudeEventUnlisten = await onClaudeEvent((payload) => {
    if (providersWithUnifiedEvents.has("anthropic")) return;
    emitDecodedEvents("anthropic", payload.session_id, payload.data);
  });
  unlistens.push(claudeEventUnlisten);
  if (disposed) {
    claudeEventUnlisten();
    return () => {};
  }

  const claudeDoneUnlisten = await onClaudeDone((payload) => {
    decoders.anthropic.resetSession(payload.session_id);
    emit({
      type: "done",
      provider: "anthropic",
      sessionId: payload.session_id,
    });
  });
  unlistens.push(claudeDoneUnlisten);
  if (disposed) {
    claudeDoneUnlisten();
    return () => {};
  }

  const codexEventUnlisten = await onCodexEvent((payload) => {
    if (providersWithUnifiedEvents.has("openai")) return;
    emitDecodedEvents("openai", payload.session_id, payload.data);
  });
  unlistens.push(codexEventUnlisten);
  if (disposed) {
    codexEventUnlisten();
    return () => {};
  }

  const codexDoneUnlisten = await onCodexDone((payload) => {
    decoders.openai.resetSession(payload.session_id);
    emit({
      type: "done",
      provider: "openai",
      sessionId: payload.session_id,
    });
  });
  unlistens.push(codexDoneUnlisten);

  return () => {
    disposed = true;
    for (const unlisten of unlistens) unlisten();
  };
}
