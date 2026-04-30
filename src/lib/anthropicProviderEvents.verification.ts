import type {
  NormalizedProviderEvent,
  ProviderRuntimeEvent,
  ProviderToolCall,
} from "../contracts/providerEvents";
import {
  createProviderEventIngestionRouter,
  type ProviderIngestionMessage,
} from "./providerEventIngestion";

type VerificationResult = {
  name: string;
  ok: true;
};

type HydratedClaudeState = {
  isStreaming: boolean;
  streamingText: string;
  model: string | null;
  contextMax: number;
  mcpServers: unknown[];
  assistantMessages: Array<{ text: string; toolCalls: ProviderToolCall[] }>;
  tokens: number;
  error: string | null;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[anthropic provider event verification] ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function runtimeEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  return event;
}

function applyHydrationEvent(state: HydratedClaudeState, event: NormalizedProviderEvent): void {
  switch (event.kind) {
    case "session_started":
      state.isStreaming = true;
      state.model = event.model ?? state.model;
      state.contextMax = event.contextMax ?? state.contextMax;
      break;
    case "mcp_status":
      state.mcpServers = event.servers;
      break;
    case "turn_started":
      state.isStreaming = true;
      if (event.resetStreamingText) state.streamingText = "";
      break;
    case "assistant_delta":
      state.streamingText += event.text;
      break;
    case "assistant_message": {
      const text = event.useBufferedText && !event.text ? state.streamingText : event.text;
      state.assistantMessages.push({
        text,
        toolCalls: event.toolCalls ?? [],
      });
      state.streamingText = "";
      break;
    }
    case "tool_result": {
      for (const message of state.assistantMessages) {
        const toolCall = message.toolCalls.find((call) => call.id === event.toolResult.id);
        if (toolCall) {
          toolCall.result = event.toolResult.result;
          toolCall.isError = event.toolResult.isError;
        }
      }
      break;
    }
    case "turn_completed":
      state.isStreaming = false;
      state.tokens += event.totalTokens ?? event.usage?.total_tokens ?? 0;
      if (event.contextMax !== undefined) state.contextMax = event.contextMax;
      if (event.error) state.error = event.error;
      break;
    case "error":
      state.error = event.message;
      if (event.terminal !== false) state.isStreaming = false;
      break;
    case "usage":
      state.contextMax = event.contextMax ?? state.contextMax;
      break;
    case "tool_call":
    case "tool_update":
      break;
  }
}

function emitRuntime(
  messages: ProviderIngestionMessage[],
  event: ProviderRuntimeEvent,
): ProviderIngestionMessage[] {
  const before = messages.length;
  const router = createProviderEventIngestionRouter((message) => messages.push(message));
  router.handleProviderEvent({
    provider: "anthropic",
    sessionId: event.sessionId,
    data: JSON.stringify(event),
    event,
  });
  return messages.slice(before);
}

export function verifyAnthropicRuntimeEventHydratesUiStateFixture(): VerificationResult {
  const messages: ProviderIngestionMessage[] = [];
  const router = createProviderEventIngestionRouter((message) => messages.push(message));
  const state: HydratedClaudeState = {
    isStreaming: false,
    streamingText: "",
    model: null,
    contextMax: 0,
    mcpServers: [],
    assistantMessages: [],
    tokens: 0,
    error: null,
  };

  const events = [
    runtimeEvent({
      type: "provider.session",
      provider: "anthropic",
      sessionId: "claude-runtime-ui",
      eventId: "claude-session",
      createdAt: "2026-04-30T00:00:00Z",
      phase: "started",
      threadId: "native-claude-session",
      model: "sonnet[1m]",
      contextMax: 1_000_000,
    }),
    runtimeEvent({
      type: "provider.mcp",
      provider: "anthropic",
      sessionId: "claude-runtime-ui",
      eventId: "claude-mcp",
      createdAt: "2026-04-30T00:00:01Z",
      phase: "status",
      servers: [{ name: "terminal-64", status: "ready" }],
    }),
    runtimeEvent({
      type: "provider.turn",
      provider: "anthropic",
      sessionId: "claude-runtime-ui",
      eventId: "claude-turn-start",
      createdAt: "2026-04-30T00:00:02Z",
      phase: "started",
      resetStreamingText: true,
    }),
    runtimeEvent({
      type: "provider.content",
      provider: "anthropic",
      sessionId: "claude-runtime-ui",
      eventId: "claude-delta",
      createdAt: "2026-04-30T00:00:03Z",
      phase: "delta",
      role: "assistant",
      text: "Inspecting ",
    }),
    runtimeEvent({
      type: "provider.content",
      provider: "anthropic",
      sessionId: "claude-runtime-ui",
      eventId: "claude-message",
      createdAt: "2026-04-30T00:00:04Z",
      phase: "message",
      role: "assistant",
      text: "",
      useBufferedText: true,
      toolCalls: [{
        id: "tool-1",
        name: "Read",
        input: { file_path: "src/main.ts" },
      }],
    }),
    runtimeEvent({
      type: "provider.tool",
      provider: "anthropic",
      sessionId: "claude-runtime-ui",
      eventId: "claude-tool-result",
      createdAt: "2026-04-30T00:00:05Z",
      phase: "completed",
      id: "tool-1",
      itemId: "tool-1",
      result: "done",
      isError: false,
    }),
    runtimeEvent({
      type: "provider.turn",
      provider: "anthropic",
      sessionId: "claude-runtime-ui",
      eventId: "claude-turn-completed",
      createdAt: "2026-04-30T00:00:06Z",
      phase: "completed",
      usage: {
        input_tokens: 15,
        output_tokens: 4,
        total_tokens: 19,
      },
      inputTokens: 15,
      outputTokens: 4,
      totalTokens: 19,
      contextMax: 200_000,
      isError: false,
    }),
  ] satisfies ProviderRuntimeEvent[];

  for (const event of events) {
    router.handleProviderEvent({
      provider: "anthropic",
      sessionId: event.sessionId,
      data: JSON.stringify(event),
      event,
    });
  }
  router.handleLegacyEvent("anthropic", {
    session_id: "claude-runtime-ui",
    data: JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "duplicated legacy text" },
    }),
  });

  for (const message of messages) {
    if (message.type === "event") applyHydrationEvent(state, message.event);
  }

  assertEqual(state.isStreaming, false, "Claude runtime turn completion clears streaming");
  assertEqual(state.model, "sonnet[1m]", "Claude runtime session event hydrates model");
  assertEqual(state.contextMax, 200_000, "Claude runtime turn completion refreshes context window");
  assertEqual(state.mcpServers.length, 1, "Claude runtime MCP event hydrates server status");
  assertEqual(state.assistantMessages.length, 1, "Claude runtime content hydrates one assistant message");
  assertEqual(state.assistantMessages[0]?.text, "Inspecting ", "Claude buffered content finalizes streamed text");
  assertEqual(state.assistantMessages[0]?.toolCalls[0]?.name, "Read", "Claude runtime tool call keeps existing UI tool name");
  assertEqual(state.assistantMessages[0]?.toolCalls[0]?.result, "done", "Claude runtime tool result updates existing tool call");
  assertEqual(state.tokens, 19, "Claude runtime turn usage hydrates token counters");
  assertEqual(state.error, null, "Claude runtime happy path leaves error empty");
  assert(
    !state.assistantMessages.some((message) => message.text.includes("duplicated legacy")),
    "Claude legacy event is suppressed after unified provider-event for the same session",
  );

  return { name: "Anthropic runtime event UI hydration fixture", ok: true };
}

export function verifyAnthropicRuntimeErrorsHydrateUiStateFixture(): VerificationResult {
  const messages: ProviderIngestionMessage[] = [];
  const [message] = emitRuntime(messages, runtimeEvent({
    type: "provider.error",
    provider: "anthropic",
    sessionId: "claude-runtime-error",
    eventId: "claude-error",
    createdAt: "2026-04-30T00:00:00Z",
    phase: "error",
    message: "Claude reported an error.",
  }));
  assert(message?.type === "event", "Claude runtime error emits an ingestion event");
  assert(message.event.kind === "error", "Claude runtime error hydrates generic error state");
  assertEqual(message.event.message, "Claude reported an error.", "Claude runtime error message is preserved");
  return { name: "Anthropic runtime error UI hydration fixture", ok: true };
}

export function runAnthropicProviderEventVerification(): VerificationResult[] {
  return [
    verifyAnthropicRuntimeEventHydratesUiStateFixture(),
    verifyAnthropicRuntimeErrorsHydrateUiStateFixture(),
  ];
}
