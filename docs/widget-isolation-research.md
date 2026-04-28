# Widget Isolation Research

Terminal 64 currently renders widgets as sandboxed iframes inside the main React
webview. That is good for compatibility, but it is not a hard performance
boundary: a noisy widget can still consume renderer time and drop frames in the
canvas/chat UI.

## Findings

- Iframes are browsing contexts, not reliable performance sandboxes. MDN notes
  each iframe is a complete document environment and can increase memory and
  compute cost.
- Web Workers are real background threads and can use WebSocket/fetch, but they
  cannot manipulate DOM. They are useful for widget compute/stream parsing, not
  as a complete replacement for visual widgets.
- Relying on browser site isolation is not dependable here. WebKit documents
  that with site isolation off, cross-site iframes share a process, and as of
  January 2025 its site-isolation project was still in the functionality and
  performance-regression cleanup phase.
- Tauri v2 supports creating additional webviews. Terminal 64 already uses this
  through `BrowserManager`, which attaches native child webviews to the main
  window and positions them over canvas panels.

## Recommended Direction

Build a `native-webview` widget render mode and keep iframe mode as the legacy
fallback.

The panel chrome should stay in React, but heavy widget content should load in a
native Tauri child webview positioned over the panel body. That moves widget JS,
layout, WebSocket parsing, and painting out of the host React document.

## Required Architecture

1. Add a widget render-mode setting:
   - `iframe`: current behavior, full compatibility.
   - `native-webview`: isolated mode for heavy widgets.
   - `auto`: start iframe, promote to native after repeated frame drops.

2. Reuse the existing native-webview backend:
   - Generalize `BrowserManager` or add `WidgetWebviewManager`.
   - Commands mirror browser commands: create, bounds, visible, reload, eval,
     close.
   - Position from the same canvas/panel bounds code used by embedded browsers.

3. Move widget bridge transport out of DOM `postMessage`:
   - Extract the giant `WidgetPanel` request switch into a provider-neutral
     `WidgetBridgeHost`.
   - Iframe transport keeps using `postMessage`.
   - Native transport uses a Rust broker:
     - widget sends request to local HTTP/Tauri bridge,
     - Rust emits `widget-bridge-request` to main webview,
     - main webview runs `WidgetBridgeHost`,
     - Rust returns the response to the widget.
   - Events go back through an SSE/WebSocket channel or targeted webview eval.

4. Add worker helpers for widget authors:
   - A `t64-worker-bridge.js` helper for high-volume streams.
   - Widget guidelines: WebSocket parsing and big JSON diffs belong in workers;
     DOM only receives sampled/aggregated state.

5. Add host protection:
   - Auto-pause or promote widgets after repeated frame drops while visible.
   - Default noisy widgets such as `ro-sync` to native mode once available.
   - Keep per-widget pause for manual isolation.

## Host Protection Defaults

Frame drops are now recorded by the host performance monitor with visible
widget iframe candidates attached to each event. The monitor samples active
widget diagnostics, visible `.wdg-iframe` elements, bridge traffic deltas, and
known-noisy defaults so Settings can show which widget was present when a host
frame gap occurred.

The first protection mode is observe-only by default. Users can opt into:

- `Auto Pause`: after 4 frame drops within 15 seconds, pause the highest-scored
  visible widget by adding it to the persisted per-widget pause list.
- `Auto Promote`: after the same threshold, request `native-webview` render
  mode for that widget. Native mode is now wired through a Tauri child webview
  and the native widget bridge broker; iframe remains the compatibility mode.

Known noisy widgets should live in `src/lib/widgetHostProtection.ts`. `ro-sync`
is listed there because its daemon WebSocket can produce high-volume op traffic
inside the widget renderer. Its preferred mode is `native-webview`, with
`Auto Pause` available when users choose active protection.

## Practical Next Step

Exercise `native-webview` mode against heavy widgets such as `ro-sync`, then
tighten the native bridge helper into a documented widget API shim if the
compatibility path holds.
