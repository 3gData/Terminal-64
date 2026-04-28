# Empty Chat Provider Picker Verification

Use these notes when verifying the empty-chat provider picker in dev builds. The expected contract is:

- A brand-new user-created chat starts unlocked and defaults to Claude.
- The empty state may switch the provider before the first user send.
- The first send locks the selected provider for that session.
- Fresh widget creation writes provider-readable instructions into the new widget folder, then opens an empty unlocked chat pointed at that folder.
- Saved, reopened, forked, delegated, existing widget, and skill-created sessions stay locked to their known provider.

## Manual Scenarios

1. **Blank user-created chat defaults unlocked to Claude**
   - Create a new AI chat from the session dialog.
   - Before typing, confirm the empty-state picker is visible and Claude is selected.
   - Switch to Codex/OpenAI and back to Claude; the model/effort/permission controls should follow the selected provider.
   - Do not send yet; close and reopen the unsent blank chat if the UI supports it, and confirm it is still safe to switch providers.

2. **First send routes through the selected provider and locks**
   - Create a new blank chat.
   - Switch the empty-state picker to Codex/OpenAI.
   - Send a short prompt.
   - Confirm the backend turn uses the OpenAI/Codex provider path, not the Claude create path.
   - Confirm the picker disappears or becomes disabled after send, and topbar provider controls remain OpenAI/Codex-specific.
   - Refresh/reopen the session; provider stays OpenAI/Codex.

3. **Claude default first send remains unchanged**
   - Create a new blank chat and leave Claude selected.
   - Send a prompt.
   - Confirm the backend turn uses the Anthropic/Claude provider path.
   - Confirm the session is locked to Claude after send and stays Claude after reopen.

4. **Saved and disk-reopened sessions are locked**
   - Reopen an existing Claude session with visible history; the empty-state picker must not appear.
   - Reopen an existing Codex/OpenAI session with visible history; the picker must not appear and Codex/OpenAI metadata such as thread id remains intact.
   - Wipe only `terminal64-claude-sessions` localStorage metadata, then reopen from provider history on disk; the recovered provider should come from persisted provider metadata or disk/runtime facts, not from the new-chat default.

5. **Legacy metadata migration locks known providers**
   - Seed localStorage with an older metadata row containing flat `provider: "openai"`, `codexThreadId`, `selectedModel`, `selectedEffort`, and `selectedCodexPermission`.
   - Reopen that session.
   - Confirm it migrates to `providerState.provider === "openai"` and the picker is locked.
   - Repeat with no provider field; confirm it defaults to locked Claude for backward compatibility.

6. **Fresh widget creation writes instructions and stays unlocked until first send**
   - Create a new widget from the widget dialog with a unique id and display name.
   - Confirm the widget folder exists under `~/.terminal64/widgets/{id}/` and contains provider-readable instruction files such as `CLAUDE.md` and `AGENTS.md`.
   - Confirm those instruction files explain the Terminal 64 widget contract and tell the provider to ask what to build before writing widget code.
   - Confirm the widget panel opens on the canvas.
   - Confirm the paired provider chat has `cwd` set to the new widget folder, has no seeded prompt/history, and shows the empty-state provider picker.
   - Switch the picker to Codex/OpenAI, send the first real widget request, and confirm the turn routes through Codex/OpenAI and then locks to Codex/OpenAI.
   - Repeat with a fresh widget left on Claude; the first real widget request routes through Claude and then locks to Claude.

7. **Forked, delegated, existing widget, and skill sessions stay locked**
   - Fork a Claude session; the child is locked to Claude before its first new prompt.
   - Fork a Codex/OpenAI session; the child is locked to Codex/OpenAI before its first new prompt.
   - Spawn delegated children from each provider; each child inherits and locks the selected runtime provider.
   - Reopen an existing widget's saved/provider-backed chat or use a widget bridge `t64:create-session` call that supplies a provider or prompt; provider selection follows the caller-supplied or resolved provider and is locked before first send.
   - Create a skill-backed AI session; provider selection follows the caller-supplied provider and is locked before first send.

## Regression Checks

- Empty-state provider changes must update `providerState` and compatibility mirrors together.
- Provider switching must be rejected once `promptCount > 0`, `hasBeenStarted === true`, persisted metadata identifies a provider, or a session has seed/fork/delegation/widget/skill provenance.
- First-send routing must call `runProviderTurn` with the provider selected in the empty state.
- Fresh widget creation must not call `spawnProviderSessionWithPrompt`; the instructions live on disk and the first real user prompt is the first provider turn.
- Fresh widget creation must not retain a seeded prompt path through the legacy `WIDGET_SYSTEM_PROMPT` flow; the initial chat should have no hidden or visible instruction message.
- Widget instruction-file writes must be no-overwrite for existing widget folders so saved widgets do not lose local guidance.
- Disk hydration must not unlock a recovered session while `jsonlLoaded` is still false.
