# Terminal 64

A modern, canvas-based terminal emulator built with **Tauri v2** + **React** + **xterm.js**. Designed for managing multiple terminal sessions — especially multiple Claude Code agents simultaneously.

## Features

- **Free-form canvas** — spawn, drag, resize, and arrange terminal windows anywhere
- **Pan & zoom** — navigate your terminal workspace with Ctrl+scroll and drag
- **Session persistence** — terminal positions, sizes, and working directories saved across restarts
- **Background transparency** — adjustable opacity to see your desktop through the terminal
- **Pop-out windows** — detach any terminal into its own native window (pops back when closed)
- **Custom border colors** — color-code each terminal for easy identification
- **Activity indicator** — terminal border lights up when a process is producing output
- **Theming** — 6 built-in themes (Black, Catppuccin Mocha, Dracula, Monokai, Default Dark, Tokyo Night)
- **Command palette** — Ctrl+Shift+P to search and execute commands
- **Native performance** — Rust backend with ConPTY/PTY, WebGL-accelerated rendering
- **Cross-platform** — Windows and macOS support
- **AI prompt rewriting** — compose in the text editor, hit ✨ Rewrite to improve your prompt with GPT
- **Text editor** — built-in editor overlay on each terminal for composing multi-line text

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Shift+P | Command Palette |
| Ctrl+V | Paste |
| Ctrl+C | Copy selection / Interrupt |
| Ctrl+A | Select all |
| Ctrl+Backspace | Delete word (PowerShell) |
| Ctrl+Scroll | Zoom canvas |
| Double-click canvas | New terminal at cursor |

## Tech Stack

- **Backend**: Rust + Tauri v2 + portable-pty (ConPTY on Windows)
- **Frontend**: React 19 + TypeScript + Vite 8
- **Terminal**: xterm.js 6 with WebGL addon
- **State**: Zustand

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) v18+
- **Windows**: Visual Studio Build Tools with C++ workload
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

Outputs:
- `src-tauri/target/release/terminal-64.exe` (portable)
- `src-tauri/target/release/bundle/nsis/Terminal 64_0.1.0_x64-setup.exe` (installer)

## License

MIT
