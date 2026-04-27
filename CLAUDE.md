# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md every session. Check .wolf/cerebrum.md before generating code. Check .wolf/anatomy.md before reading files.


# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Terminal 64 is a canvas-based terminal emulator built with Tauri v2 (Rust backend) + React 19 (TypeScript frontend) + xterm.js. It manages multiple terminal sessions and provider-backed AI agent sessions (currently Anthropic Claude Code and OpenAI Codex) simultaneously on a free-form pan/zoom canvas. Features include multi-agent delegation, MCP server monitoring, Monaco editor integration, file tree browsing, Discord bot integration, session history with rewind/fork, an AI prompt rewriter, a widget system with full bridge APIs, a skill library for reusable AI instructions, audio-reactive party mode visualizations, and embedded native browser panels.

## Repository Standards

This repo is under CI. Every PR and push to `master` runs `.github/workflows/ci.yml`: `tsc --noEmit` on frontend, `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` + `cargo check` on 3 OSes, then `tauri build` on 3 OSes. Green CI is the bar for merge.

**Invariants — do not relax:**
- `tsconfig.json` strict flags (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`) stay on. Fix the code, never loosen the flag.
- `src-tauri/Cargo.toml` `[lints]` block stays as-is. For unavoidable cases (genuine `unsafe`, FFI glue, `too_many_arguments`), add a targeted `#[allow(clippy::X)]` at the call site with a one-line justifying comment — do not demote the project-wide lint.
- `cargo fmt` is the source of truth for Rust formatting. Run it before committing; don't hand-format around it.
- TypeScript type-only imports must use `import type` (`verbatimModuleSyntax` enforces this).

**Live-work files — change only with explicit intent:**
- `src-tauri/src/voice/whisper.rs` — dictation pipeline with an anti-hallucination reconciliation layer. Cosmetic fmt is fine; logic edits need a reason.
- `src/hooks/useVoiceControl.ts` — the "Jarvis send" snapshot-before-clear logic is load-bearing. Don't regress it.

**Do not commit:**
- `.wolf/cron-state.json`, `.wolf/daemon.log` — runtime state, not content.
- Anything referencing secrets (`APPLE_API_KEY`, `AZURE_*`, `TAURI_SIGNING_PRIVATE_KEY`). Secrets live in GitHub repo settings only.

**Git hygiene:**
- Never use `--no-verify` to bypass hooks. If a hook fails, fix the underlying issue.
- Never force-push `master`.
- Prefer new commits over `--amend` on pushed commits.
- Commit messages: imperative mood, terse subject, bullets for details. See recent history for style.

**Release process:**
1. Bump version in both `src-tauri/tauri.conf.json` and `package.json` (must match).
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — triggers `.github/workflows/release.yml`.
3. Workflow creates a **draft** release. Review artifacts, then publish manually.
4. Signing is still TODO (Apple notarytool + Azure Trusted Signing). Builds ship unsigned until those secrets are added — macOS users will need to right-click → Open on first launch.

**Security:**
- Vulnerability reports go through GitHub private advisories (`/security/advisories/new`). Do not discuss unfixed vulns in public issues or PRs.
- Any code touching PTY spawning, the widget HTTP server, permission server, or Discord bot needs extra scrutiny — those are the exposed surfaces listed in `SECURITY.md`.

## Build & Development Commands

```bash
npm install              # Install Node dependencies (first time / after package.json changes)
npm run tauri dev        # Start dev mode (Vite on port 1420 + Rust backend with hot reload)
npm run tauri build      # Production build (outputs native executable + installer)
npm run dev              # Frontend-only dev server (no Rust backend)
npm run build            # Frontend-only production build to dist/
```

Rust-specific (from `src-tauri/`):
```bash
cargo check              # Type-check Rust code without building
cargo build              # Build Rust backend only
cargo clippy             # Lint Rust code
```

**Prerequisites**: Rust stable (1.77.2+), Node.js v18+, Xcode CLI tools on macOS, VS Build Tools (C++ workload) on Windows.

**Note**: Shell sessions in Terminal 64 may not have full PATH. If `npm`/`cargo` aren't found, run: `export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"`

## Architecture

### Two-Process Model

The app runs as a Tauri desktop application with two main processes:

1. **Rust backend** (`src-tauri/src/`) — PTY lifecycle, provider registry/adapters for Claude CLI and Codex, Discord bot, permission server, file system operations, widget HTTP server, audio capture, native browser management. All state lives in `AppState` (defined in `lib.rs`) which holds the managers behind `Arc`/`Mutex`.

2. **React frontend** (`src/`) — Canvas UI, terminal rendering via xterm.js + WebGL, settings, command palette, provider-backed chat interface, delegation system, Monaco editor overlays, widget iframe panels, skill library, party mode visualizations.

### Frontend → Backend Communication

- Frontend calls backend via `invoke("command_name", { params })` (Tauri IPC) — wrappers in `src/lib/tauriApi.ts`
- Backend pushes data to frontend via `app_handle.emit("event-name", payload)` — listened to with Tauri event listeners
- All IPC types are defined in `src-tauri/src/types.rs` (Rust, serde) and `src/lib/types.ts` (TypeScript)

### Rust Backend Modules (`src-tauri/src/`)

| Module | Purpose |
|---|---|
| `lib.rs` | Entry point, `AppState` struct, all `#[tauri::command]` handlers, Tauri plugin setup. Commands include generic provider create/send/cancel/close plus compatibility wrappers, file ops, session history, widget CRUD, skill CRUD, checkpoints, proxy fetch, party mode, browser, theme generation |
| `pty_manager.rs` | Creates/manages PTY instances via `portable-pty`, reads output in spawned threads |
| `providers/` | Provider registry and adapters. `claude.rs` owns Claude CLI process/event handling; `codex.rs` owns Codex app-server/legacy exec transport, rollback/fork, and rollout hydration; `traits.rs`/`registry.rs` define the shared command boundary |
| `claude_manager.rs` | Compatibility re-exports plus OpenWolf helpers left outside provider-specific adapters |
| `discord_bot.rs` | Optional Discord bot that links AI chat sessions to Discord threads via WebSocket gateway |
| `permission_server.rs` | TCP server on dynamic port handling Claude CLI tool permission requests and delegation message routing |
| `audio_manager.rs` | macOS system audio capture via ScreenCaptureKit, real-time FFT (2048 samples), 64 logarithmic frequency bands, emits `party-mode-spectrum` events at 30fps |
| `browser_manager.rs` | Creates/controls native webview children with bounds syncing, navigation, JS eval |
| `widget_server.rs` | Localhost HTTP server on dynamic port serving `~/.terminal64/widgets/{id}/` with MIME types, CORS, path traversal protection |
| `types.rs` | Shared serde structs for IPC payloads (`McpServer`, `SlashCommand`, `HistoryMessage`, etc.) |

### Frontend Structure (`src/`)

| Directory | Purpose |
|---|---|
| `components/canvas/` | Canvas layout engine — `Canvas.tsx` (pan/zoom), `FloatingTerminal.tsx` (draggable terminal windows), `ClaudeDialog.tsx` (new session / session browser), `PopOutTerminal.tsx` (detached native windows) |
| `components/terminal/` | `XTerminal.tsx` — xterm.js wrapper handling PTY data events, resize, WebGL rendering |
| `components/claude/` | Provider-backed chat UI — `ClaudeChat.tsx` (main chat shell + Monaco editor overlay + provider controls + loop/delegation), `ProviderControls.tsx`, `ChatMessage.tsx` (message rendering with normalized tool calls, diffs, permissions), `ChatInput.tsx` (input with slash commands, file mentions, elapsed timer), `FileTree.tsx` (sidebar file browser), delegation components (`DelegationDialog.tsx`, `DelegationStatus.tsx`, `DelegationPanel.tsx`, `DelegationBadge.tsx`, `SharedChat.tsx`) |
| `components/widget/` | `WidgetDialog.tsx` (create/manage widgets), `WidgetPanel.tsx` (iframe renderer with postMessage bridge for t64:* APIs), `BrowserPanel.tsx` (native webview with URL bar + nav controls) |
| `components/skill/` | `SkillDialog.tsx` (create/browse/tag/delete skills with project directory picker), `Skill.css` |
| `components/party/` | `PartyOverlay.tsx` — audio-reactive equalizer bars (48 bands, spring physics, beat detection, peak caps) + edge glow (radial gradients from bass/mid/treble) |
| `components/panels/` | `LeftPanelContainer.tsx`, `PanelFrame.tsx` — resizable panel layout system |
| `components/command-palette/` | `CommandPalette.tsx` — Ctrl+Shift+P command search/execute |
| `components/settings/` | `SettingsPanel.tsx` — UI for all user preferences |
| `stores/` | Zustand stores: `canvasStore` (layout), `claudeStore` (provider-backed sessions, messages, canonical `providerState`, context tracking), `settingsStore` (prefs + party mode settings), `themeStore` (theme), `delegationStore` (multi-agent groups), `panelStore` (side panels) |
| `hooks/` | `useKeybindings.ts` (global keyboard handler), `useClaudeEvents.ts` (Claude/Codex event listeners and provider-event normalization handoff), `useDelegationOrchestrator.ts` (auto-merge, task tracking), `usePartyMode.ts` (audio capture lifecycle, spectrum → CSS variables), `useTheme.ts` |
| `lib/` | `tauriApi.ts` (IPC wrappers), `providers.ts` (provider manifests/defaults/capabilities), `providerRuntime.ts` and `providerRuntimes/` (frontend runtime routing), `commands.ts` (command registry), `keybindingEngine.ts`, `themeEngine.ts`, `ai.ts` (prompt rewriter via Anthropic API), `types.ts` |
| `themes/` | JSON theme definitions (8 built-in themes) |

### Key Patterns

- **State management**: Zustand stores with dirty-triggered persistence for chat/session metadata. `claudeStore.providerState` is canonical for provider metadata; flat `provider`, `codexThreadId`, model/effort, and permission fields are compatibility mirrors
- **Terminal I/O flow**: `PtyManager` spawns PTY → reads output in a dedicated thread → emits `terminal-output-{id}` event → `XTerminal.tsx` writes to xterm.js instance
- **Provider session flow**: UI code resolves `providerState`, calls `runProviderTurn`, and the selected frontend runtime builds provider-specific IPC requests. Backend `provider_create`/`provider_send`/`provider_cancel`/`provider_close` dispatch through `ProviderRegistry` to Claude or Codex adapters. Compatibility Claude/Codex command names remain thin wrappers. Live events are decoded into provider-neutral message/tool shapes before store/UI consumption
- **Delegation flow**: `/delegate` command → `DelegationDialog` → spawns provider-bound child sessions with staggered starts → `useDelegationOrchestrator` tracks completion via store subscription → auto-merges results back to parent session. Shared chat routes through the permission server's `/delegation/message` endpoint
- **Widget system**: Widgets are multi-file web panels in `~/.terminal64/widgets/{id}/`. Entry point is `index.html`, served by `WidgetServer` over localhost. `WidgetPanel.tsx` renders in a sandboxed iframe with a postMessage bridge (`t64:*` commands) for shell, filesystem, terminal, provider-backed AI sessions, browser, fetch proxy, persistent state, and inter-widget pub/sub APIs. Creating a widget spawns both a widget panel and an AI session pointed at the widget folder
- **Skill library**: Skills are reusable AI instruction sets stored in `~/.terminal64/skills/{name}/` with `SKILL.md` (YAML frontmatter + markdown) and optional scripts/references/assets. `SkillDialog` creates a skill folder and spawns an AI session with CWD = project directory (for context) while the skill files are written to the skill folder. Skills have tags for filtering
- **Party mode**: `AudioManager` captures system audio via ScreenCaptureKit → FFT → spectrum data emitted as Tauri events → `usePartyMode` hook writes to CSS variables (`--party-hue`, `--party-bass`, etc.) and a shared ref (`spectrumRef`) → `PartyOverlay` reads the ref in `requestAnimationFrame` loops for bar heights, colors, glow. Supports color cycling (rainbow) and theme-locked modes
- **Browser panels**: Native webviews managed by `BrowserManager`, positioned by syncing to canvas coordinates. `BrowserPanel.tsx` provides URL bar and nav controls. All webviews hidden when overlays are open (they render above DOM)
- **Session history**: Claude JSONL files in `~/.claude/projects/<cwd-hash>/` and Codex rollout files in `~/.codex/sessions/YYYY/MM/DD/` are the provider sources of truth. Provider runtimes hydrate both into shared `HistoryMessage` shapes; provider-specific truncate/fork/rollback helpers back rewind and branching
- **Keybindings**: Global `keydown` listener dispatches to command registry. Treats Cmd as Ctrl for macOS compatibility
- **CSS class prefixes**: `cc-` (chat UI; legacy Claude prefix), `cft-` (chat file tree), `ft-` (floating terminal), `del-`/`ds-` (delegation), `qp-` (quick pastes/command palette), `wdg-` (widgets), `skl-` (skills)

### User Data Locations

| Path | Content |
|---|---|
| `~/.terminal64/widgets/{id}/` | Widget files (index.html + assets) |
| `~/.terminal64/widgets/{id}/.state.json` | Widget persistent state |
| `~/.terminal64/skills/{name}/` | Skill files (SKILL.md, skill.json metadata, scripts/, references/) |
| `~/.claude/projects/<hash>/` | Claude session JSONL history files |
| `~/.codex/sessions/YYYY/MM/DD/` | Codex rollout JSONL history files |

### Design Conventions

- **Overlays/modals**: `rgba(0,0,0,0.55)` backdrop + `backdrop-filter: blur(4px)` + fade-in animation. Border-radius `10px` on dialogs
- **Colors**: Theme variables via CSS custom properties. `--ft-border` (#cba6f7) for AI chat panel accents. Semantic colors: `#a6e3a1` (green/success), `#f38ba8` (red/error), `#f9e2af` (yellow/pending), `#89b4fa` (blue/accent), `#89dceb` (cyan/skills)
- **Typography**: `'Cascadia Code', Consolas, monospace` for code/terminal. Sans-serif via `var(--claude-font)` for labels/buttons
- **Transitions**: 0.1-0.15s for hovers, 0.15-0.25s for entrance animations
- **New feature dialogs**: Follow the Widget dialog pattern — `skl-`/`wdg-` prefixed classes, same overlay/animation structure, form + list layout, accent-colored create button
