# Terminal 64

A canvas-based terminal emulator and AI workstation built with **Tauri v2** + **React 19** + **xterm.js**. Manage multiple terminal sessions and Claude Code agents simultaneously on a free-form pan/zoom canvas.

## Features

### Canvas
- **Free-form canvas** — spawn, drag, resize, and arrange windows anywhere
- **Pan & zoom** — trackpad gestures, Ctrl+scroll, and drag on empty space
- **Smart spawn** — new windows appear at viewport center and auto-push clear of existing panels (AABB)
- **Snap guides** — edge and size snapping when dragging/resizing
- **Pop-out windows** — detach any terminal into its own native window
- **Custom border colors** — color-code each panel for easy identification
- **Activity indicator** — border lights up when a process is producing output
- **Session persistence** — positions, sizes, and working directories saved across restarts

### Claude Code Integration
- **Multi-session** — run multiple Claude Code agents side-by-side
- **Streaming chat UI** — real-time message rendering with tool call visualization
- **Monaco editor overlay** — click any diff in a tool card to open an inline code editor
- **File tree** — expandable sidebar file browser with search
- **Session history** — rewind to any message, fork/branch sessions with full context
- **Loop mode** — recurring prompt execution on a configurable interval
- **MCP servers** — dynamic Model Context Protocol server status and configuration
- **Permission handling** — inline approve/deny for Claude CLI tool requests

### Multi-Agent Delegation
- **`/delegate` command** — split work across parallel Claude agents with staggered starts
- **Shared chat** — team chat panel for delegation groups with live task progress
- **Auto-merge** — completed agent results merged back to the parent session
- **Idle detection** — timer-based completion detection for child agents

### Widgets
- **Widget system** — build custom web panels (HTML/CSS/JS) that live on the canvas
- **PostMessage API** — 40+ bridge commands for shell exec, file I/O, Claude sessions, terminals, fetch proxy, persistent state, inter-widget pub/sub, embedded browser, and notifications
- **Hot reload** — widget iframe auto-refreshes when any file in the widget folder changes
- **Widget ↔ chat linking** — animated dotted line connects widgets to their Claude chat; header button to open/reopen the linked chat
- **Widget folder** — `~/.terminal64/widgets/` with one-click folder access

### Discord Bot
- **Session sync** — named Claude sessions automatically sync to Discord channels
- **Remote access** — interact with sessions from Discord threads
- **Auto-cleanup** — orphaned channels detected and removed

### Appearance
- **8 built-in themes** — Black, Catppuccin Mocha, Dark, Default Dark, Discord, Dracula, Monokai, Tokyo Night
- **Quick Theme** — AI-generated color schemes from text descriptions
- **Background opacity** — adjustable transparency
- **Party Mode** — edge glow, equalizer bars, background pulse, color cycling, rotation

### Other
- **Command palette** — Ctrl+Shift+P to search and execute commands
- **Quick pastes** — saved command snippets accessible from the palette
- **AI prompt rewriter** — compose in the text editor, hit Rewrite to improve with Claude Haiku
- **Browser panels** — embedded webview panels on the canvas
- **Text editor** — built-in editor overlay for composing multi-line text

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Shift+P | Command Palette |
| Ctrl+V | Paste |
| Ctrl+C | Copy selection / Interrupt |
| Ctrl+A | Select all |
| Ctrl+Backspace | Delete word |
| Ctrl+Scroll | Zoom canvas |

## Tech Stack

- **Backend**: Rust + Tauri v2 + portable-pty
- **Frontend**: React 19 + TypeScript + Vite
- **Terminal**: xterm.js with WebGL addon
- **Editor**: Monaco Editor (`@monaco-editor/react`)
- **State**: Zustand with localStorage persistence
- **IPC**: Tauri commands + event emitters

## Prerequisites

- [Rust](https://rustup.rs/) (stable 1.77.2+)
- [Node.js](https://nodejs.org/) v18+
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: Visual Studio Build Tools with C++ workload

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## License

MIT
