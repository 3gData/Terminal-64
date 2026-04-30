import type {
  NormalizedProviderEvent,
  ProviderRuntimeEvent,
} from "../contracts/providerEvents";
import {
  createProviderEventIngestionRouter,
  type ProviderIngestionMessage,
  type ProviderLiveEventDecoder,
  type ProviderLiveEventDecoders,
} from "./providerEventIngestion";
import type { ProviderId } from "./providers";

type VerificationResult = {
  name: string;
  ok: true;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[provider event ingestion verification] ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function legacyPayload(provider: ProviderId, sessionId: string, marker: string): string {
  return JSON.stringify({ provider, sessionId, marker });
}

function runtimeContentEvent(provider: ProviderId, sessionId: string, text: string): ProviderRuntimeEvent {
  return {
    type: "provider.content",
    provider,
    sessionId,
    eventId: `${provider}-${sessionId}-${text}`,
    createdAt: "2026-04-30T00:00:00Z",
    phase: "delta",
    text,
  };
}

function fixtureDecoder(provider: ProviderId): ProviderLiveEventDecoder {
  return {
    decode(sessionId, data): NormalizedProviderEvent[] {
      let marker = data;
      try {
        const parsed = JSON.parse(data) as { marker?: unknown };
        marker = typeof parsed.marker === "string" ? parsed.marker : data;
      } catch {
        marker = data;
      }
      return [{
        kind: "assistant_delta",
        text: `${provider}:${sessionId}:${marker}`,
      }];
    },
    resetSession() {},
  };
}

function eventTexts(messages: ProviderIngestionMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.type !== "event") return [];
    return message.event.kind === "assistant_delta" ? [message.event.text] : [];
  });
}

function visibleTextEvents(messages: ProviderIngestionMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.type !== "event") return [];
    if (message.event.kind === "assistant_delta") return [message.event.text];
    if (message.event.kind === "assistant_message") return [message.event.text];
    return [];
  });
}

function codexLegacyAssistantPayload(id: string, text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: {
      id,
      type: "agent_message",
      text,
    },
  });
}

export function verifyProviderEventIngestionSessionScopedSuppressionFixtures(): VerificationResult {
  const messages: ProviderIngestionMessage[] = [];
  const decoders: ProviderLiveEventDecoders = {
    anthropic: fixtureDecoder("anthropic"),
    openai: fixtureDecoder("openai"),
    cursor: fixtureDecoder("cursor"),
  };
  const router = createProviderEventIngestionRouter((message) => messages.push(message), decoders);

  router.handleProviderEvent({
    provider: "cursor",
    sessionId: "cursor-unified",
    data: JSON.stringify(runtimeContentEvent("cursor", "cursor-unified", "cursor unified")),
    event: runtimeContentEvent("cursor", "cursor-unified", "cursor unified"),
  });
  router.handleLegacyEvent("cursor", {
    session_id: "cursor-unified",
    data: legacyPayload("cursor", "cursor-unified", "suppressed cursor legacy"),
  });
  router.handleLegacyEvent("cursor", {
    session_id: "cursor-legacy",
    data: legacyPayload("cursor", "cursor-legacy", "cursor legacy active"),
  });

  router.handleProviderEvent({
    provider: "anthropic",
    sessionId: "claude-unified",
    data: JSON.stringify(runtimeContentEvent("anthropic", "claude-unified", "claude unified")),
    event: runtimeContentEvent("anthropic", "claude-unified", "claude unified"),
  });
  router.handleLegacyEvent("anthropic", {
    session_id: "claude-unified",
    data: legacyPayload("anthropic", "claude-unified", "suppressed claude legacy"),
  });
  router.handleLegacyEvent("anthropic", {
    session_id: "claude-legacy",
    data: legacyPayload("anthropic", "claude-legacy", "claude legacy active"),
  });

  router.handleProviderEvent({
    provider: "openai",
    sessionId: "openai-unified",
    data: JSON.stringify(runtimeContentEvent("openai", "openai-unified", "openai unified")),
    event: runtimeContentEvent("openai", "openai-unified", "openai unified"),
  });
  router.handleLegacyEvent("openai", {
    session_id: "openai-unified",
    data: legacyPayload("openai", "openai-unified", "suppressed openai legacy"),
  });
  router.handleLegacyEvent("openai", {
    session_id: "openai-legacy",
    data: legacyPayload("openai", "openai-legacy", "openai legacy active"),
  });

  router.handleProviderEvent({
    provider: "openai",
    sessionId: "shared-session",
    data: JSON.stringify(runtimeContentEvent("openai", "shared-session", "openai shared unified")),
    event: runtimeContentEvent("openai", "shared-session", "openai shared unified"),
  });
  router.handleLegacyEvent("anthropic", {
    session_id: "shared-session",
    data: legacyPayload("anthropic", "shared-session", "claude shared legacy active"),
  });
  router.handleLegacyEvent("openai", {
    session_id: "shared-session",
    data: legacyPayload("openai", "shared-session", "suppressed openai shared legacy"),
  });

  const texts = eventTexts(messages);
  assertEqual(texts.length, 8, "mixed provider/session fixture emits only unsuppressed events");
  assert(texts.includes("cursor unified"), "Cursor unified ProviderRuntimeEvent emits");
  assert(texts.includes("cursor:cursor-legacy:cursor legacy active"), "Cursor legacy event for another session remains active");
  assert(texts.includes("claude unified"), "Claude unified ProviderRuntimeEvent emits");
  assert(texts.includes("anthropic:claude-legacy:claude legacy active"), "Claude legacy event for another session remains active");
  assert(texts.includes("openai unified"), "OpenAI unified ProviderRuntimeEvent emits");
  assert(texts.includes("openai:openai-legacy:openai legacy active"), "OpenAI legacy event for another session remains active");
  assert(texts.includes("openai shared unified"), "OpenAI unified event on shared session emits");
  assert(texts.includes("anthropic:shared-session:claude shared legacy active"), "provider/session key keeps same session id isolated by provider");
  assert(!texts.some((text) => text.includes("suppressed")), "legacy events for unified sessions are suppressed");
  assert(router.hasProviderEventSession("openai", "shared-session"), "router records provider-event sessions by provider/session key");
  assert(!router.hasProviderEventSession("anthropic", "shared-session"), "router does not suppress another provider with the same session id");

  return { name: "provider event ingestion session-scoped suppression fixtures", ok: true };
}

export function verifyProviderRuntimeEventEnvelopeMismatchFixtures(): VerificationResult {
  const messages: ProviderIngestionMessage[] = [];
  const decoders: ProviderLiveEventDecoders = {
    anthropic: fixtureDecoder("anthropic"),
    openai: fixtureDecoder("openai"),
    cursor: fixtureDecoder("cursor"),
  };
  const router = createProviderEventIngestionRouter((message) => messages.push(message), decoders);
  const providers: ProviderId[] = ["cursor", "anthropic", "openai"];

  for (const provider of providers) {
    const payloadSession = `${provider}-payload`;
    const eventSession = `${provider}-other`;
    const event = runtimeContentEvent(provider, eventSession, `${provider} leaked unified`);
    router.handleProviderEvent({
      provider,
      sessionId: payloadSession,
      data: JSON.stringify(event),
      event,
    });
    router.handleLegacyEvent(provider, {
      session_id: payloadSession,
      data: legacyPayload(provider, payloadSession, `${provider} legacy after mismatch`),
    });
    assert(
      !router.hasProviderEventSession(provider, payloadSession),
      `${provider} mismatched runtime event does not mark payload session as unified`,
    );
  }

  const providerMismatchEvent = runtimeContentEvent("cursor", "provider-mismatch-session", "wrong provider leaked unified");
  router.handleProviderEvent({
    provider: "openai",
    sessionId: "provider-mismatch-session",
    data: JSON.stringify(providerMismatchEvent),
    event: providerMismatchEvent,
  });
  router.handleLegacyEvent("openai", {
    session_id: "provider-mismatch-session",
    data: legacyPayload("openai", "provider-mismatch-session", "openai legacy after provider mismatch"),
  });

  const texts = eventTexts(messages);
  assertEqual(texts.length, 4, "mismatched ProviderRuntimeEvent envelopes emit only legacy fallbacks");
  assert(texts.includes("cursor:cursor-payload:cursor legacy after mismatch"), "Cursor mismatched runtime event fails closed");
  assert(texts.includes("anthropic:anthropic-payload:anthropic legacy after mismatch"), "Claude mismatched runtime event fails closed");
  assert(texts.includes("openai:openai-payload:openai legacy after mismatch"), "OpenAI mismatched runtime event fails closed");
  assert(
    texts.includes("openai:provider-mismatch-session:openai legacy after provider mismatch"),
    "runtime event provider mismatch does not suppress the envelope provider session",
  );
  assert(!texts.some((text) => text.includes("leaked unified")), "mismatched runtime event payloads are not decoded");
  assert(
    !router.hasProviderEventSession("openai", "provider-mismatch-session"),
    "provider mismatch does not mark the envelope session as unified",
  );

  return { name: "provider runtime event envelope mismatch fixtures", ok: true };
}

export function verifyOpenAiMixedLegacyUnifiedCodexFixtures(): VerificationResult {
  const messages: ProviderIngestionMessage[] = [];
  const router = createProviderEventIngestionRouter((message) => messages.push(message));
  const runtimeEvent = runtimeContentEvent("openai", "openai-runtime", "runtime openai");

  router.handleProviderEvent({
    provider: "openai",
    sessionId: "openai-runtime",
    data: JSON.stringify(runtimeEvent),
    event: runtimeEvent,
  });
  router.handleLegacyEvent("openai", {
    session_id: "openai-runtime",
    data: codexLegacyAssistantPayload("suppressed-runtime-legacy", "suppressed runtime legacy"),
  });

  router.handleLegacyEvent("openai", {
    session_id: "openai-legacy",
    data: codexLegacyAssistantPayload("openai-legacy-message", "legacy openai"),
  });

  router.handleProviderEvent({
    provider: "openai",
    sessionId: "openai-provider-legacy",
    data: codexLegacyAssistantPayload("openai-provider-legacy-message", "provider-event legacy openai"),
  });
  router.handleLegacyEvent("openai", {
    session_id: "openai-provider-legacy",
    data: codexLegacyAssistantPayload("suppressed-provider-legacy", "suppressed provider legacy"),
  });

  const texts = visibleTextEvents(messages);
  assertEqual(texts.length, 3, "OpenAI mixed legacy/unified fixture emits only active Codex streams");
  assert(texts.includes("runtime openai"), "OpenAI ProviderRuntimeEvent emits through the canonical path");
  assert(texts.includes("legacy openai"), "OpenAI legacy codex-event fallback remains active for legacy-only sessions");
  assert(texts.includes("provider-event legacy openai"), "OpenAI legacy provider-event data still decodes through Codex fallback");
  assert(!texts.some((text) => text.includes("suppressed")), "OpenAI duplicate legacy streams are suppressed per session");
  assert(router.hasProviderEventSession("openai", "openai-runtime"), "OpenAI runtime session is marked unified");
  assert(router.hasProviderEventSession("openai", "openai-provider-legacy"), "OpenAI provider-event legacy session suppresses duplicate codex-event data");
  assert(!router.hasProviderEventSession("openai", "openai-legacy"), "OpenAI codex-event-only session remains legacy");

  return { name: "openai mixed legacy/unified codex fixtures", ok: true };
}

export function runProviderEventIngestionVerification(): VerificationResult[] {
  return [
    verifyProviderEventIngestionSessionScopedSuppressionFixtures(),
    verifyProviderRuntimeEventEnvelopeMismatchFixtures(),
    verifyOpenAiMixedLegacyUnifiedCodexFixtures(),
  ];
}
