# Island Debug — Parallel Agent Findings

## Agent 1 findings — Ref leakage / instance identity

### Verdict: NOT the root cause.

All island-related refs are properly instance-scoped. Cross-chat ref leakage is ruled out.

### Evidence

1. **All island refs are `useRef` calls inside the `ClaudeChat` function body** (`src/components/claude/ClaudeChat.tsx`):
   - `messagesEndRef` — line 252
   - `chatBodyRef` — line 253
   - `containerRef` — line 254
   - `islandElRef` — line 276
   - `progressCircleRef` — line 277
   - `islandOpenRef` — line 278

   React's `useRef` returns a fresh object per component instance. There is no way for two instances of `ClaudeChat` to share these refs.

2. **No module-level ref-like state** in `ClaudeChat.tsx`. Grep for `^(let|const|var)` returned only:
   - `let monacoThemeForBg = ""` (line 28) — Monaco theme cache, unrelated.
   - `const REWIND_ACTION_FALLBACK` (line 36) — static.
   - `const MODELS` (line 185), `const EFFORTS` (line 196) — static arrays.

   None of these touch the island. A module-level `let` holding `islandElRef` etc. does NOT exist. No leakage vector.

3. **FloatingTerminal is keyed on `term.id`** in Canvas:
   - `src/components/canvas/Canvas.tsx:274` — `<FloatingTerminal key={term.id} term={term} />`
   - `src/stores/canvasStore.ts:137,158` — `id: uuidv4()` at creation.
   - No action in `canvasStore.ts` reassigns `.id` on an existing tile. (Grep of `\.id\s*=` shows only comparisons and reads, no assignments.)

   → Each tile has a permanent, unique key. React never reuses the same FloatingTerminal instance for a different tile.

4. **`term.terminalId` (= ClaudeChat's `sessionId` prop) is also immutable after creation**:
   - Assigned at `canvasStore.ts:135,138,159,282,301,310`.
   - No action reassigns `terminalId` on an existing tile. So ClaudeChat never sees its `sessionId` prop mutate mid-mount. The same ClaudeChat instance is NEVER reused for two different sessions.

5. **Only one JSX element attaches `islandElRef`** (line 2073) and one attaches `progressCircleRef` (line 2085). No duplicate-ref cross-wiring within a single instance.

6. **FloatingTerminal is `memo`'d** with default shallow-equality. The only prop is `term`. Zustand re-emits a new `term` object only when that tile's fields change (`.map(t => t.id === id ? {...t, ...} : t)`). Memo works correctly — it does not freeze a stale ClaudeChat instance across tiles.

### Conclusion

The "stuck on one chat / missing on all others" symptom **cannot** be caused by ref or instance sharing. Each ClaudeChat gets its own refs, its own DOM, and its own useLayoutEffect closures.

### Side observation (may be useful to other agents)

`chatBodyRef` is assigned at only one JSX location (line 2238) inside a ternary:

```tsx
{editOverlay ? (<edit overlay — no chatBodyRef>)
  : showPlanViewer && planContent ? (<plan viewer — no chatBodyRef>)
  : (<div className="cc-messages" ref={chatBodyRef}>...)}
```

When `editOverlay` or `showPlanViewer` is truthy, `chatBodyRef.current` becomes `null` while `islandElRef.current` is still live. `syncIslandFromDom` (line 522) early-returns in that case — which could leave the island stuck in whatever class state it was in. This is a per-instance issue, not a cross-instance leak, but it's a plausible contributor to the "stuck" symptom on a chat where the user entered/exited one of those modes.

### More likely root causes (hand-off)

- **useLayoutEffect with no deps**: runs every render, but if a given ClaudeChat doesn't re-render (no store updates hitting it, no user interaction), the effect doesn't re-fire. The inactive/background chats likely re-render less, so their island state gets wedged. Scroll handler + ResizeObserver + 300ms poll are backstops — worth checking that they're all attached in prod.
- **Prod build CSS/class-ordering**: `.cc-island--hidden` selector specificity vs `.cc-island--open` — if prod minifies/reorders stylesheets differently, the `--hidden` rule might lose specificity. Worth checking `ClaudeChat.css`.
- **The stuck-on-one chat is probably the one that was most recently scrolled**: its last-written classList is "visible", and without a re-render or scroll event, nothing resets it. This overlaps with the editOverlay/planViewer issue above.

### No code change proposed from this agent — ref leakage ruled out.

If the other agents find a fix, a defense-in-depth improvement from this angle would be: add `sessionId` to the useLayoutEffect's dep array so remounts/session changes re-sync, but per (4) above, sessionId never changes mid-mount, so this would only help at mount (which already runs).

---

## Agent 4 findings — dev vs prod build difference

### Timestamps (Apr 21)
- `src/components/claude/ClaudeChat.tsx` mtime: **05:58:07**
- `src/components/claude/ClaudeChat.css` mtime: 05:25:56
- `dist/assets/index-B5j8yi0F.js` mtime: **05:39**
- `dist/index.html` mtime: 05:39
- `src-tauri/target/release/bundle/macos/Terminal 64.app` mtime: **05:39**

**Source is 19 minutes newer than the built `.app`.** Any "prod" testing right now runs an older iteration of the island code than what is in the editor. The island logic has been edited since the last build.

### (a) Bundle contents vs source — imperative classList calls

Verified with raw `grep -o cc-island--hidden | wc -l`:
- Bundle (`dist/assets/index-B5j8yi0F.js`): **5 matches**
- Source (`ClaudeChat.tsx`): **8 matches** → 3 are JSDoc/inline comments (lines 272, 737, 2059). Comments are stripped by the prod build. Non-comment = **5**.

Counts match. All 4 call sites and the JSX baseline className land in the bundle:
- scroll-path `remove`/`add` inside `syncIslandFromDom` (source 529/531)
- post-render `useLayoutEffect` `remove`/`add` (source 749/751)
- JSX `cc-island cc-island--hidden` baseline

**The build step is not dropping or re-ordering the island code.** What's in the bundle *is* the iteration that was in source at 05:39 — there's just a *newer* iteration on disk since.

### (b) React 19 production optimization / React Compiler

`package.json`:
- `react: ^19.2.4`, `react-dom: ^19.2.4`
- `@vitejs/plugin-react: ^6.0.1` — called as plain `react()` in `vite.config.ts`, no options.
- **No `babel-plugin-react-compiler`.** No `react-compiler-runtime`. No `.babelrc` or `babel.config.*`.

React Compiler is not running → no auto-memoization silently rewriting `useLayoutEffect` or refs. React 19 prod vs dev does **not** change `useLayoutEffect(cb)` (no deps) semantics — synchronous, post-commit, pre-paint, every render, both modes. If `<StrictMode>` is wrapping the tree (didn't fully verify), it would fire effects *twice in dev*, making dev more aggressive, not less — so it cannot explain "works in dev, broken in prod."

### (c) `.app` embedding — latest dist?

`src-tauri/tauri.conf.json` → `"frontendDist": "../dist"` and `"beforeBuildCommand": "npm run build"`. So `tauri build` regenerates `dist/` then copies it into `Terminal 64.app/Contents/Resources/`.

Both `dist/` and the `.app` stamp at 05:39 → produced in the same `tauri build` run. Source edits landed at 05:58 and **there has been no rebuild since**. Re-launching the existing `.app` reads the 05:39 snapshot, not the current source.

### (d) Tauri CSP / webview config

`app.security.csp: null` → **no CSP**. `ResizeObserver`, `MutationObserver`, `window.setInterval` are standard WebView2/WKWebView APIs, not gated by Tauri capabilities. Safari 13.1+ / macOS 12+ support all three. Nothing is blocking them.

Other webview flags (`macOSPrivateApi: true`, `transparent: true`, `decorations: false`) are window-chrome-only — don't touch JS.

### Genuine dev-vs-prod behavioral gap that *could* matter

Vite HMR / React Fast Refresh. In dev, every source save remounts `ClaudeChat`, which re-runs the mount-time `syncIslandFromDom()` call (line 547) against the fresh DOM and rebinds every observer. In prod the component mounts once and the closure on the big effect at line 499 captures `el = chatBodyRef.current` at that instant. Agent 1 already noted: `chatBodyRef` is mounted in a ternary (line 2238) — when `editOverlay` / `showPlanViewer` toggle, `.cc-messages` unmounts and remounts, giving `chatBodyRef.current` a *new* DOM node. The effect at 499 has those in its deps so it re-runs, but only for this chat. Other long-lived chats' captured `el` is fine there. This alone doesn't produce the reported cross-chat symptom.

More suspect: the 300ms `setInterval(syncIslandFromDom, 300)` and the `ResizeObserver(syncIslandFromDom)` close over *this instance's* `chatBodyRef` and `islandElRef`. They keep firing every 300ms regardless of whether this tile is active. Each interval writes `--hidden` class on *its own* `islandElRef.current`. No cross-instance write. **However:** if the component remounts (sessionId changes? no, Agent 1 says no — but canvas tile close/reopen for the same session would) and the old interval isn't cleared because cleanup ran against a different effect instance, the stale interval writes into a detached element — harmless for visibility. So this path doesn't explain "stuck with stale content on one chat" either.

The only prod-specific mechanism I can identify is: StrictMode dev double-mount cleaning up the stale interval; StrictMode off in prod means any bug where the cleanup function closes over wrong captured state persists once in prod but gets sanitized in dev. Worth an eyeballing but not a smoking gun.

### Verdict

**Primarily a stale-build user-error.** Secondary: no technical dev-vs-prod gap in CSP, Compiler, minification, or observer support. React 19 production does not change useLayoutEffect semantics. The user's `.app` is simply 19 minutes behind their source.

### Proposed fix

1. **First action, zero code change:** `npm run tauri build`, relaunch the fresh `.app`, and retest. There is no technical reason the bug should behave differently in a fresh prod build than in dev, given the current config. If the bug disappears, case closed — it was pre-05:58-iteration noise captured by a .app nobody rebuilt.

2. **Only if bug reproduces against a fresh build:** the dev/prod story is not the culprit. Defer to the root causes the other agents identified. My angle contributes nothing further beyond the defense-in-depth already noted in Agent 1's hand-off (add `document.contains(el)` guards inside `syncIslandFromDom`, use a callback ref for `chatBodyRef` so remounts re-bind observers). These matter regardless of dev/prod.

Confidence: **HIGH** that step 1 resolves the reported "prod-only" claim. Any residual bug surviving a fresh build is not a dev-vs-prod issue.

---

## Agent 3 findings — `userPrompts.length > 0` gate + session loading

### Verdict: PARTIAL cause for "never shows" on a narrow subset of chats (CWD-mismatched restores, delegation-only, tool-result-only resumes). NOT the cause on chats that actually render user messages.

The gate at `ClaudeChat.tsx:2063` (`userPrompts.length > 0 && …`) hard-suppresses the entire island JSX subtree — including the `islandElRef` attachment. While the gate is false, `islandElRef.current` is `null`, and every syncer (`syncIslandFromDom` at line 522, post-render useLayoutEffect at 742, scroll handler, RO, MO, 300ms poll) early-returns. Only a re-render that flips the gate can bring the island back, and nothing re-evaluates the gate except a change in `session?.messages`.

### Trace of `session.messages` population (why userPrompts can stay 0)

1. **Session creation path (`ClaudeChat.tsx:343` → `claudeStore.ts:290 createSession`)**: creates store entry with `messages: []`.
2. **localStorage restore (`claudeStore.ts:230 loadSession`)**: runs inside `createSession` when `!ephemeral`. Returns `null` when `!saved.messages`, in which case we fall through to the JSONL path with an empty store entry.
3. **JSONL load (`App.tsx:518-525`)**: fires only when `hasMessages === false` in localStorage. Calls `loadSessionHistory(sessionId, effectiveCwd)` → `loadFromDisk` only when `history.length > 0` (guard at line 521). **If the JSONL path doesn't exist or is empty, `loadFromDisk` is never called and `session.messages` stays `[]` silently.**

### Concrete conditions where userPrompts is 0 for a chat that *should* have history

**(a) CWD mismatch — the most likely real-world trigger.** `App.tsx:514` computes `effectiveCwd = savedCwd || dialogCwd || "."`. If localStorage has the session row with `name` set but `cwd: ""` (e.g. session created before cwd was resolved, or restored from a corrupt save), `effectiveCwd` falls back to `"."`. Rust `session_jsonl_path` (`lib.rs:124`) computes the project-dir hash from `"."`, which never matches the real JSONL location. `read_to_string` returns `NotFound` → `lib.rs:800` returns `Ok(vec![])` → `history.length > 0` is false → `loadFromDisk` is never called → `session.messages` stays `[]` forever → **`userPrompts.length === 0` → island never renders, no warning, no error.**

**(b) Empty-`messages` localStorage row.** `App.tsx:509` reads `hasMessages = (d[sessionId]?.messages?.length || 0) > 0`. A stored session with `messages: []` (saved mid-init before any prompt arrived) routes to JSONL. Combine with (a) and you get a permanent zero.

**(c) JSONL contains only tool_result turns / assistant text.** Rust `load_session_history` (`lib.rs:815-887`) only emits a `user` `HistoryMessage` when the user turn has non-empty text AFTER `strip_system_reminders`. A resume-only session that never saw a fresh user prompt (tool_result echoes only) produces zero user messages. Chat renders assistant content, userPrompts is 0, island never shows.

**(d) Delegation children.** `ephemeral: true` → not persisted; messages come live from streaming. The `userPrompts` filter at line 1828 only excludes the literal prefix `"All delegated tasks have finished"`. A delegation panel whose only user-role entries are the auto-merge prompt is effectively 0 real prompts → no island. Matches "island missing on all delegation-spawned panels" if the user has those.

**(e) Name/messages out of sync after crash.** `saveToStorage` (`claudeStore.ts:182-198`) persists both together, but the merge-with-existing at line 176 only *deletes* unnamed or `[D]`-prefixed rows. A named session that got evicted from memory mid-init could persist with `name` set and `messages: []`. Next mount sees `hasMessages: false` → JSONL load. If that returns empty (per (a) or (c)), userPrompts stays 0 forever.

### Ruling out hypotheses raised in the task brief

- **"DICTATED:" prefix filter:** does not exist. `Grep DICTATED` across the repo returns zero matches. Voice input flows through `addUserMessage(sessionId, text)` unaltered (ClaudeChat.tsx:908, 924, 1079, 1088, 1154, 1193, 2271). Not the cause.
- **Bot-prefixed content filter:** also does not exist. The `userPrompts` useMemo has exactly three exclusions: `m.role !== "user"`, `!m.content`, and `m.content.startsWith("All delegated tasks have finished")`.

### Why this doesn't explain "island never shows in the *majority* of chats"

If a chat visibly renders user messages, those messages are in `session.messages`, so `userPrompts.length` must be > 0 by construction — the filter is a strict subset of what the chat view renders. The gate is satisfied for any normally-used chat. For those chats the island failure must be downstream (Agent 1's CSS/classList race + editOverlay chatBodyRef-null path, or Agent 4's stale-build story).

The gate IS the primary cause in the three narrow scenarios (a/b/e — cwd/empty restore), (c — resume-only), and (d — delegation panels).

### Proposed fix

Two-part, minimal, independent of the other agents' work:

1. **Remove the render gate so the island element is always mounted** (`ClaudeChat.tsx:2063`). Replace `{userPrompts.length > 0 && (() => { … })()}` with an unconditional render. Keep suppression behavioral: in the post-render useLayoutEffect at line 742, force-hide when `userPrompts.length === 0`:

   ```tsx
   const shouldShow = (scrolledUp || islandOpen) && userPromptsLenRef.current > 0;
   if (shouldShow) island.classList.remove("cc-island--hidden");
   else island.classList.add("cc-island--hidden");
   ```

   Thread the latest length through a ref so the no-deps effect reads it without adding a dep:
   ```tsx
   const userPromptsLenRef = useRef(0);
   userPromptsLenRef.current = userPrompts.length;
   ```

   This eliminates the "ref never attaches" failure mode entirely and makes the visibility decision a pure function of (scrolledUp, islandOpen, userPrompts.length). Also cures Agent 1's editOverlay remount concern for the island — the island lives outside `.cc-messages`, so it isn't torn down by the ternary.

2. **Fail loud on the silent CWD-fallback zero-result case** (`App.tsx:519-525`):
   ```ts
   loadSessionHistory(sessionId, effectiveCwd).then((history) => {
     if (history.length > 0) {
       useClaudeStore.getState().loadFromDisk(sessionId, mapHistoryMessages(history));
     } else if (effectiveCwd === "." || !savedCwd) {
       console.warn("[session] zero history loaded — likely cwd mismatch", { sessionId, effectiveCwd, savedCwd, dialogCwd });
     }
   })
   ```
   Longer-term fix: persist `cwd` eagerly on first resolution so the `"."` fallback never fires for named sessions.

### Files that would change
- `src/components/claude/ClaudeChat.tsx` — drop the `userPrompts.length > 0 &&` gate at line 2063; add `userPromptsLenRef`; extend the useLayoutEffect at 742 to force-hide when length is 0.
- `src/App.tsx` — diagnostic warn on cwd-fallback zero-history.

### No code written — leaving implementation for the user to pick among the four agent proposals.

---

## Agent 2 findings — useLayoutEffect execution (742–753)

### (a) Does ClaudeChat actually re-render in prod on scroll?  **YES — via `setScrollProgress`, not `setIsScrolledUp`.**

`onScroll` (549) → `syncIslandFromDom` (522) → `setScrollProgress(progress)` every tick. `progress = 1 - scrollTop/maxScroll` is a continuous float — almost never equal to the previous value, so React *never* bails out of this setState. A render is guaranteed per scroll event. `setIsScrolledUp(scrolledUp)` right after CAN bail on a same-value bool, but that's irrelevant because the float call already scheduled the render.

Separately: the 300 ms `setInterval(syncIslandFromDom, 300)` at line 658 keeps calling `setScrollProgress` even when idle, so the no-dep `useLayoutEffect` at 742 fires ~3×/s on a chat whose `chatBodyRef` is live. **React-19-prod same-value bailout is NOT the bug.**

### (b) Is `islandElRef.current` bound when `useLayoutEffect` runs in non-default branches? **YES.**

`.cc-chat-col` (line 2057 →):

```
<cc-chat-col>
  {userPrompts.length > 0 && (                                   // 2063
    <>
      <cc-island-backdrop ... />                                 // 2068
      <div ref={islandElRef} className="cc-island cc-island--hidden ..."/>  // 2073
    </>
  )}
  {editOverlay        ? <cc-messages cc-edit-overlay>   :        // 2136 — no chatBodyRef
   showPlanViewer...  ? <cc-messages cc-plan-viewer>    :        // 2231 — no chatBodyRef
                        <div className="cc-messages" ref={chatBodyRef}>}  // 2238
</cc-chat-col>
```

Island is a **sibling** of the overlay ternary, not nested in its default branch. So `islandElRef.current` is live whenever `userPrompts.length > 0`, independent of `editOverlay` / `showPlanViewer`. The `!island` side of the early-return at line 745 is effectively dead for any chat with prompts. (Agent 3's finding about `userPrompts.length === 0` chats is the orthogonal case where `islandElRef` never attaches in the first place.)

### (c) `chatBodyRef.current === null` in overlay branches

Only the default branch has `ref={chatBodyRef}` (line 2238). During `editOverlay` / `showPlanViewer`: `chatBodyRef.current = null` while `islandElRef.current` stays live.

Per-render flow during overlay:
1. JSX at 2074 writes `className="cc-island cc-island--hidden ..."` — React keeps putting `--hidden` back on every render.
2. `useLayoutEffect` (742) fires, `!el` → early-return. Does NOT touch classList.
3. Browser paints with `cc-island--hidden` → island hidden.

So overlay mode produces **stuck *hidden***, not stuck visible. The task's hypothesis (c) as literally stated is inverted.

### The actual "stuck visible with stale content" scenario

It's the overlay transition *combined with* `islandOpen === true` surviving across it:

1. `islandOpen=true`, scrolled up → island visible and expanded, showing the prompt list.
2. User triggers an edit overlay (click file path) or plan viewer. `editOverlay` truthy → `cc-messages` unmounts → `chatBodyRef.current = null`. Nothing calls `setIslandOpen(false)`.
3. During overlay: every render writes baseline `cc-island cc-island--hidden cc-island--open`. `useLayoutEffect` early-returns on `!el`. CSS: `--hidden { opacity: 0 }`. Island invisible during overlay (fine visually, but `islandOpen` state is still true under the hood).
4. User closes overlay. `editOverlay → null`. `cc-messages` remounts; `chatBodyRef` rebinds on commit.
5. `useLayoutEffect` (742) fires on that commit. `islandOpen` is **still true** — branch taken: `island.classList.remove("cc-island--hidden")`. Island is now **visible AND open**, showing the prompt list that was there *before* the overlay — stale content.
6. `requestAnimationFrame` in the overlay-close handler (line 2156) restores `scrollTop` → fires scroll → `syncIslandFromDom` → `setScrollProgress` → re-render → `useLayoutEffect` re-fires. But `islandOpen` is still true, so `scrolledUp || islandOpen` stays true → `--hidden` stays off. Island **stays visible**.
7. The user has to click the backdrop to call `setIslandOpen(false)`. Most users won't — they'll just see a "stuck" island showing an out-of-date prompt list.

This matches the reported "stuck permanently visible with stale content on one chat" — specifically the chat where the picker was open when an overlay/plan-viewer transition happened.

### Re: "missing on every OTHER chat" — my angle

The `useLayoutEffect`+classList path is per-instance and, modulo the overlay issue above, should work on every chat. I did not find a prod-specific defect in the effect itself. Agent 3's `userPrompts.length === 0` gate is the strongest candidate for the "never shows" half of the report; Agent 4's stale-bundle finding is likely the *overall* prod-vs-dev explanation. My contribution to "never shows" is negative — the `useLayoutEffect` doesn't cause it.

### Concrete fix (complementary to Agents 1, 3, 4)

Two small changes that close the stuck-visible-with-stale-content scenario without touching the architecture of the other fixes:

**1. Auto-close the picker when the branch changes.** Prevents `islandOpen` from surviving an overlay round-trip:

```tsx
useEffect(() => {
  if (editOverlay || (showPlanViewer && planContent)) setIslandOpen(false);
}, [editOverlay, showPlanViewer, planContent]);
```

**2. Stop fighting React over `cc-island--hidden`.** The root architectural issue is that JSX writes `cc-island--hidden` on every render and imperative code removes it after — which only survives because the 300 ms poll re-runs the effect, and breaks the moment either ref is null. Replace with derived state so React owns the class:

```tsx
// Remove useLayoutEffect at 742–753 entirely.
// Remove the classList.add/remove("cc-island--hidden") pair
// inside syncIslandFromDom (528–532). Keep the stroke-dashoffset DOM
// write — that has no React-side competitor.

const islandHidden = !isScrolledUp && !islandOpen;
```

JSX at 2074:

```tsx
<div
  ref={islandElRef}
  className={`cc-island${islandHidden ? " cc-island--hidden" : ""}${islandOpen ? " cc-island--open" : ""}`}
>
```

`isScrolledUp` is already maintained from every relevant source (scroll, wheel, keydown, touchmove, RO, MO, 300 ms poll — all of which already call `setIsScrolledUp`). No-flash baseline is preserved: first render has `isScrolledUp=false` and `islandOpen=false` → `cc-island cc-island--hidden`. No classList race, no ref-null trap.

This pairs cleanly with Agent 3's proposal (drop the `userPrompts.length > 0` gate, thread length through a ref): if fix #2 above is taken, Agent 3's force-hide becomes just `const islandHidden = userPrompts.length === 0 || (!isScrolledUp && !islandOpen);`.

### Files
- `src/components/claude/ClaudeChat.tsx` — add the `useEffect` for islandOpen auto-close; replace `useLayoutEffect` at 742–753 + classList toggles inside `syncIslandFromDom` with derived-state JSX className.

No code written from this agent — picking one proposal is left to the user.

— end Agent 2 —
