# Provider Event Contract

Terminal 64 providers may stream different IPC payloads, but UI and store code
should consume normalized events and tool calls.

## Boundary

- `src/lib/providerEventIngestion.ts` owns raw provider IPC subscriptions and
  routes each provider's stream through its decoder.
- Provider decoders translate raw shapes into `NormalizedProviderEvent` and
  `ProviderToolCall`/`ProviderToolResult` objects from
  `src/contracts/providerEvents.ts`.
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
