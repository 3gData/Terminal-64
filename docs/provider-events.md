# Provider Event Contract

Terminal 64 providers may stream different IPC payloads, but UI and store code
should consume normalized events and tool calls.

## Boundary

- `src/lib/providerEventIngestion.ts` owns raw provider IPC subscriptions and
  routes each provider's stream through its decoder.
- Backend adapters should emit the canonical Rust `ProviderRuntimeEvent`
  envelope with `emit_provider_runtime_event()`, which publishes the shared
  `provider-event` topic. Cursor uses this first; Claude/OpenAI raw provider
  streams remain supported by their legacy decoders.
- Provider decoders translate raw shapes into `NormalizedProviderEvent` and
  `ProviderToolCall`/`ProviderToolResult` objects from
  `src/contracts/providerEvents.ts`.
- `src/lib/providerEventSemantics.ts` projects normalized provider events into
  provider-neutral semantic events for UI/store side effects: MCP status,
  hidden tool filtering, plan/task updates, pending questions, modified files,
  and delegation requests.
- Zustand store actions receive only normalized chat/tool shapes.
- React tool-card UI reads normalized tool names and normalized input helpers
  such as `getProviderToolFilePath`, `getProviderToolChanges`, and
  `providerToolChangedPaths`.

## Tool Shape

Every tool call has:

- `id`: provider-stable tool/item id.
- `name`: Terminal 64 display tool name, for example `Bash`, `Edit`,
  `MultiEdit`, `WebSearch`, or an MCP `server/tool` name.
- `input`: normalized object. File edits should prefer `file_path`, `paths`,
  `changes[]`, and `diff`. Shell tools should prefer `command`.
- `result`: optional completed output text.
- `isError`: optional result error flag.
- `parentToolUseId`: optional parent tool id for nested provider tools.

Decoders should preserve visible card behavior by mapping provider-native names
onto the existing display names instead of introducing new UI-only branches.

## Event Shape

`ProviderRuntimeEvent` is the backend/provider wire envelope. Its `type` is one
of `provider.session`, `provider.turn`, `provider.content`, `provider.tool`,
`provider.mcp`, or `provider.error`; every envelope also carries `provider`,
`sessionId`, `eventId`, `createdAt`, and optional provider references such as
`threadId`, `turnId`, `itemId`, and `nativeType`.

Rust also contains `src-tauri/src/providers/events.rs::experimental::ProviderEvent`,
a larger t3code-style event matrix kept as reference material. It is not the
live Terminal 64 contract and new adapters should not emit it.

`NormalizedProviderEvent` covers the live stream lifecycle:

- `session_started`: provider session/thread became available.
- `mcp_status`: MCP server status updates.
- `turn_started` and `turn_completed`: per-turn lifecycle.
- `assistant_delta` and `assistant_message`: assistant text.
- `tool_call`, `tool_update`, and `tool_result`: normalized tool lifecycle.
- `usage`: context/token usage updates.
- `error`: provider error text suitable for the session error state.

Provider-specific raw field drift belongs inside decoders. New providers should
not require `ChatMessage`, row construction, or store actions to know their IPC
schema.

## Semantic Events

Provider-neutral side effects are derived after raw decoding and before React
store mutation. `useProviderEvents` should handle semantic events instead of
re-parsing provider tool input directly. This keeps compatibility with legacy
Claude-shaped tool names while giving future providers a stable handoff for
delegation requests, plan/task state, MCP menus, question prompts, file-change
tracking, and internal tool visibility.
