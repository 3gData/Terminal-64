# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Terminal 64 is a canvas-based terminal emulator built with Tauri v2 (Rust backend) + React 19 (TypeScript frontend) + xterm.js. It manages multiple terminal sessions and Claude Code agent sessions simultaneously on a free-form pan/zoom canvas. Features include multi-agent delegation, MCP server monitoring, Monaco editor integration, file tree browsing, Discord bot integration, session history with rewind/fork, and an AI prompt rewriter.

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

1. **Rust backend** (`src-tauri/src/`) — PTY lifecycle, Claude CLI process management, Discord bot, permission server, file system operations. All state lives in `AppState` (defined in `lib.rs`) which holds the managers behind `Arc`/`Mutex`.

2. **React frontend** (`src/`) — Canvas UI, terminal rendering via xterm.js + WebGL, settings, command palette, Claude chat interface, delegation system, Monaco editor overlays.

### Frontend → Backend Communication

- Frontend calls backend via `invoke("command_name", { params })` (Tauri IPC) — wrappers in `src/lib/tauriApi.ts`
- Backend pushes data to frontend via `app_handle.emit("event-name", payload)` — listened to with Tauri event listeners
- All IPC types are defined in `src-tauri/src/types.rs` (Rust, serde) and `src/lib/types.ts` (TypeScript)

### Rust Backend Modules (`src-tauri/src/`)

| Module | Purpose |
|---|---|
| `lib.rs` | Entry point, `AppState` struct, all `#[tauri::command]` handlers (including `read_file`, `write_file`, `list_directory`, `search_files`, `load_session_history`, `truncate_session_jsonl`, `fork_session_jsonl`, `list_slash_commands`, `list_mcp_servers`), Tauri plugin setup |
| `pty_manager.rs` | Creates/manages PTY instances via `portable-pty`, reads output in spawned threads |
| `claude_manager.rs` | Spawns Claude CLI as subprocess with `--output-format stream-json`, streams parsed responses |
| `discord_bot.rs` | Optional Discord bot that links Claude sessions to Discord threads via WebSocket gateway |
| `permission_server.rs` | TCP server on dynamic port handling Claude CLI tool permission requests and delegation message routing |
| `types.rs` | Shared serde structs for IPC payloads (`McpServer`, `SlashCommand`, `HistoryMessage`, etc.) |

### Frontend Structure (`src/`)

| Directory | Purpose |
|---|---|
| `components/canvas/` | Canvas layout engine — `Canvas.tsx` (pan/zoom/spawn), `FloatingTerminal.tsx` (draggable terminal windows), `ClaudeDialog.tsx` (new session / session browser), `PopOutTerminal.tsx` (detached native windows) |
| `components/terminal/` | `XTerminal.tsx` — xterm.js wrapper handling PTY data events, resize, WebGL rendering |
| `components/claude/` | Chat UI — `ClaudeChat.tsx` (main chat + Monaco editor overlay + MCP dropdown + loop/delegation), `ChatMessage.tsx` (message rendering with tool calls, diffs, permissions), `ChatInput.tsx` (input with slash commands, file mentions, elapsed timer), `FileTree.tsx` (sidebar file browser), delegation components (`DelegationDialog.tsx`, `DelegationStatus.tsx`, `DelegationPanel.tsx`, `DelegationBadge.tsx`, `SharedChat.tsx`) |
| `components/panels/` | `LeftPanelContainer.tsx`, `PanelFrame.tsx` — resizable panel layout system |
| `components/command-palette/` | `CommandPalette.tsx` — Ctrl+Shift+P command search/execute |
| `components/settings/` | `SettingsPanel.tsx` — UI for all user preferences |
| `stores/` | Zustand stores: `canvasStore` (layout), `claudeStore` (sessions, messages, context tracking), `settingsStore` (prefs), `themeStore` (theme), `delegationStore` (multi-agent groups), `panelStore` (side panels) |
| `hooks/` | `useKeybindings.ts` (global keyboard handler), `useClaudeEvents.ts` (Claude CLI event stream parser), `useDelegationOrchestrator.ts` (auto-merge, task tracking), `useTheme.ts` |
| `lib/` | `tauriApi.ts` (IPC wrappers), `commands.ts` (command registry), `keybindingEngine.ts`, `themeEngine.ts`, `ai.ts` (prompt rewriter via Anthropic API), `types.ts` |
| `themes/` | JSON theme definitions (8 built-in themes) |

### Key Patterns

- **State management**: Zustand stores with auto-save to localStorage every 5 seconds for session persistence. `claudeStore` also does immediate save on user messages
- **Terminal I/O flow**: `PtyManager` spawns PTY → reads output in a dedicated thread → emits `terminal-output-{id}` event → `XTerminal.tsx` writes to xterm.js instance
- **Claude session flow**: `ClaudeManager` spawns CLI process → streams JSON from stdout → emits `claude-output-{id}` events → `useClaudeEvents.ts` parses and dispatches to `claudeStore` → `ClaudeChat.tsx` renders messages. Permission requests route through `PermissionServer` (TCP). MCP server status is extracted from the `system` init event
- **Delegation flow**: `/delegate` command → `DelegationDialog` → spawns child Claude sessions with staggered starts → `useDelegationOrchestrator` tracks completion via store subscription → auto-merges results back to parent session. Shared chat routes through the permission server's `/delegation/message` endpoint
- **Session history**: JSONL files in `~/.claude/projects/<cwd-hash>/` are the source of truth. `load_session_history` parses them for session resume. `truncate_session_jsonl` enables rewind, `fork_session_jsonl` enables branching
- **Keybindings**: Global `keydown` listener dispatches to command registry. Treats Cmd as Ctrl for macOS compatibility
- **CSS class prefixes**: `cc-` (Claude chat), `cft-` (Claude file tree), `ft-` (floating terminal), `del-`/`ds-` (delegation), `qp-` (quick pastes/command palette)

### Design Conventions

- **Overlays/modals**: `rgba(0,0,0,0.55)` backdrop + `backdrop-filter: blur(4px)` + fade-in animation. Border-radius `10px` on dialogs
- **Colors**: Theme variables via CSS custom properties. `--ft-border` (#cba6f7) for Claude-specific purple accent. Semantic colors: `#a6e3a1` (green/success), `#f38ba8` (red/error), `#f9e2af` (yellow/pending), `#89b4fa` (blue/accent)
- **Typography**: `'Cascadia Code', Consolas, monospace` for code/terminal. Sans-serif via `var(--claude-font)` for labels/buttons
- **Transitions**: 0.1-0.15s for hovers, 0.15-0.25s for entrance animations
