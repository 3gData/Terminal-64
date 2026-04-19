# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-04-19T10:00:01.014Z
> Files: 156 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.DS_Store` (~2186 tok)
- `.gitignore` — Git ignore rules (~130 tok)
- `.mcp.json` (~57 tok)
- `CLAUDE.md` — OpenWolf (~2718 tok)
- `index.html` — Terminal 64 (~139 tok)
- `package-lock.json` — npm lock file (~12902 tok)
- `package.json` — Node.js package manifest (~235 tok)
- `README.md` — Project documentation (~1074 tok)
- `tsconfig.json` — TypeScript configuration (~175 tok)
- `tsconfig.node.json` (~67 tok)
- `vite.config.ts` — Vite build configuration (~140 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## mcp/

- `delegation-server.mjs` — Terminal 64 Delegation MCP Server (~1463 tok)
- `t64-server.mjs` — Terminal 64 MCP Server (~1741 tok)
- `widget-server.mjs` — Terminal 64 Widget MCP Server (~1952 tok)

## plans/

- `checkpoint-undo-system.md` — Checkpoint & Undo System for Terminal 64 (~1461 tok)

## src-tauri/

- `.DS_Store` (~2186 tok)
- `.gitignore` — Git ignore rules (~23 tok)
- `build.rs` (~177 tok)
- `Cargo.toml` — Rust package manifest (~700 tok)
- `Info.plist` (~156 tok)
- `tauri.conf.json` — /*": "skill-creator/", "bundled-widgets/**/*": "bundled-widgets/"}, (~426 tok)

## src-tauri/bundled-widgets/project-intel/

- `index.html` — Project Intelligence (~1332 tok)
- `main.js` — Project Intelligence Dashboard — main.js (~7475 tok)
- `styles.css` — Styles: 94 rules, 17 vars, 1 animations (~3659 tok)

## src-tauri/capabilities/

- `default.json` (~219 tok)

## src-tauri/gen/schemas/

- `acl-manifests.json` — Declares command (~18959 tok)
- `capabilities.json` (~182 tok)
- `desktop-schema.json` — Declares command (~33507 tok)
- `macOS-schema.json` — Declares command (~33507 tok)

## src-tauri/icons/

- `icon.icns` (~22762 tok)

## src-tauri/icons/android/mipmap-anydpi-v26/

- `ic_launcher.xml` (~75 tok)

## src-tauri/icons/android/values/

- `ic_launcher_background.xml` (~33 tok)

## src-tauri/resources/skill-creator/

- `LICENSE.txt` — Declares name (~2840 tok)
- `SKILL.md` — Skill Creator (~8048 tok)

## src-tauri/resources/skill-creator/agents/

- `analyzer.md` — Post-hoc Analyzer Agent (~2594 tok)
- `comparator.md` — Blind Comparator Agent (~1821 tok)
- `grader.md` — Grader Agent (~2258 tok)

## src-tauri/resources/skill-creator/assets/

- `eval_review.html` — Eval Set Review - __SKILL_NAME_PLACEHOLDER__ (~1883 tok)

## src-tauri/resources/skill-creator/eval-viewer/

- `generate_review.py` — Generate and serve a review page for eval results. (~4656 tok)
- `viewer.html` — Eval Review (~11994 tok)

## src-tauri/resources/skill-creator/references/

- `schemas.md` — JSON Schemas (~3015 tok)

## src-tauri/resources/skill-creator/scripts/

- `__init__.py` (~0 tok)
- `aggregate_benchmark.py` — calculate_stats, load_run_results, aggregate_results, generate_benchmark + 1 more (~4082 tok)
- `generate_report.py` — Generate an HTML report from run_loop.py output. (~3668 tok)
- `improve_description.py` — Improve a skill description based on eval results. (~3063 tok)
- `package_skill.py` — should_exclude, package_skill, main (~1205 tok)
- `quick_validate.py` — validate_skill (~1135 tok)
- `run_eval.py` — Run trigger evaluation for a skill description. (~3276 tok)
- `run_loop.py` — Run the eval + improve loop until all pass or max iterations reached. (~3910 tok)
- `utils.py` — Shared utilities for skill-creator scripts. (~475 tok)

## src-tauri/src/

- `audio_manager.rs` — AudioManager: new, start, stop, is_active (~2789 tok)
- `browser_manager.rs` — BrowserManager: new, create, navigate, set_bounds + 8 more (~1235 tok)
- `claude_manager.rs` — ClaudeManager: resolve_claude_path, shim_command (~6971 tok)
- `discord_bot.rs` — DiscordBot: new, start, stop, is_running + 4 more (~10120 tok)
- `lib.rs` — Safe stderr logging — never panics if the pipe is broken. (~41500 tok)
- `main.rs` — Prevents additional console window on Windows in release, DO NOT REMOVE!! (~51 tok)
- `mic_manager.rs` — 16 kHz mono mic capture, producing a shared broadcast of f32 frames. (~4231 tok)
- `permission_server.rs` — All Claude Code lifecycle hook events to register for each session. (~6558 tok)
- `pty_manager.rs` — PtyManager: new, create, write, resize + 1 more (~1667 tok)
- `types.rs` — [derive(Debug, Clone, Serialize, Deserialize)] (~1922 tok)
- `vector_store.rs` — Tables that the vector store manages. (~3282 tok)
- `voice_manager.rs` — Voice orchestrator — owns the state machine and coordinates the mic (~9364 tok)
- `widget_server.rs` — A simple localhost-only HTTP server that serves widget files from (~2082 tok)

## src-tauri/src/voice/

- `adapters.rs` — Trait adapters bridging concrete ONNX runners to the voice_manager traits. (~2938 tok)
- `command_stt.rs` — Grammar-constrained command STT using whisper.cpp. (~4470 tok)
- `intent.rs` — Voice intent parser. (~2652 tok)
- `mod.rs` (~44 tok)
- `models.rs` — Voice model registry + lazy download. (~3899 tok)
- `moonshine.rs` — Moonshine-base ASR for the post-wake command window. (~2842 tok)
- `testkit.rs` — Voice test harness + telemetry + startup self-test. (~4759 tok)
- `vad.rs` — Silero VAD runner for command endpointing. (~1531 tok)
- `wake.rs` — openWakeWord runner (melspec → embedding → classifier). (~3674 tok)
- `whisper.rs` — whisper.cpp streaming dictation via `whisper-rs` 0.13. (~6668 tok)

## src/

- `App.css` — Styles: 63 rules, 6 vars, 3 animations (~2911 tok)
- `App.tsx` — appWindow — uses useState, useRef, useEffect (~6003 tok)
- `main.tsx` (~40 tok)
- `vite-env.d.ts` — / <reference types="vite/client" /> (~11 tok)

## src/components/canvas/

- `Canvas.css` — Styles: 52 rules, 1 media queries, 8 animations (~2430 tok)
- `Canvas.tsx` — Safari/WebKit gesture events (non-standard, not in lib.dom.d.ts) (~3367 tok)
- `ClaudeDialog.css` — Styles: 43 rules, 2 animations (~2108 tok)
- `ClaudeDialog.tsx` — formatSize — uses useState, useEffect (~3934 tok)
- `FloatingTerminal.css` — Styles: 41 rules, 3 vars (~1642 tok)
- `FloatingTerminal.tsx` — Block iframes from stealing mouse events during drag/resize (~6522 tok)
- `PopOutTerminal.css` — Styles: 13 rules, 1 vars (~589 tok)
- `PopOutTerminal.tsx` — appWindow — uses useState, useCallback, useEffect (~1311 tok)
- `TextEditor.css` — Styles: 21 rules, 4 vars (~840 tok)
- `TextEditor.tsx` — TextEditor — uses useState, useEffect, useCallback (~2047 tok)

## src/components/claude/

- `ChatInput.tsx` — Truncate a partial transcript at the last standalone "jarvis" (with (~10110 tok)
- `ChatMessage.tsx` — DELEGATION_BLOCK_RE — uses useEffect, useState (~7406 tok)
- `ClaudeChat.css` — Styles: 95 rules (~20548 tok)
- `ClaudeChat.tsx` — Isolated streaming text component — subscribes only to streamingText, (~28769 tok)
- `Delegation.css` — Styles: 109 rules, 6 vars, 2 animations (~4775 tok)
- `DelegationBadge.tsx` — DelegationBadge (~828 tok)
- `DelegationDialog.tsx` — DelegationDialog — uses useState, useEffect (~1577 tok)
- `DelegationPanel.tsx` — STATUS_ICONS (~966 tok)
- `DelegationStatus.tsx` — ElapsedTimer — uses useState, useEffect (~1238 tok)
- `FileTree.tsx` — CODE_EXTS — uses useState, useCallback, useEffect (~3133 tok)
- `SharedChat.tsx` — TaskIndicator — uses useEffect (~1419 tok)
- `VoiceLivePanel.tsx` — VoiceLivePanel — uses useState, useEffect (~950 tok)
- `VoiceMascot.tsx` — Classify voice error strings so "no match" messages don't surface as the (~1188 tok)
- `VoiceStatusBadge.tsx` — VoiceStatusBadge (~449 tok)

## src/components/command-palette/

- `CommandPalette.css` — Styles: 14 rules, 2 animations (~655 tok)
- `CommandPalette.tsx` — CommandPalette — uses useState, useEffect, useCallback (~1010 tok)

## src/components/party/

- `PartyOverlay.css` — Styles: 4 rules (~214 tok)
- `PartyOverlay.tsx` — ATTACK — uses useEffect (~2980 tok)

## src/components/settings/

- `SettingsPanel.css` — Styles: 61 rules, 1 vars, 3 animations (~2469 tok)
- `SettingsPanel.tsx` — Toggle — uses useState, useEffect (~8474 tok)

## src/components/skill/

- `Skill.css` — Styles: 79 rules, 1 vars, 4 animations (~4655 tok)
- `SkillDialog.tsx` — SKILL_CREATOR_PROMPT — uses useState, useEffect, useMemo (~7840 tok)

## src/components/terminal/

- `XTerminal.css` — Styles: 9 rules (~199 tok)
- `XTerminal.tsx` — MAX_WEBGL_CONTEXTS — uses useRef, useCallback, useEffect (~3234 tok)

## src/components/widget/

- `BrowserPanel.css` — Styles: 12 rules, 1 animations (~576 tok)
- `BrowserPanel.tsx` — Ensure a URL has a protocol; default to https. (~1973 tok)
- `Widget.css` — Styles: 57 rules, 5 vars, 3 animations (~2137 tok)
- `WidgetDialog.tsx` — Remind Claude that theme is reactive — no hardcoded colors. (~5874 tok)
- `WidgetPanel.tsx` — Build a snapshot of Terminal 64 state that widgets receive on init (~8508 tok)

## src/hooks/

- `useClaudeEvents.ts` — Loosely-typed parsed event from the Claude CLI stream-JSON output. (~8340 tok)
- `useDelegationOrchestrator.ts` — Scan messages for a report_done tool call and extract its summary arg. (~3789 tok)
- `useKeybindings.ts` — Exports useKeybindings (~321 tok)
- `usePartyMode.ts` — Parse a hex color to HSL, returns [h, s, l] with h in degrees, s/l in 0-100 (~1481 tok)
- `useSemanticSearch.ts` — Debounced semantic search hook backed by sqlite-vec. (~408 tok)
- `useTheme.ts` — Exports useTheme (~106 tok)
- `useVectorAutoIndex.ts` — Auto-indexing hook for the vector search system. (~655 tok)
- `useVoiceControl.ts` — Top-level voice-control hook. Mount once in App. Listens to `voice-*` Tauri (~2674 tok)

## src/lib/

- `ai.ts` — Exports rewritePromptStream (~542 tok)
- `claudeSlashCommands.ts` — Known Claude Code built-in slash commands. (~936 tok)
- `commands.ts` — Exports registerCommand, executeCommand (~122 tok)
- `constants.ts` — Format seconds into a compact duration string (e.g. "5s", "2m 15s") (~510 tok)
- `fonts.ts` — Exports FONT_OPTIONS, fontStack (~366 tok)
- `keybindingEngine.ts` — Exports findMatchingBinding, DEFAULT_KEYBINDINGS (~842 tok)
- `notifications.ts` — Simple in-app toast notification system (~284 tok)
- `platform.ts` — Platform detection and cross-platform path helpers for the frontend. (~767 tok)
- `sessionFuzzyMatch.ts` — Score a transcript against a candidate session name. (~1207 tok)
- `snapUtils.ts` — Exports SnapGuide, computeDragSnap, computeResizeSnap (~2143 tok)
- `tauriApi.ts` — Read OpenWolf settings from persisted store (avoids circular imports). (~5977 tok)
- `themeEngine.ts` — Exports hexToRgba, applyTheme (~450 tok)
- `types.ts` — Tauri event payload for claude-hook-* events (~1853 tok)
- `updater.ts` — Exports UpdateInfo, checkForUpdate (~224 tok)
- `voiceApi.ts` — LocalAgreement-2 split-event payload (committed prefix or tentative tail). (~1113 tok)
- `widgetBus.ts` — Exports widgetBus (~415 tok)

## src/stores/

- `canvasStore.ts` — Get the center of the current viewport in canvas-space coordinates. (~4813 tok)
- `claudeStore.ts` — Exports STORAGE_KEY, ClaudeTask, QuestionOption, PendingQuestionItem + 7 more (~8161 tok)
- `delegationStore.ts` — Exports useDelegationStore (~2126 tok)
- `settingsStore.ts` — Exports QuickPaste, useSettingsStore (~1033 tok)
- `themeStore.ts` — Exports useThemeStore (~1177 tok)
- `voiceStore.ts` — Send current textarea. If `text` is provided, it overrides; otherwise the in-flight partial is rolled back and the committed base is sent. (~2314 tok)

## src/themes/

- `black.json` (~322 tok)
- `catppuccin-mocha.json` (~326 tok)
- `dark.json` (~322 tok)
- `default-dark.json` (~324 tok)
- `discord.json` (~323 tok)
- `dracula.json` (~323 tok)
- `monokai.json` (~323 tok)
- `tokyo-night.json` (~324 tok)
