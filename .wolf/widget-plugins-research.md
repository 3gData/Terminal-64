# Widget Plugins — Research

Evolution of the existing widget system (`~/.terminal64/widgets/{id}/`) into a plugin-grade system with native-code capability, fullscreen rendering, and a migration path that turns Discord + Party Mode into reference plugins.

Four-agent research. Each agent owns one section. Cross-cutting questions go in `## Agent Comms` at the bottom.

---

## 1. Native Plugin Runtime

### TL;DR
**Primary recommendation: subprocess + line-delimited JSON-RPC over stdio.** Defer
WebAssembly (wasmtime) as a second tier for pure-compute plugins once a concrete
need appears. Reject dylib/cdylib loading outright — it fights every CLAUDE.md
invariant the repo has.

### Approaches compared

#### A. WebAssembly via wasmtime + WASI
- **Build UX.** `cargo build --target wasm32-wasip1`; widget ships `plugin.wasm`.
  Single artifact for all platforms — a real win over B/C.
- **Security.** Strongest. True sandbox, capability-based FS/clock via WASI, no
  ambient authority. Network only through host-provided imports.
- **Memory.** Linear memory, isolated per instance. Every string/struct crossing
  the boundary is a manual copy through guest pointer/length — you build host
  imports for every capability.
- **Long-running work (Discord WS).** Possible but painful. `wasi-sockets` is
  still stabilizing; `tokio-tungstenite` will NOT compile to `wasm32-*` today.
  Reliable WebSocket-over-TLS means either waiting for WASIp3 + wasi-http, or
  exposing a hand-rolled `host_ws_open/send/recv` import set. Either way the
  plugin stops being "native Rust you'd write anyway."
- **Failure isolation.** Excellent — wasm traps are catchable; guest crash
  leaves host untouched.
- **Cross-platform cost.** None at the artifact level. No Gatekeeper /
  SmartScreen concern: the `.wasm` is data inside the already-signed host.
- **Repo cost.** +~8 MB release binary (wasmtime), new host-import ABI to
  design and version for every capability, another large dep tree subject to
  `cargo clippy -D warnings`. Noticeable tax for zero immediate payoff when
  the motivating use cases all need long-lived network sockets.

#### B. dylib / cdylib via `libloading`
- **Build UX.** `cargo build --release` → `.dylib` / `.so` / `.dll`. Widget
  ships three platform-specific binaries.
- **Security.** None. Runs with full host privilege.
- **Memory.** Shared heap. The Rust ABI is unstable, so every boundary needs
  `#[repr(C)]` POD + C strings, or the `abi_stable` crate. `Vec<String>`,
  `HashMap`, trait objects, `anyhow::Error` across the boundary are UB.
- **Long-running.** Fine — native threads, Tokio works.
- **Failure isolation.** None. A panic in a plugin unwinds into the host;
  `catch_unwind` at every FFI entry is a maintenance burden and doesn't catch
  SIGSEGV from FFI-mismatch UB.
- **Cross-platform cost.** Severe.
  - macOS: unsigned `.dylib` loads are blocked by Gatekeeper on notarized
    apps with hardened runtime. Loading third-party dylibs would require the
    `com.apple.security.cs.disable-library-validation` entitlement — which
    degrades the host's own notarization posture. Plugin authors need their
    own Developer ID or users do `xattr -d`.
  - Windows: `.dll` triggers SmartScreen reputation on first load;
    code-signing expected.
  - Linux: mostly fine.
- **Repo cost.** `libloading::Library::get` is `unsafe fn`; the loader trips
  the project-wide `unsafe_code = "warn"` lint (`Cargo.toml:78`). Every load
  site needs a justifying `#[allow(unsafe_code)]`. Wrong invariant to erode
  for a feature that has two safer alternatives.

#### C. Subprocess + JSON-RPC over stdio  ← **recommended**
- **Build UX.** `cargo build --release` → plain executable. Authors in Go,
  Node, Python, Deno also work — any language with stdio + JSON. Massively
  lowers the plugin-author bar and matches what the Claude Code / MCP
  ecosystem already does.
- **Security.** OS-level process isolation out of the box. Future hardening
  path available through `sandbox-exec` (macOS), AppContainer (Windows),
  landlock/seccomp (Linux) without touching the plugin contract.
- **Memory.** Separate address space. JSON at the boundary is slower than
  linear memory but payloads here are tiny — the Party Mode stream is 64
  floats × 30 fps ≈ 7.6 KB/s, trivial. For hotter streams, add a
  length-prefixed binary frame option later.
- **Long-running work.** Ideal. Child owns its own Tokio runtime, WS,
  sockets. `discord_bot.rs:52` already builds its own
  `tokio::runtime::Runtime` — that exact construct lifts into a child
  process with ~zero structural change. (Agent 4's inventory at §4.5
  confirms ~1300 LOC move verbatim.)
- **Failure isolation.** Perfect. Child crash = one EOF on stdout;
  supervisor restarts with backoff.
- **Cross-platform cost.** Same three-binary ship as B, but the signing
  burden is the *plugin author's*, not ours — and unsigned-first-launch
  flows are standard (same as Terminal 64 itself today per CLAUDE.md
  "Release process").
- **Repo cost.** Zero new heavy deps. `serde_json` and `tokio` are already
  in tree. Matches the existing `claude_manager.rs` pattern that the team
  has already debugged.

### Recommendation
Subprocess JSON-RPC as the primary runtime. Defer wasmtime to a future
`"runtime": "wasm"` manifest option for pure-compute plugins (theme
generators, formatters, code analyzers) where startup latency and per-call
overhead matter. Never ship dylib loading.

### Host API shape — `t64_plugin_sdk` crate
Publish a helper crate so authors write ergonomic async Rust; the crate
wraps the stdio protocol underneath.

```rust
use t64_plugin_sdk::{plugin, Host, Event, Result};

#[plugin(id = "discord-bot", version = "0.1.0")]
struct DiscordPlugin { /* state */ }

#[async_trait::async_trait]
impl t64_plugin_sdk::Plugin for DiscordPlugin {
    async fn on_start(&mut self, host: Host) -> Result<()> {
        host.subscribe("claude-event", Some(json!({"sessions": "linked-by-me"}))).await?;
        host.emit("plugin.discord.ready", ()).await?;
        Ok(())
    }
    async fn on_event(&mut self, host: Host, evt: Event) -> Result<()> { /* … */ Ok(()) }
    async fn on_stop(&mut self) -> Result<()> { Ok(()) }
}

t64_plugin_sdk::main!(DiscordPlugin);
```

The `main!` macro generates the Tokio entry, the stdio framing loop, and a
dispatch table keyed on the JSON `method` field.

**Host capabilities (all permission-gated, vocabulary owned by Agent 2 §2):**
- `host.emit(topic, payload)` — wraps `AppHandle::emit`. Default-scoped to
  `plugin.<id>.<topic>`; `events.emit-global` permission opts into raw
  topics (needed if Party Mode migrates and must keep emitting
  `party-mode-spectrum` on its legacy name).
- `host.subscribe(pattern, filter)` — returns a Tokio channel of matched
  events. The `filter` arg is Agent 4's requirement: host filters
  server-side so the Discord bot only gets events for sessions it linked.
- `host.invoke(cmd, args)` — calls a whitelisted existing Tauri command.
  **Same capability vocabulary as the iframe `t64:*` bridge** — no forked
  permission model (Agent 2 arbitrates the exact list).
- `host.state_get/state_set` — plugin-scoped KV, persisted to
  `~/.terminal64/widgets/{id}/.state.json` (reuse existing widget state
  store).
- `host.secrets_get/set(key)` — OS keychain (Keychain / Credential Manager
  / libsecret), gated by `secrets:<key>` permission. Agent 4 needs this
  for `discord_bot_token`.
- `host.audio.transcribe_file(path)` — first-class host API wrapping the
  existing `voice::whisper::WhisperRunner`. Avoids shipping a 60 MB
  whisper runtime per plugin (Agent 4 §4.3 gotcha #2).
- `host.log(level, msg)` — devtools console; plugin stderr captured too.
- **Network:** plugin owns its own sockets. Gated only at plugin-load
  time by the manifest `permissions.network = [...]` allow-list.
- **Threads:** plugin owns its Tokio runtime; host does not schedule for
  it.

### Lifecycle protocol (JSON frames, `\n`-delimited on stdout/stdin)
```
host→plugin: {"method":"init","params":{"plugin_id":"…","state_dir":"…","permissions":[…],"config":{…}}}
plugin→host: {"method":"ready","params":{"sdk":"0.1.0"}}
host→plugin: {"method":"start"}
host→plugin: {"method":"event","params":{"topic":"…","payload":…}}
plugin→host: {"method":"emit","params":{"topic":"…","payload":…}}
plugin→host: {"method":"invoke","id":42,"params":{"cmd":"shell_exec","args":{…}}}
host→plugin: {"method":"invoke.reply","id":42,"result":…}
host→plugin: {"method":"rpc","id":7,"params":{"method":"linkSession","args":{…}}}   // frontend→plugin
plugin→host: {"method":"rpc.reply","id":7,"result":…}
host→plugin: {"method":"stop"}                   ← graceful
plugin→host: {"method":"stopped"}
host: SIGTERM after 5s grace → SIGKILL after 10s
```

State machine: `spawned → init → ready → started → (event/emit/invoke/rpc)* →
stop → stopped | crashed`. Supervisor watches stdout EOF → exponential
restart backoff (1s, 2s, 5s, 30s cap); after 3 crashes in 60 s, surface a
toast ("plugin X is unstable — disable?") and stop restarting.

Ordering + backpressure (Agent 4 §4.3 gotcha #1): the host's event-forward
channel is a bounded `tokio::sync::mpsc` (cap 256) per subscription. If
the plugin can't keep up, the host drops oldest and emits a `plugin.lag`
warning rather than unbounded-buffering. Claude stream events are
per-session-ordered at the source and the forwarder preserves that order.

### Manifest hooks into Agent 2's schema
Agent 2 owns the manifest schema at `widget.json`; this runtime contributes
the following required sub-object when `"type"` includes `"plugin"`:

```jsonc
"plugin": {
  "runtime": "subprocess",        // "subprocess" | "wasm" (future)
  "entry": {
    "darwin-arm64": "bin/plugin-macos-arm64",
    "darwin-x64":   "bin/plugin-macos-x64",
    "win32-x64":    "bin/plugin-win32-x64.exe",
    "linux-x64":    "bin/plugin-linux-x64"
  },
  "config_schema": { "guild_id": { "type": "string", "required": true } },
  "secrets": ["discord_bot_token"],
  "permissions": {
    "network": ["https://discord.com/*", "wss://gateway.discord.gg/*"],
    "events.subscribe": ["claude-event:linked-sessions"],
    "events.emit": ["plugin.discord.prompt"],
    "invoke": ["shell_exec", "read_file"],
    "host-api": ["audio.transcribe", "secrets", "sessions.list"]
  },
  "rpc": ["linkSession", "unlinkSession", "renameSession", "cleanupOrphaned", "status"]
}
```

`"type": "ui"` (legacy or no manifest) keeps working unchanged.
`"type": "plugin"` → headless. `"type": "plugin+ui"` → both; they
communicate via the existing `t64:*` postMessage bridge plus a new
`plugin:message` channel routed host-side.

### Agent Comms
- **→ Agent 2 (manifest/bridge).** Confirmed: `widget.json` JSON wins (you
  chose it first; matches `skill.json` / theme JSON). The `host.invoke`
  capability list must share a single vocabulary with the iframe `t64:*`
  bridge — please own the exact list. Open Qs: (a) is manifest install
  consent enough, or per-capability prompt on first *enable*? I lean
  first-enable prompt showing the permission list. (b) `host.secrets.get/set`
  backed by OS keychain — please include in §2, scoped `secrets:<key>` per
  plugin id. (c) Please define the `plugin:message` postMessage channel for
  `plugin+ui` widgets so UI and plugin process can talk through the host.
- **→ Agent 3 (fullscreen UX).** Headless plugins need no overlay wiring,
  but `"plugin+ui"` widgets with `"surface": "fullscreen"` must tie process
  lifecycle to surface-visible state (auto-stop when user exits fullscreen).
  Emit `widget:surface-open` / `widget:surface-close` for the supervisor to
  observe. Agent 4 also wants `"surface": "settings"` — a panel contributed
  to the main Settings dialog (token entry, status light). Is that a
  first-class surface in your model, or a hidden iframe postMessaging
  Settings?
- **→ Agent 4 (Discord migration).** Confirmed runtime: `"type": "plugin"` +
  `"runtime": "subprocess"`. Your §4.3 gotchas all land cleanly:
  (1) ordering/backpressure → bounded mpsc with drop-oldest + `plugin.lag`
  event; (2) voice-note transcription → `host.audio.transcribe_file` —
  already in the host-API set; (3) token → `host.secrets` — listed. Your
  `[rpc]` list maps 1:1 to the `plugin.rpc` array in the manifest and the
  `rpc`/`rpc.reply` frames. Re your preference for dylib-or-subprocess:
  subprocess wins outright here on safety + cross-platform signing +
  language neutrality; WASM is off the table for this case for the exact
  `tokio-tungstenite` reason you flagged.

---

## 2. Lifecycle, Manifest, Bridge, Distribution

**Scope:** how a plugin-capable widget fits into the existing `~/.terminal64/widgets/{id}/` model end-to-end — discovery, manifest, server routing, bridge wire format, permissions/consent, hot-reload, distribution, and error surfacing. Runtime-agnostic: whatever Agent 1 picks (WASM/dylib/subprocess) is exposed through a single manifest surface. Agent 4's Discord case in §4 is the load-bearing concrete example — the schema below must cover it.

### 2.1 Manifest at widget root

Today's widgets are *directories with no manifest*; `index.html` is implicit. Plugins need declarative metadata, so introduce an **optional** manifest at `~/.terminal64/widgets/{id}/widget.json`. Absence ⇒ legacy web widget (unchanged). Presence ⇒ plugin capabilities unlocked. Zero-config floor preserved.

Agent 4 proposed `plugin.toml`; I propose `widget.json` to match codebase JSON-everywhere style and because `installWidgetZip` already parses JSON trivially. Content identical either way — pick one in Agent Comms before v1.

```jsonc
{
  "id": "com.terminal64.discord-bot",
  "name": "Discord Bot",
  "version": "0.1.0",
  "apiVersion": 1,
  "kind": "plugin",                     // "web" | "plugin" | "hybrid"

  "entry": {
    "iframe": "index.html",             // omit for headless
    "native": {                         // required iff kind != "web"
      "runtime": "dylib",               // Agent 1 decides allowed values
      "module": "native/{platform}-{arch}/plugin.{ext}",
      "exports": ["on_enable", "on_disable"]
    }
  },

  "surfaces": [
    { "kind": "background" },
    { "kind": "settings", "entry": "settings.html" }  // §4.6 asks for this
    // also allowed: "panel" (default), "fullscreen", "overlay"
  ],

  "permissions": [
    { "id": "network", "globs": ["https://discord.com/*", "wss://gateway.discord.gg/*"],
      "reason": "Talk to Discord gateway + REST" },
    { "id": "secrets", "keys": ["discord_bot_token"],
      "reason": "Bot token in OS keychain" },
    { "id": "events:subscribe", "topics": ["claude.event", "claude.gui-message"],
      "filter": { "scope": "linked-sessions" } },
    { "id": "events:emit", "topics": ["plugin.discord.prompt"] },
    { "id": "host-api", "methods": ["audio.transcribe", "sessions.list"] }
  ],

  "config": {
    "guild_id": { "type": "string", "required": true, "label": "Guild ID" }
  },

  "rpc": {
    "methods": ["linkSession", "unlinkSession", "renameSession", "cleanupOrphaned", "status"]
  },

  "autostart": true,
  "singleton": true
}
```

**Why one manifest, not two:** a hybrid (Party Mode: native audio capture + fullscreen UI) needs shared state between iframe and native module. One manifest with both `entry.iframe` and `entry.native` avoids the parallel-system anti-pattern. `kind: "plugin"` + no `entry.iframe` = pure background service. `kind: "web"` + no `entry.native` = legacy widget.

### 2.2 Server routing — extending `widget_server.rs`

`widget_server.rs:72` currently serves static files unconditionally. Extension:

1. **Manifest cache.** On first request under `/widgets/{id}/`, read + cache `{base}/{id}/widget.json` (mtime-checked). Cache lives in `WidgetServer` behind `Mutex<HashMap<String, ManifestState>>`; invalidated by mtime bump.
2. **Routing decision.** `kind: "web"` or absent → existing static handler (unchanged). `kind: "plugin"` or `"hybrid"` → still serves iframe entry statically, **plus** two new routes:
   - `POST /widgets/{id}/plugin/invoke` → JSON envelope forwarded to plugin runtime; synchronous response. Callers: iframe UI, `widgetBus` peers, future MCP tool calls.
   - `GET /widgets/{id}/plugin/stream` → SSE stream for plugin-pushed events + crash signals (§2.7).
3. **Why HTTP, not just postMessage:** plugins may be invoked by non-iframe consumers (background autostart, voice intents, cross-widget). Unified entry reuses existing localhost same-origin story (widget_server.rs:58). Backend goes through a new `PluginHost` mod (Agent 1 owns).
4. **Security.** Manifest trusted only within its own widget dir; a widget can't self-grant permission beyond user approval (§2.4). Server keeps current `widget_id` regex + canonicalize + `starts_with(base)` check (widget_server.rs:137–176).

### 2.3 Bridge wire format — plugin namespace

Reuse the existing `t64:request/response` envelope rather than invent new transport. Keeps `WidgetPanel.tsx:273` as single message router and lets Claude-generated plugin UIs use the same `t64()` helper.

```
Request:  { type: "t64:plugin", payload: { target, method, args, id, timeoutMs? } }
Response: { type: "t64:plugin-result", payload: { id, target, ok, data?, error? } }
Events:   { type: "t64:plugin-event", payload: { source, event, data } }
Crash:    { type: "t64:plugin-crashed", payload: { source, reason, stderrTail, canRestart } }
```

**In `WidgetPanel.tsx`:** one new case `"t64:plugin"` forwards to `invoke("plugin_rpc", { plugin, method, args })` (Agent 1's command). All 40+ existing cases untouched.

**Inter-plugin calls:** reuse `widgetBus` in `src/lib/widgetBus.ts` — no new mechanism.

**Flat namespace rejected:** `t64:discord:send` explodes the router and steals `t64:` tokens. Nested routing stays bounded.

**Agent 4 ask — `host.events.subscribe(topic, filter)`:** shape in §2.1 — descriptor `{ id: "events:subscribe", topics, filter }`. Host enforces filter before dispatching. `ClaudeEvent` frozen at `apiVersion: 1`; breaking changes bump apiVersion.

**Agent 4 ask — secrets API:** `host.secrets.get(key)` / `set(key, value)` gated by `secrets:<key>` permission, backed by OS keychain (macOS Keychain, Windows DPAPI, libsecret). Strips Discord token out of `settingsStore` localStorage as part of migration. **In scope for v1** — Discord depends on it.

### 2.4 Capabilities + consent UI

Mirror the Claude CLI permission model (battle-tested — see `permission_server.rs`):

- **Declarative at install.** `permissions[]` in manifest.
- **Consent on first install.** `WidgetDialog.tsx` gains a "Review Permissions" step after folder scan when manifest detected. Render each permission with human-readable label + `reason` string; **Approve** → write manifest hash to `~/.terminal64/widgets/{id}/.approved.json`; future manifest edit adding/widening a permission re-triggers consent. Narrowing is auto-approved. Reuse `wdg-` overlay pattern from `Widget.css`.
- **Runtime enforcement.** Agent 1's host receives approved permission set at spawn and denies out-of-scope calls. All host APIs (shellExec, fetch-proxy, keychain, mic, audio.transcribe) check approved set before acting.
- **Permission IDs (v1):** `network` (globs), `secrets` (keys), `events:subscribe` (topics + filter), `events:emit` (topics), `host-api` (method names), `fs:read`/`fs:write` (globs, default widget-dir + linked session cwds), `shell:exec`, `mic`, `system-audio`, `overlay:fullscreen`, `notify`. Agent 1 owns enforcement; Agent 3 owns `overlay:fullscreen`.
- **Filter DSL (Agent 4's ask):** v1 ships three canned filters, not a full expression language: `{ scope: "all" }`, `{ scope: "linked-sessions" }` (plugin declares linked sessions via `plugin.link`/`unlink`), `{ scope: "session-ids", ids: [...] }`. More expressive waits for demand.

### 2.5 Hot-reload / unload

Existing: `WidgetPanel.tsx:153` polls `widgetFileModified(id)` every 1.5s, cache-busts iframe `src`. Extension:

- **Web file change** → iframe reload (today's behavior).
- **Manifest change** → unload plugin → re-read manifest → permissions unchanged: reload; permissions widened: `pushToast` "Review changes" action opens `WidgetDialog` in review mode. **Never silently auto-approve.**
- **Native module change** (`.wasm` / `.dylib` / subprocess binary mtime bump) → `pluginHost.reload(id)` (Agent 1 provides). Clean re-instantiate for WASM; dylib/subprocess depends on Agent 1's answer. If infeasible, toast "Plugin updated — restart widget" with explicit Stop/Start. **Agent 1 Q: which runtimes support true hot-reload?**
- **Panel close ≠ plugin stop for headless/autostart.** For `surfaces: [{kind: "background"}]` with `autostart: true` (Discord), plugin keeps running. Add "Stop plugin" row action in `WidgetDialog` independent of panel mount.

### 2.6 Distribution — zip-in-place, marketplace-compatible

`installWidgetZip` already exists. Extension:

- **Zip layout:** flat — `widget.json` + `index.html` + native artifacts at top level. Install validates manifest → consent UI (§2.4) → extract to `~/.terminal64/widgets/{manifest.id}/`. Existing manifest-less flat zips keep working.
- **Platform-specific native:** zip contains `native/darwin-arm64/plugin.dylib`, `native/linux-x64/plugin.so`, etc. `entry.native.module` uses template: `"native/{platform}-{arch}/plugin.{ext}"`. Host resolves at load. Missing platform → clear "Plugin not available on this OS" error card.
- **Marketplace pattern.** Follow `.claude/plugins/marketplaces/claude-plugins-official/plugins/terminal-64-skills/`: JSON index with name, description, URL, SHA-256, apiVersion. Propose `~/.terminal64/widgets/.marketplace.json` as user-editable list of marketplace URLs. `WidgetDialog` grows a "Browse marketplace" tab; install = download + checksum + consent. **v1.5, not v1.**
- **Trust:** unsigned widgets allowed locally; marketplace listings require SHA-256 match. Code signing out of scope until release-signing TODO lands (per CLAUDE.md).

### 2.7 Error surfacing

1. **Manifest invalid / missing field.** `WidgetDialog` row shows red dot + "Manifest error" hover; click opens inline error. Plugin does not spawn. No crash.
2. **Plugin crash at runtime.** Agent 1's host catches, emits `t64:plugin-crashed` via SSE stream (§2.3). `WidgetPanel` replaces iframe with **error card** styled on `wdg-panel--error` (WidgetPanel.tsx:752): red border, plugin id, stderr tail, **[Restart]** button. Rate limit: exponential backoff, max 3 auto-restarts in 60s, then manual-only.
3. **Permission denied at runtime** (out-of-scope call). Log to error card + toast. **Do not** prompt for grant mid-run — plugins must declare upfront; retrofit prompts are a social-engineering vector.

### 2.8 Minimum v1 surface

**Must have:**
- `widget.json` schema + validation
- Server routing `/plugin/invoke` + `/plugin/stream`
- `t64:plugin` bridge envelope
- Permissions consent UI + enforcement
- `host.events.subscribe(topic, filter)` with 3 canned filters
- `host.secrets.get/set` (Discord needs it)
- `host.audio.transcribe(path)` (Discord needs it — §4.3)
- Hot-reload for iframe; explicit restart for native
- Error card + backoff restart
- Settings-surface contribution (§4.6, Agent 3 coord)

**v1.5:**
- Marketplace discovery
- Signed manifests
- Cross-plugin direct invoke (use `widgetBus` for now)
- Expressive filter DSL beyond 3 canned scopes
- WASM if Agent 1 ships dylib/subprocess first (Agent 4 strongly prefers non-WASM — §4.6)

### 2.9 Cross-references

- **→ Agent 1:** I assume runtime provides (a) `pluginHost.spawn(id, manifest, approvedPerms) → handle`, (b) `handle.invoke(method, args)`, (c) `handle.subscribe(event, filter) → Stream`, (d) `handle.reload()`, (e) crash callback, (f) `host.secrets.get/set`, (g) `host.audio.transcribe`. Infeasible items → flag in Comms; §2.5/§2.7/§2.8 adjust.
- **→ Agent 3:** `surfaces[]` declares UI modes. Added `surfaces: [{kind: "settings", entry: "settings.html"}]` per Agent 4 — your enum should include `"settings"` as first-class surface mounted inside the Settings dialog. Coordinate enum: `panel` | `fullscreen` | `overlay` | `background` | `settings`.
- **→ Agent 4:** Discord case covered. `plugin.toml` vs `widget.json` — preference? `host.events.subscribe(topic, filter)` in §2.1/§2.4. `ClaudeEvent` frozen at apiVersion 1. `host.audio.transcribe` in §2.8 v1.

### Agent Comms (Agent 2 open questions)

- **Q → Agent 4:** `plugin.toml` vs `widget.json`? I lean JSON; no strong objection to TOML. Pick one before v1.
- **Q → Agent 1:** Cancellation mid-invoke? If no, host enforces `timeoutMs` from envelope (§2.3).
- **Q → Agent 1:** Memory quota — manifest (`limits: { memMb: 128 }`) or hardcoded per-runtime? Lean manifest-declared, host-clamped.
- **Q → Agent 1:** Hot-reload feasibility per runtime (§2.5) — need answer before wording UX in `WidgetDialog`.
- **Q → Agent 3:** Headless plugin with no visible surface — still a row in widget list with Stop control, or hidden? Lean visible (discoverability + kill-switch).
- **Proposal to all:** every manifest declares `apiVersion: 1`; host refuses `apiVersion > current` with clear "update Terminal 64" message. Cheap future-proofing.

---

## 4. Discord Bot as Reference Plugin

### 4.1 Current surface inventory

Source: `src-tauri/src/discord_bot.rs` (1437 LOC). Registered in `src-tauri/src/lib.rs` as `AppState.discord_bot: Mutex<DiscordBot>` (lib.rs:129, init at :4201). The bot is almost entirely self-contained — the only things it reaches out of its module for are `voice::whisper`, `voice::models`, `voice::audio_file`, and the global Tauri event bus.

**Tauri commands (7, all in lib.rs):**

| Command | Signature | Role |
|---|---|---|
| `start_discord_bot` | `(token, guild_id)` → `()` | lib.rs:1877 — spawn runtime, gateway, queue, listeners |
| `stop_discord_bot` | `()` → `()` | lib.rs:1889 — graceful shutdown |
| `discord_bot_status` | `()` → `bool` | lib.rs:1895 — is_running |
| `link_session_to_discord` | `(session_id, session_name, cwd)` → `()` | lib.rs:2199 — create channel, persist topic |
| `unlink_session_from_discord` | `(session_id)` → `()` | lib.rs:2190 — delete channel |
| `rename_discord_session` | `(session_id, session_name, cwd)` → `()` | lib.rs:2210 — rename/create |
| `discord_cleanup_orphaned` | `(active_session_ids)` → `()` | lib.rs:2221 — delete stale channels |

Frontend callers: `src/lib/tauriApi.ts` wrappers → `src/components/settings/SettingsPanel.tsx` (token + guild config, start/stop), `src/components/claude/ClaudeChat.tsx` (link/unlink/rename on session lifecycle, and `gui-message` emission).

**Event surfaces:**

- **subscribes** `claude-event` — every Claude CLI stream chunk for every session. Used to drive streaming edits.
- **subscribes** `gui-message` — user-typed messages from the GUI, forwarded as `**ADMIN:**` posts.
- **emits** `discord-prompt` — inbound Discord `MESSAGE_CREATE` routed back to the GUI so `ClaudeChat.handleSend` handles streaming checks, queueing, resume/create fallback.

**External crates:** `reqwest` (HTTP to Discord REST v10), `tokio-tungstenite` (gateway WS), `futures-util` (stream split), `serde_json`. All already in the host `Cargo.toml`.

**State persistence:** zero files. Channel topic itself is the store — `"Terminal 64: {session_id} | {cwd}"` (discord_bot.rs:1210-1234). On boot, `restore_channel_mappings` re-hydrates `session_to_channel` / `channel_to_session` / `session_cwd` maps from topics under the "Terminal 64" category. Token + guild ID live in `settingsStore` localStorage — effectively a secret in cleartext JSON today.

**Embedded helpers (module-private):**

- `send_discord_message` / `post_and_get_id` / `edit_discord_message` / `trigger_typing` / `split_msg` — pure REST wrappers.
- `summarize_tool` — tool-call formatter (discord_bot.rs:1168).
- `seal_open_markdown` — close unterminated `**` / ``` spans for mid-stream edits (discord_bot.rs:1118).
- `StreamState::flush_now` — per-channel throttle (1.2s min edit interval, 1900-char rollover).
- `sanitize_name` — Discord channel-name sanitizer.
- `fetch_guild_channels` / `ensure_category` / `create_session_channel` / `cleanup_orphaned_channels`.
- **Voice-note transcription (discord_bot.rs:831-900):** reaches directly into `voice::audio_file::load_as_16k_mono`, `voice::models::find`/`is_downloaded`/`model_dir`, and `voice::whisper::WhisperRunner::load` + `transcribe_oneshot`. This is the only cross-module coupling inside the bot.

### 4.2 Boundary crossing — each surface mapped

Assumes Agent 1 lands on either **dylib** (`libloading` + C ABI) or **subprocess JSON-RPC**. Both presume the same logical host-API shape; I'll note divergences.

| Surface | Classification | Host API call / Plugin-local / Config |
|---|---|---|
| Gateway WS loop | **plugin-local** | Runs inside the plugin's own tokio runtime. Host exposes nothing here. |
| REST calls to discord.com | **plugin-local** | Plugin carries its own `reqwest` client. Host grants `network:https://discord.com` via manifest. |
| `token`, `guild_id` | **config + secret** | `guild_id` in plugin config; `token` fetched at init via `host.secrets.get("discord_bot_token")` backed by OS keychain. Removes cleartext from `settingsStore`. |
| `claude-event` subscription | **host API** | `host.events.subscribe("claude-event", filter)` returning a stream/callback channel. Payload is the already-public `ClaudeEvent` struct. Plugin never sees `AppHandle`. |
| `gui-message` subscription | **host API** | Same `host.events.subscribe` mechanism. |
| `discord-prompt` emit | **host API** | `host.events.emit("plugin.discord.prompt", payload)`. Namespace the event so the frontend knows it came from a plugin. Legacy `discord-prompt` is a compat alias for one release. |
| `start_discord_bot` command | **plugin lifecycle hook** | Becomes `on_enable(config)`. Settings UI toggles plugin enabled/disabled. |
| `link_session_to_discord` + siblings | **plugin RPC** | Exposed as plugin-declared RPCs in the manifest. Host auto-generates a typed wrapper (`invoke("plugin.discord.linkSession", …)`). No separate `#[tauri::command]`. |
| Channel-topic persistence | **plugin-local** | Unchanged — Discord is the store. |
| `send_discord_message` + friends | **plugin-local** | Plugin-private. |
| `summarize_tool`, `seal_open_markdown`, `StreamState` | **plugin-local** | Pure functions / private state. |
| Voice-note transcription | **host API (see 4.3)** | Should not be plugin-local — see gotcha below. |

### 4.3 Key gotchas

**1. `AppHandle` leakage on `claude-event`.** Today `app_handle.listen("claude-event", …)` gives a live callback inside the host process with full access to `AppHandle`'s emit/state surface. Across a plugin boundary the callback must become a message on a host-owned channel: the plugin calls `host.events.subscribe("claude-event")` → host filters/forwards per the plugin's declared `events.subscribe` manifest list → plugin receives serialized `ClaudeEvent` over dylib callback or JSON-RPC. Need **(a)** a stable serde wire type (already exists: `ClaudeEvent` in `types.rs`), **(b)** a filter DSL so plugins can say "only sessions I've linked" without receiving every event in the app, and **(c)** guaranteed ordering + backpressure (the stream-edit pipeline depends on strict order). Subprocess-JSON-RPC adds ~0.5–2 ms per event; for Claude's stream_event rate (~5–50/s) that's acceptable. Dylib is free but makes per-plugin crashes harder to isolate.

**2. Voice-note whisper path.** The current bot loads its own `WhisperRunner` ad-hoc per voice note (`load` + `transcribe_oneshot`). The host already owns a Whisper runtime in `voice/mod.rs` for dictation. Packaging a whisper binary + model inside the Discord plugin would bloat the download by ~60 MB and duplicate the runtime. Preferred: expose **`host.audio.transcribeFile(path, model_hint) -> string`** as a first-class host API gated by a `audio:transcribe` manifest permission. Plugin passes the .ogg path (which lives in its own attachment dir under session cwd — host already has FS access there); host handles model lookup + download gating + thread offload. Falls back cleanly if the host has no whisper model available.

**3. Secret storage.** Token in `settingsStore` localStorage is pre-existing tech debt. Migrating to keychain is worth doing as part of this extraction — once a Discord plugin declares `secrets:discord_bot_token`, the settings UI prompts for the token and hands it to the host keychain API rather than roundtripping through localStorage.

**4. Double-runtime.** The bot creates its own `tokio::runtime::Runtime` (not the Tauri one) plus per-call `new_current_thread` runtimes in `link_session`/`unlink_session`/`cleanup_orphaned` for lock-safety. In a subprocess plugin this is free. In a dylib plugin the plugin still runs its own runtime — fine — but the manifest must declare `runtime:tokio-multi-thread` so the host doesn't also try to drive it.

### 4.4 Manifest sketch

```toml
# ~/.terminal64/widgets/discord-bot/plugin.toml
id = "com.terminal64.discord-bot"
name = "Discord Bot"
version = "0.1.0"
kind = "background"       # no iframe, no fullscreen — see §3 Agent 3
entrypoint = "native:discord_bot.dylib"  # or "subprocess:./bin/discord-bot"

[config]
guild_id = { type = "string", required = true, label = "Guild ID" }

[secrets]
discord_bot_token = { label = "Bot Token", scope = "keychain" }

[permissions]
network = ["https://discord.com/*", "https://cdn.discordapp.com/*", "wss://gateway.discord.gg/*"]
events.subscribe = ["claude-event:sessions-linked-by-me", "gui-message:sessions-linked-by-me"]
events.emit = ["plugin.discord.prompt"]
host-api = ["audio.transcribe", "fs.attachments", "sessions.list"]

[rpc]
# Auto-exposes to frontend as invoke("plugin.discord.<method>", ...)
methods = ["linkSession", "unlinkSession", "renameSession", "cleanupOrphaned", "status"]

[ui]
# Agent 3: does the fullscreen/panel model support a "settings panel" surface?
settings_panel = "settings.html"
```

### 4.5 Migration LOC estimate + keep/remove

**Keep as-is inside the plugin (≈1300 LOC unchanged):**

- `BotState`, gateway loop (`run_gateway`), stream queue, `StreamState`, `flush_now`, `seal_open_markdown`, `summarize_tool`, `split_msg`, `sanitize_name`, `restore_channel_mappings`, `ensure_category`, `cleanup_orphaned_channels`, `create_session_channel`, all REST helpers. All pure logic — moves verbatim.

**Rewrite (≈150 LOC churn):**

- `DiscordBot::start/stop/link_session/…` public methods → plugin lifecycle (`on_enable`, `on_disable`) + declared RPC handlers. Drop the per-call `std::thread::spawn` + `new_current_thread` dance — plugin's own tokio runtime handles it.
- The two `app_handle.listen` calls (discord_bot.rs:252, :387) → `host.events.subscribe(...).await` loops feeding the same `msg_tx`.
- `app_handle.emit("discord-prompt", …)` (discord_bot.rs:932) → `host.events.emit("plugin.discord.prompt", …)`.
- Voice-note block (discord_bot.rs:831-900) → replace the whole `spawn_blocking(|| { load_as_16k_mono → WhisperRunner::load → transcribe_oneshot })` closure with a single `host.audio.transcribe_file(&dest).await` call. Net **~70 LOC deleted** from the bot; ~40 LOC added to `host_api::audio::transcribe` (which wraps logic already present in `voice/mod.rs`).

**Remove from host (`src-tauri/src/`):**

- `mod discord_bot;` + `use discord_bot::DiscordBot;` (lib.rs:26, :94) — gone.
- `discord_bot: Mutex<DiscordBot>` field on `AppState` (lib.rs:129, init :4201) — gone.
- Seven `#[tauri::command]` fns (lib.rs:1877–1899, :2189–2227) — gone; plugin RPC replaces them.
- `reqwest`, `tokio-tungstenite`, `futures-util`, `symphonia` Cargo deps move into the plugin's `Cargo.toml`. Host Cargo.toml shrinks (host `reqwest` may stay — widget_server already uses it).

**Frontend churn (`src/`):** `tauriApi.ts` Discord wrappers switch from `invoke("start_discord_bot", …)` to `invoke("plugin.rpc", { plugin: "com.terminal64.discord-bot", method: "enable", args: {…} })` (or thin typed helpers generated from the manifest). `SettingsPanel` Discord section reads from plugin-config rather than `settingsStore`. `ClaudeChat.tsx` unchanged except event names — `discord-prompt` listener becomes `plugin.discord.prompt`.

**Net:** Host loses ~1470 LOC (whole module + commands + deps). Plugin gains ~1350 LOC + ~60 LOC plugin scaffold. Host+Plugin combined ≈ same; the win is **extraction + isolation + optional-install**, not code reduction.

### 4.6 Agent Comms — open coordination

- **→ Agent 1 (runtime):** This section assumes either dylib-with-libloading or subprocess-JSON-RPC. Both survive. If Agent 1 picks **WASM (wasmtime)**, the gateway WS + reqwest path is hostile — WASI sockets are still immature and `tokio-tungstenite` won't compile to wasm32. In that case the plugin must delegate **all Discord network I/O to the host** via a generic `host.net.ws_connect` + `host.net.fetch` API; the plugin becomes pure protocol logic. That's workable but roughly doubles the host-API surface. **Strong preference from this section: dylib or subprocess.**
- **→ Agent 2 (bridge wire format):** I need a concrete `host.events.subscribe(topic, filter)` design. Minimum: `topic: String`, `filter: Option<Value>` where Discord passes `{ session_ids: [...] }`; host filters before send. Also need `ClaudeEvent` frozen as part of the stable plugin ABI — any breaking change to that struct is a plugin-breaking change.
- **→ Agent 3 (UI surfaces):** Discord plugin wants a **settings panel** (token entry, guild ID, status light, "cleanup orphaned" button). Not fullscreen, not floating — a section inside the main Settings dialog owned by the plugin manifest. Does your model include a "settings contribution" surface, or should the plugin mount a hidden iframe that postMessages into Settings? Strong preference for first-class contribution.
- **→ Agent 2:** Secret storage API (`host.secrets.get/set`) — is this in scope for section 2? Discord needs it; so will any other auth'd plugin.

---

## 3. Fullscreen & Overlay Widgets

### 3.1 Render modes

Today every widget renders in `WidgetPanel.tsx` as a floating tile on the pan/zoom canvas (`canvasStore.PanelType = "widget"`). We extend this to four surface kinds, declared per-surface in the manifest (Agent 2's `surfaces: [{kind, ...}]`):

| kind         | Host container                                             | Interactive | Covers canvas       | Use case                          |
|--------------|------------------------------------------------------------|-------------|---------------------|-----------------------------------|
| `panel`      | `FloatingTerminal` on canvas (unchanged default)           | yes         | no — floats         | dashboards, chatbots, tools       |
| `fullscreen` | Portal at `#t64-fullscreen-root`, `position: fixed; inset:0` | yes       | yes — covers canvas | presentations, games, focus modes |
| `overlay`    | Portal at `#t64-overlay-root`, `position: fixed; inset:0`  | opt-in      | no — sits above     | visualizers (Party Mode), HUDs    |
| `headless`   | no DOM                                                     | —           | —                   | Discord bot, schedulers (§4)      |

A single widget directory MAY declare multiple surfaces (Party Mode ships `overlay` + `panel` for settings; Discord ships `headless` + `panel`). The widget HTTP server still hosts the files; only the frame/portal differs.

### 3.2 Per-surface manifest fields

```jsonc
{
  "surfaces": [{
    "kind": "panel" | "fullscreen" | "overlay" | "headless",
    "entry": "index.html",            // file under widget dir; required unless headless
    "pointerEvents": "auto" | "none", // overlay default "none"; fullscreen default "auto"
    "pauseCanvasOnEnter": true,       // fullscreen only — stop browser/terminal RAFs behind it
    "escToExit": true,                // fullscreen default true
    "zLayer": "normal" | "above-dialogs", // overlay only
    "hotkey": "Cmd+Shift+P"           // optional — open/close binding
  }]
}
```

`pauseCanvasOnEnter` matches the existing "hide browsers when overlays open" pattern. A single `useCanvasSuspended()` hook is toggled by fullscreen mount/unmount and by `BrowserManager.setBrowserVisible`.

### 3.3 Z-index scale (project-wide, documented)

Current layering is ad-hoc (Widget.css:80 = 200, CommandPalette = 200, PartyOverlay = 300, Canvas hover = 9998, ClaudeChat = 9999). Fix the scale:

```
  0      canvas base / terminals
  10-50  floating panels (terminals, widgets, claude, browser)
  200    settings, command palette, ClaudeDialog
  300    overlay (non-modal HUD) — PartyEdgeGlow default
  500    fullscreen widget viewport
  1000   dialogs (skill, widget create, delegation)
  1500   overlay with zLayer:"above-dialogs"
  2000   toasts
  9999   reserved escape hatch (do not extend)
```

Fullscreen at 500 means dialogs still open *on top* — correct (config dialog over visualizer). A fullscreen widget that wants to suppress everything uses `pauseCanvasOnEnter: true` and its own internal modals.

### 3.4 Exit & lifecycle semantics

- **Fullscreen**: Esc → `t64:close-fullscreen` (widget may `preventDefault` for unsaved-state prompts; 150 ms grace then force-close). Persistent circular close button top-right. Canvas state preserved; re-entry restores pan/zoom. Terminals behind are **not** killed — PTYs run, xterm.js DOM unmounts (render paused), rehydrates from scrollback on exit — matches `PopOutTerminal`.
- **Overlay**: no exit UI. Toggled via sibling `panel` surface or settings (Party Mode's current `partyModeEnabled` model). Closing the widget closes all its surfaces.
- **Headless**: lifecycle owned by native plugin runtime (§1, §4).
- **Pan/zoom during fullscreen**: disabled — `Canvas.tsx` checks `fullscreenStore.active` and early-returns from wheel/drag handlers.
- **Browser panels behind fullscreen**: `setBrowserVisible(id, false)` on enter; reversed on exit. Scaffolding already exists.

### 3.5 Party Mode as the reference overlay widget

`PartyOverlay.tsx` + `usePartyMode.ts` + `audio_manager.rs` move to `~/.terminal64/widgets/party-mode/`:

| In-tree today                              | Moves to                                             |
|--------------------------------------------|------------------------------------------------------|
| `src-tauri/src/audio_manager.rs`           | `widgets/party-mode/native/` (native plugin, §1)     |
| `src-tauri/src/lib.rs` party commands      | plugin exports: `start`, `stop`, `is_active`         |
| Cargo.toml audio deps (`ringbuf`, `spectrum_analyzer`, ScreenCaptureKit bindings) | plugin's own `Cargo.toml` |
| `src/hooks/usePartyMode.ts`                | deleted — logic moves into widget JS                 |
| `src/components/party/PartyOverlay.tsx`    | `widgets/party-mode/overlay.html` + `overlay.js`     |
| `src/components/party/PartyOverlay.css`    | `widgets/party-mode/overlay.css`                     |
| Party controls in `SettingsPanel.tsx`      | `widgets/party-mode/panel.html` (secondary surface)  |
| `settingsStore.party*` fields              | widget persistent state (`t64:set-state`)            |
| `src/App.tsx:477` + `Canvas.tsx:293` mounts| host mounts any surface declared by installed widgets |

Manifest:
```json
{
  "id": "party-mode",
  "surfaces": [
    { "kind": "overlay", "entry": "overlay.html", "pointerEvents": "none", "zLayer": "normal" },
    { "kind": "panel",   "entry": "panel.html" }
  ],
  "capabilities": ["native:audio-capture"],
  "permissions": ["systemAudio"]
}
```

### 3.6 Audio data bridge — two options

**Option A (recommended) — native plugin owns audio, postMessage forwards spectrum.** Native plugin (§1) exposes `party_mode.subscribe_spectrum()` as a plugin API. The host runtime receives the 30 fps FFT frames and bridges them as `t64:audio-spectrum` postMessage events to any surface that subscribed via `t64:subscribe-audio`. No new Tauri events; existing iframe bridge covers it. Cost: one postMessage/frame (≈30/s, ≤4 KB each) — trivial.

**Option B — overlay subscribes to raw `party-mode-spectrum` Tauri event.** Simpler migration, but couples every audio-reactive widget to a reserved event name and exposes system-audio cross-widget without permission gating. Reject.

Chosen: **A**. Implication: Agent 1's runtime must expose a typed event channel from native plugin → host → subscribing JS surfaces. Agent 2's permission model gates `systemAudio` at install time; absent grant, `t64:subscribe-audio` rejects.

### 3.7 Coordination requests

- **→ Agent 1**: (a) plugin-API for typed event streams to JS surfaces (audio spectrum = 30 fps, ordered, drop-old backpressure); (b) ScreenCaptureKit entitlements — dylib inherits host bundle, subprocess needs inheritance or a host-side capture shim. Flag if subprocess.
- **→ Agent 2**: please adopt `surfaces: [{kind, entry, pointerEvents, pauseCanvasOnEnter, escToExit, zLayer, hotkey}]` shape from §3.2. Reserve `systemAudio` + `microphone` as distinct permissions (overlay visualizers want the former, voice widgets the latter). Also please add a **"settings contribution"** surface (per Agent 4 §4.6 request) — I'd model it as a fifth surface kind `"settings-section"` with `entry: "settings.html"` that the host mounts inside `SettingsPanel` under a plugin-owned heading.
- **→ Agent 4**: Discord bot is `headless` + `settings-section` (not a floating `panel` — a section inside the main Settings dialog, as you requested). Headless surfaces don't participate in the z-index scale but DO participate in `t64:subscribe-audio` (voice-note transcription path) — confirm OK.

### 3.8 Open questions

1. Host-level fullscreen hotkey fallback when a widget doesn't declare one — `Cmd+Shift+F` to toggle the topmost fullscreen-capable widget?
2. Multi-monitor — route fullscreen to the current Tauri window or open a second window? Defer; single-window for v1.
3. Detached fullscreen in a native window (`PopOutTerminal`-style) — v2.
4. Overlay z-order between sibling overlays — manifest `zOrder: int` or registration order?

---
