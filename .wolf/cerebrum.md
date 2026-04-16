# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-04-15

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** terminal-64
- **Description:** A canvas-based terminal emulator and AI workstation built with **Tauri v2** + **React 19** + **xterm.js**. Manage multiple terminal sessions and Claude Code agents simultaneously on a free-form pan/zo

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->
- [2026-04-16] Rewind's restoreCheckpoint(keepTurns+1) restores the PREVIOUS turn's snapshot. When rewinding to the last user message (undo-send), this causes data loss. Always detect undo-send (target is last msg, no assistant response) and skip file operations.
- [2026-04-16] For a "traveling comet" border beam, NEVER use multiple discrete DOM elements (divs/dots) with staggered animation-delay riding the same offset-path — they always render as visibly separated dots. Correct approach: SVG `<rect pathLength="100">` + `stroke-dasharray` + animated `stroke-dashoffset` for geometrically-perfect corner wrapping with real `feGaussianBlur` for glow. Alternative: single element with gradient-to-transparent (gradient IS the tail). Conic-gradient+mask distorts speed at corners on wide rectangles.
- [2026-04-16] Rust `Command::new("pm2")` or `Command::new("openwolf")` on Windows DOES NOT resolve `.cmd`/`.bat` shims via PATHEXT (unlike the shell). npm-installed tools register as `.cmd` files in `%APPDATA%\npm` — must invoke via `cmd /C <shim> <args>` with CREATE_NO_WINDOW (0x08000000) to avoid a console flash. Applies to: pm2, claude, openwolf, any npx-installed CLI.
- [2026-04-16] `std::os::windows::fs::symlink_dir` REQUIRES Administrator or Developer Mode on Windows — normal users get permission denied. Fall back to directory junctions via `cmd /C mklink /J link target` which do NOT require elevated permissions. See `create_dir_link()` helper in lib.rs.
- [2026-04-16] `env!("CARGO_MANIFEST_DIR")` bakes in the developer's compile-time path — production builds crash looking for `/Users/janislacars/...` on end-user Windows machines. For bundled resources, always use `app_handle.path().resource_dir()` first and only fall back to CARGO_MANIFEST_DIR for dev/unpackaged runs.
- [2026-04-16] For rewind/undo flows: if `git` command itself fails to SPAWN (not found on PATH), treating that as "untracked" triggers `remove_file` on user-edited TRACKED files — DATA LOSS. Always distinguish `Err(spawn failed)` from `Ok(exit != 0)` — the former means skip-and-log, only the latter means safe-to-delete.
- [2026-04-16] `PathBuf::starts_with` is a LEXICAL prefix check — it does NOT collapse `..` segments. Zip archives with `..\..\foo` paths can escape the destination directory on Windows even with a `starts_with` guard. Always iterate `components()` and reject `Component::ParentDir`, `RootDir`, `Prefix` before joining.
- [2026-04-16] Frontend: `path.split("/").pop()` fails on Windows backslash paths (returns entire string). `relPath.startsWith("/")` does NOT detect Windows absolute paths (`C:\…`, `\\server\share`). Always split on `/[/\\]/` and check drive letter + UNC prefix. Use the shared helpers in `src/lib/platform.ts` (`baseName`, `dirName`, `isAbsolutePath`, `joinPath`) rather than open-coding at each call site.
- [2026-04-16] Frontend: `navigator.platform` is deprecated — prefer `navigator.userAgentData.platform` (Chromium/WebView2 only) with `navigator.platform` / `navigator.userAgent` fallback. All existing detection lives in `src/lib/platform.ts` as `IS_WIN` / `IS_MAC` constants — do NOT re-implement inline.
- [2026-04-16] Frontend: Template-literal path joins like `` `${cwd}/${name}` `` produce mixed separators on Windows and can break downstream consumers (node module resolution in MCP configs, etc.). Use `joinPath(...)` from `src/lib/platform.ts` — it detects the separator style from the inputs.
- [2026-04-16] Tauri 2 bundle config: `targets: "all"` on Windows builds BOTH NSIS and MSI; MSI requires WiX Toolset (separate ~50MB install), and a fresh CI/dev box without WiX aborts the build. Use an explicit array like `["app", "dmg", "deb", "appimage", "rpm", "nsis"]` — Tauri silently skips formats not applicable to the host, and Windows builds NSIS only. Keep MSI out unless you also commit to maintaining a WiX install on every build environment.
- [2026-04-16] Tauri 2 bundle.windows.nsis: always set `minimumWebview2Version` (e.g. "110.0.1587.40") so the NSIS installer triggers a WebView2 update on enterprise / locked-down Windows where Edge auto-update is disabled and the runtime is years old. Without the gate, modern web APIs (Monaco, xterm WebGL, conic-gradient) silently misbehave at runtime with no install-time warning.
- [2026-04-16] Localhost servers (widget_server, permission_server) bind to 127.0.0.1 — Windows Defender Firewall does NOT prompt for loopback-only listeners, so no UX work is required there. The unsigned-binary SmartScreen warning on first launch is a separate problem that needs an EV/code-signing cert (out of scope until purchased).
- [2026-04-16] Tauri 2 has no first-class `longPathAware` field for the embedded Windows app manifest, and overriding the manifest via `embed-resource` in build.rs conflicts with tauri-build's auto-generated manifest (WebView2 detection, DPI awareness). For now: keep `~/.terminal64/` paths short and accept that fastembed cache deeply nested under `models--BAAI--bge-small-en-v1.5/snapshots/<sha>/...` can flirt with MAX_PATH=260 on Windows accounts with long usernames. Revisit when Tauri exposes a manifest hook.
- [2026-04-16] Windows `where <bin>.exe` with explicit extension DOES NOT use PATHEXT — it only matches the exact extension given. To find `.cmd`/`.bat` shims (npm installs), pass the bare name (`where claude`). Same principle applies to `Command::new`: bare names bypass PATHEXT, so any fallback string must already include `.cmd`/`.exe` on Windows. See `resolve_claude_path` / `resolve_openwolf_path_inner`.
- [2026-04-16] Windows NTFS reserves DOS device names regardless of extension: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`. A filename like `CON.png` cannot be created — `fs::write` fails silently. NTFS also strips trailing dots and spaces (`file.txt.` → `file.txt`), which can collide with siblings. Any filename from external input (Discord attachments, user uploads) must reject reserved stems (case-insensitive on the part before the first dot) and trim trailing `.`/` ` before writing.
- [2026-04-16] Centralise the "invoke a Windows shim" pattern in one helper. `claude_manager::shim_command(bin)` wraps in `cmd /C` with CREATE_NO_WINDOW on Windows; `lib.rs::shim_command` does the same thing but scoped to pm2/openwolf daemon calls. Do not open-code `Command::new("cmd").arg("/C")` at each call site — easy to miss `creation_flags` or mishandle arg escaping.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
