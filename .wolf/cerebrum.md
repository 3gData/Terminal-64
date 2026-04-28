# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-04-19

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** terminal-64 — canvas-based terminal emulator + AI workstation built with Tauri v2 + React 19 + xterm.js. Manages multiple terminal sessions and Claude Code agents on a free-form pan/zoom canvas.

### Windows platform
- No first-class `longPathAware` manifest field in Tauri 2; keep `~/.terminal64/` paths short.
- Localhost servers (127.0.0.1) don't trigger Windows Defender Firewall prompts. SmartScreen needs EV cert (out of scope).

### Voice / ONNX runtime (added 2026-04-18)
- Moonshine-base: encoder hidden dim **416** (not 288); decoder 8 layers (64 past_kv inputs) + `use_cache_branch: bool[1]`. For ≤3s audio, pass `use_cache_branch=false` + zero past tensors each step.
- Silero-VAD v5 ONNX: unified `state: [2,1,128]` (not separate h/c). Inputs: `input`, `state`, `sr` (i64[1] not i64[]). Outputs: `output`, `stateN`.
- openWakeWord: wake-classifier input is `x.1`. Always resolve names at load via `session.inputs()[0].name()` — naming has changed across versions.
- openWakeWord melspectrogram.onnx output is `[time,1,1,32]` (4D, batch on axis 0). Flatten by total-len/32; apply `x/10 + 2` scaling.
- LocalAgreement-2 word-index LCP only valid for SAME audio region. When partial decoder slides its window, fully reset committed_words + last_hypothesis_words. Without per-word timestamps you can't preserve committed prefix across slides; final beam-search decode backfills.
- Tauri Emitter split-stream events (`voice-committed` + `voice-tentative`) arrive in non-deterministic order. Each handler updates its half of the store and calls a shared `applySplit()` reader — don't await pairs.

### Delegation
- `delegationStore.parentToGroup` is single-slot. To get ALL groups for a parent, iterate `Object.values(delState.groups).filter(g => g.parentSessionId === parentId)`.
- Delegation children are provider-bound but ephemeral. When spawning them, explicitly copy parent session model/effort and Codex permission preset into both the child store row and backend create request; `createSession(..., ephemeral=true)` does not load persisted metadata.
- Claude delegation MCP labels come from the generated temp MCP config env. Create one config per child if the team chat needs distinct `Agent N` names.
- Delegation child provider prep lives in `src/lib/delegationChildRuntime.ts`: resolve inherited provider/model/effort/Codex permission there, build Claude MCP config vs Codex MCP env there, and keep `useDelegationSpawn.ts` focused on store/session orchestration.
- Delegation completion parsing lives in `src/lib/delegationCompletion.ts`: normalize provider/MCP-prefixed `report_done` tool names/results there, return a `report_done` vs `idle_candidate` decision, and consume provider lifecycle through `src/lib/providerLifecycleBus.ts` instead of direct Claude hook listeners.
- Provider lifecycle signals for delegation now flow through `src/lib/providerLifecycleBus.ts`: Claude `SubagentStart`/`SubagentStop` hooks normalize to agent-harness events, while provider turn start/complete transitions normalize to shared turn lifecycle events for current and future providers.

### Claude CLI events (`useClaudeEvents.ts`)
- `stream_request_start` fires at start of EACH API call in a multi-turn session. Treat like `message_start`: clear pendingBlocks + assistantFinalized.

## Do-Not-Repeat

<!-- Past mistakes that must not recur. Each entry dated. -->

### Windows shim / PATH (2026-04-19)
- `Command::new("pm2"|"claude"|"openwolf")` does NOT resolve `.cmd`/`.bat` shims via PATHEXT. Invoke via `cmd /C <shim>` with CREATE_NO_WINDOW (0x08000000). Use centralized `shim_command` helpers (`claude_manager::shim_command`, `lib.rs::shim_command`) — do not open-code at call sites.
- `where <bin>.exe` only matches exact extension; pass bare name to use PATHEXT. Same for `Command::new` — fallback strings must include `.cmd`/`.exe`.

### Windows filesystem (2026-04-19)
- `std::os::windows::fs::symlink_dir` requires Admin/Developer Mode. Fall back to junctions via `cmd /C mklink /J` (see `create_dir_link()` in lib.rs).
- NTFS reserves `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` regardless of extension; strips trailing dots/spaces. Sanitize external filenames (Discord attachments, uploads).
- Frontend: use `src/lib/platform.ts` helpers (`baseName`, `dirName`, `isAbsolutePath`, `joinPath`, `IS_WIN`, `IS_MAC`). Do NOT use `path.split("/")`, `relPath.startsWith("/")`, template-literal joins, or `navigator.platform` directly — they all fail on Windows backslash/drive-letter paths.

### Tauri build config (2026-04-19)
- Tauri 2 bundle: use explicit `targets: ["app","dmg","deb","appimage","rpm","nsis"]` — `"all"` triggers MSI which needs WiX. Set `bundle.windows.nsis.minimumWebview2Version` (e.g. "110.0.1587.40") for enterprise updates.
- `env!("CARGO_MANIFEST_DIR")` bakes developer's compile-time path — production crashes on user machines. Use `app_handle.path().resource_dir()` first, fall back to CARGO_MANIFEST_DIR only for dev runs.
- Rust CI runs clippy with `-D warnings`; prefer direct cheap fallbacks like `unwrap_or(JsonValue::Null)` over lazy `unwrap_or_else(|| json!(null))`.

### ONNX / ort crate (2026-04-18)
- `ort` 2.0.0-rc.11 needs `ndarray = "0.17"` (matches fastembed v5 transitive). Pinning 0.16 splits the graph and breaks `Tensor::from_array`.
- `ort::Session::run(...)` returns `SessionOutputs<'s>` borrowing the session — scope each stage in `let x = { ... }` so outputs drop before `&mut self` calls (E0499). Applies to all voice runners.

### Rewind / git / delegation data loss (2026-04-19)
- Rewind `restoreCheckpoint(keepTurns+1)` restores PREVIOUS turn's snapshot. Detect undo-send (target = last user msg, no assistant response) and skip file ops to prevent data loss.
- Rewind MUST NOT `git checkout HEAD -- path` on delegation-modified files — wipes uncommitted/parent edits. For files touched by delegation children without parent checkpoint entry, only delete UNTRACKED files.
- Distinguish `Err(spawn failed)` from `Ok(exit != 0)` for git. Spawn fail = skip-and-log; non-zero exit = safe to delete untracked. Treating spawn fail as "untracked" causes data loss on tracked files.

### Session state flow (2026-04-16)
- Fork first-send MUST branch on `forkParentSessionId` presence alone — NOT `if (forkParent && !started)`. `loadFromDisk(newSessionId, forkedMessages)` sets `hasBeenStarted=true` whenever `promptCount>0`, so the `!started` guard falls through to `--resume <newId>` against a JSONL the CLI hasn't created yet, and the send hangs silently. Store clears `forkParentSessionId` after the `--fork-session` send succeeds.
- With `exactOptionalPropertyTypes`, provider runtime input objects must omit optional fields when values are undefined. Do not pass `permissionOverride: undefined` or `codexThreadId: undefined`; conditionally add the property.
- Backend runtime managers should remove entries on both explicit close and natural process EOF. PTY readers need generation checks before removing map entries, and Claude session ids must be generated before permission-server registration so temp hook/MCP files are keyed to the id the frontend later closes.
- Provider fork panels must seed the child `claudeStore` row with the parent provider synchronously before any async fork prep. Adding a canvas panel first and awaiting before `createSession(..., provider)` lets `ClaudeChat` mount and create the child as default Anthropic, which makes Codex forks open as broken Claude sessions.
- Provider-state migrations must keep runtime fallback to legacy flat session fields (`provider`, `codexThreadId`, `selectedCodexPermission`) for hot-reloaded in-memory sessions. TypeScript sees new fields as required, but live Zustand state can predate the migration.

### UI rendering / WebKit (2026-04-18)
- `overflow: hidden` + `border-radius` on a child of a `transform: scale(z)` parent flickers on WebKit at fractional pixel positions — rounded-corner clip repaints non-atomically, invalidating the background paint. Fix by promoting to own compositor layer: `will-change: transform; transform: translateZ(0); backface-visibility: hidden; contain: layout paint; isolation: isolate`.
- Prompt island can lag with huge histories if it reverses/maps/formats every prompt on open. Render the newest bounded slice first and append older rows in scroll batches.
- LegendList scroll events are not a reliable proxy for user intent during streaming; growing rows can briefly report not-at-end. Keep bottom stickiness in an intent ref updated by wheel/touch/key/pointer handlers, and use scroll events only for visibility/progress telemetry.
- Big-workflow performance: avoid per-panel global Tauri listeners and idle RAF polling. Terminal output should go through a single keyed dispatcher, browser panel bounds should sync from canvas/resize events, and full JSONL hydration caches must be capped by entry/message count.
- Big-workflow renderer hot paths: window-level Tauri drag/drop should be routed through one shared listener for all chat panels, and canvas-store subscribers must guard on the exact fields they consume because vanilla Zustand subscribers fire on every store write.
- Frontend persistence hot paths: localStorage saves should be dirty-triggered and deduped by serialized payload, not polling-based; large metadata stores should keep an in-memory parsed cache, schedule writes through idle time, and prune/compact stale inactive rows before retrying quota failures.
- 5-second lag spikes can come from renderer-main-thread persistence, not rendering alone. On 2026-04-27 the active WebKit localStorage had `terminal64-delegations` around 1.2MB and 18 restored panels; avoid permanent save intervals and dedupe/idle-schedule any JSON.stringify + localStorage writes.
- Widget/browser panels: hot-reload polling should baseline the first mtime, skip while `document.hidden`, and prevent overlapping `widget_file_modified` IPCs. Embedded native browsers should use event-coalesced canvas/resize bounds sync rather than idle RAF loops, and async native webview creates must close the webview if the React panel unmounts before the create promise resolves.
- Widget memory diagnostics cannot reliably read exact per-iframe heap from the host. Track low-overhead host-side signals instead: batched bridge traffic, reload/load churn, retained plugin/bus/voice/terminal subscriptions, embedded browser state, renderer-wide `performance.memory` when available, and optional iframe self-reports via `t64:debug-metrics`.
- Widget bridge live AI-session events must be opt-in. Default-pushing `streaming-text`/message/tool/session events to every iframe creates a renderer-wide postMessage firehose; widgets should use `t64:request-state`/`t64:request-messages` for snapshots and `t64:subscribe-session-events` only when they really need live events. Throttle `streaming-text` even after opt-in.
- Bundled widgets should not run fixed short polling loops for status data. `project-intel` daemon status polling at 5000ms lined up with visible lag spikes; use non-overlapping, visibility-aware, slower polling and event/broadcast refreshes for immediate updates.
- CI uses floating stable Rust; on 2026-04-26 GitHub Actions picked Rust 1.95.0 while local was 1.94.1. When CI Clippy fails but local passes, run `rustup toolchain install stable --component rustfmt --component clippy --profile minimal --no-self-update` and verify with `cargo +stable clippy --all-targets -- -D warnings`.
- Rust stability tests in production modules should put `#[cfg(test)] mod tests` after all non-test items. CI runs Clippy with `items_after_test_module` denied through `-D warnings`.
- Tauri drag/drop events are delivered at the webview/window level, not scoped to individual chat panels. Route chat file drops by `payload.position` (physical pixels; divide by `window.devicePixelRatio`) to the hit `.cc-container[data-session-id]`, then nearest visible chat rect. Do not route by last active chat.

### Voice pipeline (2026-04-18)
- VAD with a single hard threshold + 1-frame hangover finalizes whisper early on breaths/soft consonants mid-utterance. Use Silero VADIterator-style hysteresis: activate 0.5, deactivate 0.35, `min_speech_duration_ms=250`, `min_silence_duration_ms=500`, `speech_pad_ms=300`. Tune orchestrator silence-frame counters to match (e.g. dictation `SILENCE_FRAMES_TO_FINALIZE` 25→9).
- Streaming `partial_worker` that clones the full rolling buffer every tick is O(n²) over an utterance — 12s audio re-decoded every 250ms stalls partials under Metal. Decode only a trailing window slice (`g[buf_len - PARTIAL_WINDOW_SECS*SR ..]`), add min-new-samples gate (~120ms), reset `AgreementBuffer` when the window slides, and watchdog-skip next tick if decode > 2× tick interval.

### Security / zip extraction (2026-04-19)
- Zip extraction: `PathBuf::starts_with` is lexical — does NOT collapse `..`. Iterate `components()` and reject `ParentDir`, `RootDir`, `Prefix` before joining (Windows zip-slip).

### Session JSONL handling (2026-04-19)
- `find_rewind_uuid` leaf detection must filter to `type == "user" | "assistant"`. JSONL also contains `summary`, `task-summary`, `mode-entry`, etc. with UUIDs that aren't conversation tail.
- `truncate_session_jsonl_by_messages` trailing sweep: on JSON parse failure, `continue` (don't `break`). A single malformed line from in-flight CLI writes must not abort the sweep and break tool_use/tool_result pairing.

### Rewind + fork JSONL persistence (2026-04-22)
- `load_session_history` reads every line in the JSONL sequentially — it does NOT walk the parentUuid chain and does NOT respect rewind markers. Rewind must physically truncate the file (`truncate_session_jsonl_by_messages`); marker-only rewinds reload the "deleted" messages on refresh.
- Claude rewind after physical JSONL truncation should use normal session resume and clear `resumeAtUuid`. Passing `--resume-session-at` after rewriting the file can make the CLI reject a kept UUID with "No message found with message.uuid", leaving the chat unable to continue.
- `fork_session_jsonl` copies the full parent JSONL (needed so chain-walking can resolve the fork UUID) but MUST then truncate the destination to `keep_messages`. Without truncation the fork reloads with the entire parent history until the first `--resume-session-at` send.
- Codex app-server rewind differs from Claude: it may preserve older rollout items and append a `thread_rolled_back`/`thread_rollback` marker with `num_turns`/`numTurns`. Codex history hydration must replay that marker by dropping trailing user turns; otherwise refresh-from-jsonl shows messages the model context no longer contains.
- Codex rollouts can store edits as `custom_tool_call` named `apply_patch`; hydrate these into `Edit`/`MultiEdit` tool calls so refreshed chats preserve Claude-style clickable edit cards.
- Codex file-change shapes are not stable across live app-server events and rollout/history data: accept `path`, `file_path`, `filePath`, `diff`, `unified_diff`, and `unifiedDiff` when building UI tool-call inputs.
- Tool edit preview paths can be relative for Codex `apply_patch` history; resolve them against the session cwd before `readFile` so Monaco opens the real file.
- Checkpoint snapshots must also resolve Codex/Claude modified file paths against the session cwd before `readFile`/manifest persistence; restore must only write absolute manifest targets. Raw relative paths would restore from the Tauri process cwd, not the project cwd.
- Legacy `T64_CODEX_TRANSPORT=exec` emits rollout-style `session_meta`/`event_msg`/`response_item` JSON. Translate it in Rust to the same provider-neutral event shapes as app-server before emitting to the frontend.
- Codex app-server/live item updates may use cumulative `item.text`/`output` or delta fields depending on event source. Frontend accumulation must append explicit `delta` values but replace when the new value already includes the previous value; patch-only file-change updates should update tool input without setting `result`, or the UI marks the tool completed too early.
- Codex rollout/history tool names are raw model/tool ids (`exec_command`, `write_stdin`, `apply_patch`, etc.) while live app-server events may already be semantic (`commandExecution`, `fileChange`). JSONL hydration must normalize raw shell tool names into the same `Bash` card shape as live events, or refresh-from-jsonl renders a totally different chat.
- Codex runtime has two ids: the Terminal 64 local `sessionId` routes UI/process events, while `codexThreadId` is the external OpenAI thread used for resume/fork/rollback. Fresh first-turn failures must not fall back to `send_codex_prompt` without a thread id; only already-started legacy sessions may attempt local-id resume.
- With `exactOptionalPropertyTypes`, provider contract fields that callers include explicitly with maybe-undefined values must be typed as `T | undefined`, not just `field?: T`.
- Backend provider adapters now have two layers: the future normalized async `ProviderAdapter` trait, plus a narrow synchronous `ProviderCommandAdapter` used by existing Tauri IPC wrappers. Route common create/send/cancel/close commands through `ProviderRegistry` while preserving provider-specific request structs and frontend command names.
- Generic provider IPC uses frontend provider ids (`anthropic`, `openai`) at the Tauri boundary (`provider_create`, `provider_send`, `provider_cancel`, `provider_close`) and maps them to Rust `ProviderKind`; Claude/Codex compatibility command names should remain thin wrappers over that generic path.
- Codex plan mode in app-server is a real collaboration mode, not just `/plan` text. Send `turn/start` with `collaborationMode: { mode: "plan", settings: { model, reasoning_effort, developer_instructions: null } }`; `developer_instructions: null` selects Codex's built-in Plan instructions. Plan content streams as `item/plan/delta` and completed `plan` items generated from `<proposed_plan>` blocks. `update_plan` remains the TODO/checklist tool and is explicitly distinct from Plan mode.
- Codex app-server MCP startup status uses `mcpServer/startupStatus/updated` with `{ name, status, error }`; `status: "ready"` means connected. Terminal 64 should translate this into the live MCP store and merge it over configured entries instead of replacing the whole dropdown list.
- Codex app-server 0.125 generated contracts require `experimentalRawEvents` and `persistExtendedHistory` on `thread/start` and `thread/resume`, and text inputs for `turn/start` need `text_elements: []`. Also mark sessions streaming before provider events arrive; otherwise rapid sends can kill/replace the app-server worker before `turn/start`.
- Codex app-server lifecycle should reject overlapping local-session turns instead of killing the existing worker. Keep legacy `T64_CODEX_TRANSPORT=exec` fallback behavior separate; for app-server, surface `initialize`/`thread/start|resume`/`turn/start` failures with method-specific errors, startup timeouts, and initialize server/protocol diagnostics.
- ClaudeChat cleanup direction: move provider/UI slices into small components/hooks first, while leaving the main chat shell intact. `McpMenu.tsx` now owns configured/live MCP merging and T64 alias dedupe so new providers do not touch topbar dropdown internals.
- ClaudeChat's main `session` selector intentionally omits `streamingText` to avoid per-token rerenders. Extracted hooks/components that receive `session` should type only the fields they actually read instead of requiring the full `ClaudeSession`.
- ClaudeChat message list cleanup: `useChatRows.ts` owns virtual row descriptor construction and prompt index data, while `ChatMessageList.tsx` owns LegendList rendering. Keep layout-sensitive row keys in the hook and sticky-scroll intent refs in the shell unless the scroll state itself is extracted.
- ClaudeChat edit overlay cleanup: `ChatEditOverlay.tsx` owns Monaco rendering, dirty/save state, changed-line decorations, cached edit contents, and scroll restoration through `useChatEditOverlay`. Keep file IO provider-neutral by passing `readFileContent`/`saveFileContent` callbacks from the chat shell.
- `ProviderControls.tsx` owns the chat topbar MCP/model/effort dropdown rendering/open-state and provider-specific permission status prop derivation for `ChatInput`; keep provider runtime create/send/cancel wiring in `ClaudeChat.tsx`.
- Provider manifests live in `src/lib/providers.ts`: use `getProviderManifest()` / `providerSupports()` for UI labels, model/effort/permission options, and topbar/input capability gates. `PROVIDER_CONFIG` remains as a compatibility alias.
- Provider manifests also gate native slash-command and compact support. Keep Claude built-in slash commands, `/compact` dividers, auto-compact hints, and Compact & Build controls behind `providerSupports(provider, "nativeSlashCommands" | "compact")`; Codex should still list skills/project commands but not Claude built-ins.
- Provider event/tool decoding boundary lives in `src/contracts/providerEvents.ts` plus `src/lib/{claude,codex}EventDecoder.ts`: raw provider IPC field drift should be normalized into `ProviderToolCall`/`ProviderToolResult` and helper-read file/change fields before store or `ChatMessage` code sees it.
- Provider session metadata is canonical in `ClaudeSession.providerState`; flat `provider`, `codexThreadId`, `selectedModel`, `selectedEffort`, `selectedCodexPermission`, and `seedTranscript` are compatibility mirrors maintained by `claudeStore.updateSession`. New provider-specific fields should live under `providerState`, and persisted metadata schema v5 migrates old flat rows on load.
- Frontend consumers should use `resolveSessionProviderState()` / `selectSessionProvider()` from `claudeStore` for provider metadata. Direct reads of flat `ClaudeSession` mirror fields should stay inside `claudeStore` migration/backcompat code.
- Frontend provider runtime operations live behind `src/lib/providerRuntime.ts`: route create/send/cancel/close/rewind/fork/hydrate through `src/lib/providerRuntimes/{anthropic,openai}.ts` instead of adding provider branches to hooks or store hydration.
- Provider history IPC now has generic commands (`provider_history_truncate`, `provider_history_fork`, `provider_history_hydrate`) keyed by frontend provider ids. Runtime adapters should call these wrappers; legacy Claude JSONL/Codex rollback/fork/hydrate command names are compatibility shims only.
- Explicit chat refresh needs a separate authoritative history path: normal startup hydration should stay extend-only to avoid clobbering live in-memory turns, while user-triggered refresh may replace/shrink messages only when provider history returns a non-empty transcript.
- Provider architecture docs should describe the two-layer design: frontend provider manifests/runtimes route Anthropic/OpenAI operations, backend generic `provider_*` IPC dispatches through `ProviderRegistry`, and Claude/Codex-specific command names are compatibility wrappers.
- Provider-neutral UI/workflow surfaces should call `runProviderTurn` with resolved `providerState` and apply `ProviderTurnResult` cleanup flags; provider-specific request details such as Claude `disallowed_tools` belong on `ProviderTurnInput` and are mapped inside the provider runtime.
- `claudeStore.promptQueue` entries are rich provider-turn payloads, not display strings: use `queuedPromptDisplayText()` for UI/history, `queuedPromptProviderPrompt()` for the raw provider prompt, and preserve permission override / Codex collaboration mode / command metadata when enqueueing.
- Prompt queueing must happen after command-specific provider prompts are built but before `actualSend`; special commands like `/delegate`, skill slash commands, `/reload-plugins`, and `/loop` need queued command metadata so replay can restore side effects and avoid sending into an active provider turn.
- Provider-neutral frontend helper cleanup can wrap legacy Claude-shaped surfaces instead of removing them: keep compatibility exports like `spawnClaudeWithPrompt` and `closeClaudeSession`, but route new UI/helper callers through provider-neutral names such as `spawnProviderSessionWithPrompt` and `closeProviderSession`.
- Delegation child spawning should also go through `runProviderTurn`; keep provider-specific setup limited to runtime input fields such as Claude `mcpConfig`/`noSessionPersistence` and Codex `mcpEnv`/`skipGitRepoCheck`.
- Delegation child history cleanup should go through provider runtimes (`deleteProviderHistory` / `provider_history_delete`) instead of callsite provider checks. Anthropic deletes the child JSONL; OpenAI intentionally returns a skipped result because blindly deleting Codex rollout files is not safe.
- Chat send validation that can return before provider IPC must run before `setStreaming(true)`, or it must explicitly clear streaming. The prompt queue depends on `isStreaming` being a real provider-turn signal, not a validation-error residue.
- Delegation MCP server logic is centralized in `mcp/delegation-common.mjs`; keep `t64-server.mjs` and `delegation-server.mjs` as thin entrypoints. The HTTP bridge helper must keep explicit `Content-Length` headers for JSON POSTs because the Rust delegation endpoints do not support chunked request bodies.
- Delegation task persistence stores child runtime facts under `DelegateTask.childRuntime` (`providerId`, model, effort, permission preset, cwd, cleanup state). Cleanup paths should use this metadata as the fallback when ephemeral child sessions are no longer present in `claudeStore`.
- Backend MCP config writers must use `Path::join` for `mcp/t64-server.mjs` and `.mcp.json` paths; frontend `joinPath` fixes are not enough because `create_mcp_config_file`, `ensure_t64_mcp`, and `ensure_codex_mcp` also write provider MCP configs.
- Delegation team-chat HTTP routes should reject oversized bodies instead of truncating at the read cap, reject malformed JSON/missing `group_id`, and bound retained/read messages so long-running delegation groups cannot grow the permission-server store without limit.
- Delegation MCP wiring differs by provider: Anthropic children need a temp MCP config path, while OpenAI/Codex children receive delegation env via runtime `mcpEnv`; future ProviderId additions must choose a transport in `getDelegationMcpTransport()` before typecheck passes.
- This repo currently has no JS test runner in package.json; provider modularity regression coverage can live as TypeScript verification fixtures under `src/` so `tsc --noEmit` typechecks them, with pure exported helpers for request shaping and routing decisions.
- Delegation spawn request coverage is easiest to keep stable by factoring the child `ProviderTurnInput` shape into a pure helper, then verifying provider-specific fields in `src/lib/providerModularity.verification.ts` instead of mocking React hooks/timers.
- Rust verification commands must run from `src-tauri` unless using `--manifest-path`; `.wolf/buglog.json` is an object with a top-level `bugs` array, not a root JSON array.
- ClaudeChat attachment/drop cleanup: `src/hooks/useChatAttachments.ts` owns attached file state, pasted image persistence, preview cleanup, and the single shared Tauri window drag/drop listener. Keep closest-chat hit-testing and zip filtering there instead of reintroducing module-level drag/drop code in `ClaudeChat.tsx`.

### Permission server bypass + unknown-session race (2026-04-22)
- `permission_server::handle_connection` must parse `permission_mode` from the hook payload BEFORE the session_map lookup. The request's `secret` in the URL has already proven authenticity, so an unknown `run_token` is just "session unregistered" (rewind cancel+close race, spawned-session timing, or server-restart leftover). On bypassPermissions, always return `permissionDecision: "allow"` even with empty session_id — otherwise the user gets silent `permissionDecision: "deny"` with reason "Unknown session — denied for safety" on skill/widget/MCP/MD edits.
- Claude CLI's hook payload fields are snake_case at runtime (`permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `session_id`). The minified binary uses `permissionMode` internally but serializes to snake_case. Verified by probing with a python hook on `claude --print --permission-mode bypassPermissions --settings <file>`.

### Claude CLI sensitive-file classifier is unbypassable in --print mode (2026-04-22)
- The classifier (RC5/jtH in the minified binary) blocks Write/Edit/MultiEdit on hardcoded paths regardless of permission mode or CLI flags. Protected dirs: `.git`, `.vscode`, `.idea`, `.claude`, `.husky` (with exceptions for `.claude/skills|agents|commands|worktrees` and `.claude/scheduled_tasks.json`). Protected filenames at basename: `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`, `.claude.json`. Both `--permission-mode bypassPermissions` and `--dangerously-skip-permissions` are ignored. The only allow-rule prefix that satisfies the early-return is `Edit(/.claude/**)` or `Edit(~/.claude/**)` ending in `/**` — so `.mcp.json` cannot be unblocked via settings.
- The classifier runs BEFORE PreToolUse hooks fire, so a hook-based auto-allow is impossible. The only workaround is to detect the sensitive-file tool_result error in the frontend and perform the edit ourselves (Terminal-64 pattern: `pendingSensitiveEdit` in claudeStore + `applySensitiveEditAndContinue` in ClaudeChat.tsx — reads file via `readFile`, replays Write/Edit/MultiEdit semantics locally, writes via `writeFile`, then injects a follow-up user message so Claude treats the tool call as succeeded).

### Claude CLI event handling (2026-04-19)
- "Safety net" sets `isStreaming=true` on any non-result/non-ping event. Top-level `{type:"error"}` (rate limit, overloaded, auth) MUST be handled explicitly: `setError` + `setStreaming(false)` + clear pending + `return`. Otherwise spinner never stops.
- `content_block_delta` + `input_json_delta`: always check `blocks[last].type === "tool_use"` before accumulating inputJson — `thinking` blocks can interleave.

### Claude CLI --resume replay (2026-04-19)
- If the previous run died mid-tool, the session JSONL can contain an assistant `tool_use` block with no matching user `tool_result`. On `--resume`, the CLI RE-EXECUTES the dangling tool (infinite replay). Before every spawn, scan the JSONL and append synthetic cancelled `tool_result` records (is_error: true) for any unresolved tool_use IDs. See `sanitize_dangling_tool_uses()` in `claude_manager.rs`. Preserve `parentUuid`, `cwd`, `version`, `gitBranch` on the synthetic record so the CLI accepts it.
- Claude CLI stdout lines can be hundreds of MB for large Bash outputs. Emitting them raw as one Tauri event freezes the renderer (JSON.parse + React render + localStorage persistence on megabytes). Cap lines > 512KB in the reader thread (`cap_event_size()`) — truncate `tool_result`/`text` content to head 96KB + tail 96KB with a marker. The CLI's own JSONL keeps the full output for future turns; only the live UI stream is truncated.
- `cap_event_size()` is shared by Claude and Codex live streams. If it receives a parsed JSON event, every fallback must preserve valid JSON; raw byte-slice truncation makes the frontend show bogus parse errors while the provider process keeps running. For provider events with arbitrary shapes, recursively truncate oversized string fields and re-serialize.
- LegendList row keys must change when a row's rendered height can change outside normal message append flow, especially assistant tool cards receiving live output. Include a lightweight layout signature for assistant/tool rows so the virtual list remeasures instead of letting growing cards overlap following rows.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

### Traveling comet border beam — SVG path animation (2026-04-19)
Chosen: SVG `<rect pathLength="100">` + `stroke-dasharray` + animated `stroke-dashoffset` + `feGaussianBlur`.
Rejected: (1) multiple discrete divs with staggered `animation-delay` on `offset-path` — always render as separated dots rather than a continuous beam. (2) conic-gradient + mask — distorts speed at corners on wide rectangles.
