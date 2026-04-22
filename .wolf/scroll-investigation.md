# Scroll Investigation — Load-More Jump Bug

Shared scratch for 3-agent investigation. Each agent appends findings below.

---

## Agent 3 findings: MutationObserver/ResizeObserver anchor compensation (approach **c**), not column-reverse, not virtuoso

### Why (a) `flex-direction: column-reverse` is wrong for this codebase

Mathematically correct — prepending data is equivalent to DOM-appending in reverse layout, so scrollTop stays naturally invariant. Slack/iMessage use variants. **But**:
- Every piece of scroll math in `ClaudeChat.tsx` inverts: `scrollToBottom` (L409), `distFromBottom` (L435), `pinnedToBottom` logic (L460–465), `isScrolledUp`/`scrollProgress` (L471–474), load-more top-region detection (L484), wheel/touch direction checks (L491, L509). Streaming appends become visual-top appends in DOM terms; every effect that uses `session.messages.length` to auto-follow has to be rewritten around reversed-array semantics.
- Known Firefox/Safari quirks: `overflow-anchor` interacts poorly with `column-reverse`; native text-selection order goes backwards in some engines; keyboard a11y (Tab / screen-reader) traversal reverses.
- This is a ~400-line rewrite of the scroll subsystem for a property we can get more cheaply. Rejected.

### Why (b) react-virtuoso `firstItemIndex` is wrong here

Virtuoso's `firstItemIndex` is the battle-tested answer for Slack-style chat — virtualized, index-stable, survives prepend. **But** Terminal 64's render loop (L1527–1594) does far more than map-index-to-row: it groups consecutive tool-call-only assistant messages into `ToolGroupCard` (L1556–1570), inserts `cc-turn-divider` between turns (L1549, L1588), injects `CompactDivider` after `/compact` messages (L1576–1578), mixes in `StreamingBubble` and pending-permission panels (L2025+). Flattening all of that into Virtuoso's `itemContent` API means either (i) pre-computing a flat row array (doable but invasive) or (ii) giving up grouping. Heavy refactor + new dependency for the same scroll-stability property we can achieve with ~40 lines. Rejected.

### Why (c) anchor + MutationObserver/ResizeObserver is the right fit — and why prior attempts failed

Prior attempts failed for specific, nameable reasons:

1. **"JS scrollHeight-delta in useLayoutEffect"** — measured `scrollHeight` delta, not anchor-element delta. Streaming text appending at the bottom during the same commit cycle pollutes the delta (both ends grew). Also a one-shot measurement: no chase for subsequent async growth.
2. **"element-offset anchor + flushSync"** — correct idea (measure a specific anchor element's `offsetTop` before/after), but one-shot. Images decoding, KaTeX/syntax-highlight hydration inside the just-prepended `ChatMessage`s (`ChatMessage.tsx` runs `renderContent` which hydrates markdown/code asynchronously) keep shifting layout AFTER the `useLayoutEffect` fires. The compensation ran once; subsequent growth was uncompensated → pop.
3. **`overflow-anchor: auto`** — browser picks the anchor by heuristic. The list has `<div key="load-more">` pinned at DOM position 0 (L1534–1538), which is a stable visible/near-visible element above the reading position — the browser tends to anchor on *that* instead of the user's current message. Worse, **turn-divider and group keys use array indices** (`fin-${i}` L1549, `rg-${i}` L1567, `fin-tail` L1588) — on prepend, `i=0` now points to a different message, so React remaps those DOM nodes to different content. Any browser anchor that happened to land on one of those divs now references content from a completely different part of history. Anchor stability is silently broken.

### Root cause summary

- No single anchor survives the combination of (top-prepend + bottom-streaming + delayed async layout growth inside prepended content).
- Index-based React keys (`fin-${i}`, `rg-${i}`) destabilize DOM node identity on prepend, defeating `overflow-anchor`.

### Recommended fix

Three coordinated changes:

**1. Stabilize keys in `messageElements` (L1527–1594).** Replace index-based keys with msg-id-based:
- L1549: `key={\`fin-${msg.id}\`}`
- L1567: `key={\`rg-${msg.id}\`}`
- L1588: change `fin-tail` to `fin-tail-${lastMsg.id}`

**2. Replace the no-op `triggerLoadMore` (L392–401) with anchor-capture + continuous compensation.**

```tsx
// Add near other refs, ~L386–390
const anchorRef = useRef<{ id: string; offsetFromTop: number } | null>(null);

// Replace L392–401
const captureAnchor = useCallback(() => {
  const el = chatBodyRef.current;
  if (!el) return;
  const containerTop = el.getBoundingClientRect().top;
  // First message whose bottom is below the viewport top = topmost visible message.
  const msgs = el.querySelectorAll<HTMLElement>("[data-msg-id]");
  for (const m of msgs) {
    const r = m.getBoundingClientRect();
    if (r.bottom > containerTop + 1) {
      anchorRef.current = { id: m.dataset.msgId!, offsetFromTop: r.top - containerTop };
      return;
    }
  }
  anchorRef.current = null;
}, []);

const triggerLoadMore = useCallback(() => {
  if (loadMorePending.current) return;
  if (firstVisibleIdxRef.current <= 0) return;
  const now = performance.now();
  if (now - lastLoadMoreAt.current < LOAD_MORE_COOLDOWN_MS) return;
  loadMorePending.current = true;
  lastLoadMoreAt.current = now;
  captureAnchor();                                         // snapshot BEFORE state change
  setFirstVisibleIdx((v) => Math.max(0, v - LOAD_MORE_BATCH));
  requestAnimationFrame(() => { loadMorePending.current = false; });
}, [captureAnchor]);
```

**3. Add a compensating `useLayoutEffect` that both restores on commit AND chases subsequent layout shifts** (insert after L401, keyed on `firstVisibleIdx`):

```tsx
useLayoutEffect(() => {
  const anchor = anchorRef.current;
  if (!anchor) return;
  const el = chatBodyRef.current;
  if (!el) return;

  const restore = () => {
    const target = el.querySelector<HTMLElement>(
      `[data-msg-id="${CSS.escape(anchor.id)}"]`
    );
    if (!target) return;
    const containerTop = el.getBoundingClientRect().top;
    const current = target.getBoundingClientRect().top - containerTop;
    const delta = current - anchor.offsetFromTop;
    if (Math.abs(delta) > 0.5) {
      suppressNextScroll.current = true;                   // reuse existing flag (L407)
      el.scrollTop += delta;
    }
  };

  restore();                                               // commit-time compensation

  // Chase async growth: images decoding, markdown/KaTeX hydration, syntax highlighter,
  // ChatMessage's renderContent. ResizeObserver on EVERY child above the anchor
  // catches any height change and re-compensates before paint.
  const ro = new ResizeObserver(restore);
  const target = el.querySelector<HTMLElement>(
    `[data-msg-id="${CSS.escape(anchor.id)}"]`
  );
  if (target) {
    let n: Element | null = el.firstElementChild;
    while (n && n !== target) { ro.observe(n); n = n.nextElementSibling; }
  }

  // Release after content settles OR when user initiates a new load-more.
  const settle = window.setTimeout(() => {
    ro.disconnect();
    anchorRef.current = null;
  }, 2500);

  return () => { clearTimeout(settle); ro.disconnect(); };
}, [firstVisibleIdx]);
```

**4. Leave `overflow-anchor: auto` in CSS (ClaudeChat.css L432).** With the JS anchor now authoritative, native anchor becomes a harmless second line of defense; they don't fight because `suppressNextScroll` eats the compensation's scroll event.

### Why this survives concurrent streaming + async content

- **Streaming at bottom**: anchor is measured as `getBoundingClientRect().top - container.top` — a position relative to the viewport top. Bottom mutations (streaming, `StreamingBubble` L2025, pending-permission L2026+) change `scrollHeight` but do **not** change the rect of an element above the viewport top. Delta computed from rect is unaffected. The prior "scrollHeight delta" attempts failed precisely because they summed both ends.
- **Async content inside prepended messages**: `ChatMessage` hydrates markdown, KaTeX, code-highlight asynchronously — each hydration resizes a child. `ResizeObserver` fires synchronously before the next paint and re-runs `restore()`, so the anchor is re-pinned every frame it shifts. Works for multi-frame image decode, late-arriving stylesheets, web-font reflow — anything observable as a resize.
- **Key stability (fix #1)**: with msg-id keys, `ChatMessage` wrappers keep DOM identity across the prepend, so `querySelector('[data-msg-id=…]')` reliably finds the same `<div>` before and after. The turn-divider/group wrappers sandwiching anchor messages currently remount on prepend (index keys) — that disturbs layout of the anchor element's *siblings*, which ResizeObserver would then observe and overcompensate for. Fixing keys is not optional.
- **User scrolls during settle window**: scroll handler (L446) already handles `suppressNextScroll` (L451–455); our compensation fires at most once per RO callback. If the user scrolls for real, `delta < -1` path (L460) unpins; no conflict with restore (restore only nudges by observed shift, not to a fixed position).
- **Re-entrant load-more**: if user triggers another load-more within 2.5s, `triggerLoadMore` overwrites `anchorRef` and the new useLayoutEffect cycle tears down the previous RO via its cleanup.

### Verification checklist (for whoever implements)

1. Scroll to middle of a long session, trigger load-more via scroll — reading message stays pixel-stable.
2. Same, but with a live-streaming response at the bottom — still stable.
3. Load-more into messages containing large images / code blocks / markdown — still stable as content hydrates.
4. Rapid consecutive load-mores (click the `cc-load-more` button repeatedly) — each one pins its own anchor; no accumulated drift.
5. Trigger load-more, then scroll manually within 2.5s — manual scroll wins, no fight.

### Estimated diff size

~60 lines of new code, ~6 key-string edits, zero CSS changes, zero new dependencies.

---

## Agent 2 findings — full actor audit, ranked by likelihood

Converges with Agent 3 on the fix direction. Adds one reinforcing root cause that I don't think Agent 3 caught, plus exhaustive ruling-out of everything else.

### 🚨 #1 (strong reinforcement of Agent 3): WebKit silently ignores `overflow-anchor`

- User runs Tauri on Darwin (macOS) → **WKWebView** → WebKit engine. Per https://caniuse.com/css-overflow-anchor, **Safari/WebKit has never shipped scroll anchoring**.
- `ClaudeChat.css:432` `overflow-anchor: auto` on `.cc-messages` therefore does **nothing** on the user's machine. Zero browser-side anchor adjustment. The entire "browser-native, no JS" attempt is a no-op in this runtime.
- This makes Agent 3's "prior #3 attempt failed because browser anchored on the wrong element" slightly off for macOS specifically: on macOS the browser never anchored at all; on Chromium it anchored on the wrong element. Same observable symptom, different mechanism. Either way, the JS-based fix Agent 3 proposes is required (it can't rely on native anchoring at all on macOS).
- Code comments at `ClaudeChat.tsx:476–480` and `402–407` still talk about "the layout effect restores scrollTop" and reference `suppressNextScroll.current` — there is no such layout effect in the current tree (confirmed by grep: no `useLayoutEffect` exists in `ClaudeChat.tsx`; `suppressNextScroll.current = true` is *set* nowhere, only *consumed* at L451). Stale comments from the removed attempt.

### Everything that can touch `.cc-messages` scrollTop/layout — exhaustive

**Actors (confirmed active):**
- Load-more state change → re-renders `messageElements` memo → DOM mutation inside the scroll container. No scrollTop compensation. ← the bug.
- `scrollToBottom` (`ClaudeChat.tsx:409–414`): writes `el.scrollTop = el.scrollHeight`. Only fires when `pinnedToBottom.current === true`, which is false while user is reading history. Ruled out as load-more actor.
- Three auto-follow effects (`L534–551`): `messages.length`, `pendingPermission`, `streamingText` subscription. All gated on `pinnedToBottom.current`. Ruled out.
- `sessionId`-change effect (`L416–425`): only on session swap. Ruled out.
- `jumpToPrompt` (`L1618–1639`): user-initiated, uses `scrollIntoView`. Ruled out.
- Edit-overlay close (`L1930–1933`): `el.scrollTop = savedScrollTop.current` after Monaco close. Unrelated path.

**Observers / double-effects (ruled out):**
- No `ResizeObserver`, no `MutationObserver` anywhere in `src/` that touches `.cc-messages` (grep confirmed).
- No `useLayoutEffect` anywhere in `ClaudeChat.tsx` (grep confirmed).
- `main.tsx` renders `<App />` without `StrictMode` — no double-invocation of effects.

**ChatMessage.tsx (ruled out as actor, but aggravator):**
- Zero scroll/layout APIs inside it (grepped). It does not touch scrollTop.
- It *does* render markdown + code highlighting inside tool-call bodies and diff bodies — those hydrate asynchronously and resize their containers post-mount. Which is exactly the phenomenon Agent 3's `ResizeObserver`-based chase is designed to absorb.

**CSS actors on the scroll container and its ancestors:**
- `.cc-messages` (`L417–442`): `display: flex; flex-direction: column; gap: 10px; overflow-anchor: auto; overscroll-behavior-y: contain; scroll-behavior: auto`. The flex layout is worth flagging: even in Chromium, scroll-anchoring in flex-column containers has historically had anchor-selection bugs. Non-issue with Agent 3's JS fix.
- `.cc-chat-col` (`L2431–2438`): `flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; position: relative`. No transform, no contain. Clean.
- `.floating-terminal` (`FloatingTerminal.css:1–15`): ancestor has `will-change: transform; transform: translateZ(0); backface-visibility: hidden; contain: layout paint; isolation: isolate`. Per spec, none of these disable scroll anchoring of a descendant scroll container. They can introduce subpixel imprecision on HiDPI, but cannot produce a 30-message pop. Non-cause.
- Canvas root (`Canvas.tsx:90`): `transform: translate(panX,panY) scale(z)`. Same reasoning — spec-safe, may introduce rounding. Non-cause. **Note for implementer**: if the user is zoomed on the canvas, `getBoundingClientRect()` values used in Agent 3's `captureAnchor` / `restore` will reflect the *scaled* viewport geometry, and `scrollTop` is stored in unscaled container-local CSS px. Subtracting a scaled `containerTop` from a scaled `target.top` gives a scaled delta; dividing by `z` (zoom) may be necessary, or capture/restore while `.cc-messages` is inside a transformed ancestor can be verified to cancel out. Worth a manual zoom-out test after implementing fix.

**Key stability (independent confirmation of Agent 3 #2):**
- `messageElements` memo at `ClaudeChat.tsx:1527–1595`: `msgs = allMsgs.slice(startIdx)`, `i` indexes into the slice. Keys `fin-${i}` (L1549), `rg-${i}` (L1567), `fin-tail` (L1588) all change when `startIdx` shifts — whole-list remounts of dividers/grouped-tool-cards. Agent 3's msg-id key fix is required.
- Stable keys confirmed: `msg.id` on `ChatMessage` (L1572), `compact-${msg.id}` on `CompactDivider` (L1576–1578), `load-more` banner key (L1535).

**Load-more banner behavior (minor, belt-and-suspenders):**
- `.cc-load-more` (`L1533–1538`, CSS `L488–503`) mutates text and unmounts at `firstVisibleIdx === 0`. Not a primary issue because Agent 3's anchor-capture picks the first `[data-msg-id]` element (L54–62 of their snippet), skipping the banner. But on Chromium (where `overflow-anchor: auto` *does* work) the banner might still be the browser's anchor pick; adding `overflow-anchor: none` on `.cc-load-more` would be free hardening.

### Convergence with Agent 3

Fully endorse Agent 3's four-part fix (stabilize keys → capture anchor on a real `[data-msg-id]` → `useLayoutEffect` restore → `ResizeObserver` chase). It is browser-engine-agnostic and therefore works on WKWebView where `overflow-anchor` is ignored entirely, *and* on Chromium where the native anchor picks the wrong element. One small addition I'd suggest: after the `setTimeout` settle, also clear `anchorRef.current = null` is already there — good; consider also clearing it inside `onScroll` when `delta < -1 && current > LOAD_MORE_TRIGGER_PX` (user genuinely navigated away), so a late RO callback doesn't yank scrollTop during an in-flight user scroll.

### What this agent explicitly did NOT find

- No stray `scrollTop = 0` anywhere in `ClaudeChat.tsx` or `ChatMessage.tsx` (grep confirmed).
- No `scrollIntoView` that fires during load-more (only `jumpToPrompt`).
- No CSS `content-visibility` or `contain-intrinsic-size` on messages (non-issue — nothing is lazily-measured via that mechanism).
- No `position: sticky` inside `.cc-messages` that would confuse anchor math.
- No side panel open/close effects that mount/unmount the scroll container (`.cc-messages` keeps its ref stable across `sidePanelOpen` toggles).

---

## Agent 1 findings — instrumentation + scrollTop timeline

### TL;DR
Converges with Agents 2 + 3. The pop is **not** any JS path writing a low scrollTop — it's scrollTop staying constant while scrollHeight grows above it. On WKWebView `overflow-anchor` is a no-op (Agent 2 verified via caniuse), so nothing compensates. Instrumentation below is designed to prove this from live logs, not just code-reading.

### Every write to `chatBodyRef.current.scrollTop` (grep-verified)
- **L413** `scrollToBottom` — sets to `scrollHeight`. Callers: mount/session-change effect (L424, behind rAF), auto-follow effect (L534, gated on `messages.length` changing — **not touched by load-more**). Ruled out as load-more actor.
- **L1932** — Monaco edit-overlay close. Unrelated branch.
- Nothing else. `setFirstVisibleIdx` never assigns scrollTop on any path. Confirms the "stationary scrollTop while content grows" signature.

### Instrumentation I installed (will remove before `report_done`)
All writes are `console.log("[SCROLL-DBG] …", {...})`:
1. **`triggerLoadMore`** (L392 area): logs scrollTop / scrollHeight / clientHeight / distFromBottom BEFORE `setFirstVisibleIdx`, then at `requestAnimationFrame` #1 (post-commit), then at rAF #2 (next paint).
2. **`onScroll`** (L446 area): every scroll event — scrollTop, delta, scrollHeight, `inTopRegion` transition, `pinnedToBottom`, `programmaticScroll`, `suppressNextScroll`.
3. **`scrollToBottom`** (L409 area): logs before/target with a 4-line stack slice to identify any unexpected caller.
4. **Auto-follow effect** (L534 area): logs `messages.length`, `pinnedToBottom`, scrollTop/scrollHeight when it fires.

### Predicted log signature on one load-more cycle
```
onScroll { scrollTop: 320, delta: -40, inTopRegion: false, prevInTopRegion: false, … }
onScroll { scrollTop: 260, delta: -60, inTopRegion: true,  prevInTopRegion: false, … }  ← edge fire
[SCROLL-DBG] triggerLoadMore FIRE  { fromIdx: 100, toIdx: 70, scrollTop: 260, scrollHeight: 12000 }
[SCROLL-DBG] triggerLoadMore rAF#1 { scrollTop: 260, scrollHeight: 17000 }   ← SMOKING GUN
[SCROLL-DBG] triggerLoadMore rAF#2 { scrollTop: 260, scrollHeight: 17000 }
(no onScroll fires — scrollTop didn't change)
```
- rAF#1 scrollTop **unchanged** + scrollHeight **jumped by prepended-height** → WKWebView ignored `overflow-anchor` entirely (Agent 2's diagnosis).
- rAF#1 scrollTop jumped by exactly `(newHeight − oldHeight)` → anchoring fired but picked wrong element (Agent 3's Chromium-side failure mode).
- The auto-follow logger should be SILENT during a pure load-more. If it fires, that means concurrent streaming is adding to `messages.length` during the same tick, which itself does not write scrollTop (because `pinnedToBottom` is false while scrolled up) — so still not a culprit, but worth confirming on-device.

### Why no `onScroll` fires after rAF#1
Because scrollTop is not being changed. The existing `suppressNextScroll` flag at L451 is a red herring — nothing ever sets it (also flagged by Agent 2 as stale from the removed attempt). Even if anchoring DID fire on Chromium, it would fire a synthetic scroll event; absence of that event in the log is itself a signal that WKWebView is the runtime.

### Convergence
Agree with Agents 2 + 3 on:
- Root cause = no anchor compensation actually running (WKWebView no-op on macOS; Chromium would anchor on the wrong element due to sentinel + index-key churn).
- Fix = Agent 3's four-part (stable keys + capture anchor by `data-msg-id` + `useLayoutEffect` restore + `ResizeObserver` chase).

### Small refinements I'd add to Agent 3's fix
1. Add `overflow-anchor: none` on `.cc-load-more` in CSS. Belt-and-braces so any future Chromium/iOS-WebKit run doesn't pick the sentinel as native anchor and fight the JS compensation.
2. Observe the anchor element *itself* with the `ResizeObserver`, not just its preceding siblings — catches the case where a child of the anchor (avatar image, KaTeX block) grows above the anchor's measured `rect.top` line.
3. Agent 2's canvas-zoom warning is worth heeding: `getBoundingClientRect` returns scaled coordinates when an ancestor has `transform: scale(z)` (Canvas.tsx). Store/compare deltas relative to the container's own `getBoundingClientRect` (which is scaled identically), then assign `el.scrollTop += delta / z` — OR stay in unscaled coords by using `offsetTop` chains relative to the scroll container. Agent 3's snippet uses `getBoundingClientRect` for both container and target, so the ratio cancels out — but the `el.scrollTop += delta` step applies a *scaled* delta to an *unscaled* scrollTop. On zoomed canvases this will overshoot/undershoot. Fix: `el.scrollTop += delta / (zoomFactor)` or compute delta via `offsetTop` instead.

### Cleanup
Removing all four `[SCROLL-DBG]` console.log sites now (before `report_done`).

