# Save-bug investigation

## Agent 1 — Save/Load Race Analysis

### Ranked hypotheses (most likely first)

---

**H2 — Discord orphan pruning wipes live session rows. VERIFIED (likely root cause).**

`src/App.tsx:105-153`. The discord init block runs inside `useEffect(..., [])` right after mount. It:

1. Reads localStorage `STORAGE_KEY` into `claudeSaved` (line 114-115).
2. Waits `2000 ms` for the gateway (line 108).
3. Builds `activeClaudeSids` from `canvasStore.terminals` where `panelType === "claude"` (line 123-125).
4. Builds `activeNames` by looking up each active `sid` in the live `claudeSessions` and `claudeSaved` maps (line 128-131).
5. Then scans `claudeSaved` for rows not in `activeClaudeSids` with a matching name and pushes them into `orphanSids`, then writes back a mutated snapshot (line 132-142):
   ```ts
   const updated = { ...claudeSaved };
   for (const sid of orphanSids) delete updated[sid];
   localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
   ```

There is a 2-second race here. Between `t=0` (render) and `t≈2000ms` (the rewrite), `claudeStore` is doing:
- `createSession(sessionId)` from `ClaudeChat.tsx:341` — hydrates from the same localStorage snapshot.
- `debouncedSave()` (1s timer, `claudeStore.ts:284`) flushes a fresh snapshot that includes newly restored sessions.
- Any first `addUserMessage` / `finalizeAssistantMessage` flushes immediately.

Meanwhile the discord block is holding the 2-seconds-old `claudeSaved` variable it read *before* the delay. When it writes back (`localStorage.setItem(..., JSON.stringify(updated))` at line 142), it **clobbers every write that claudeStore did during those 2 seconds** with the pre-delay snapshot (minus orphans). So:
- Any new message appended in that window is lost.
- Any newly created unnamed session is lost.
- If canvas has re-opened a named session with the same name but a different `sid` than what's in `claudeSaved` (e.g. after a rewind/fork, or after `existingSessionId` routing hit), the *still-live* session row gets matched as an "orphan" and deleted.

The "replay an old state" symptom matches: the session comes back showing whatever was in localStorage when the app booted, because the async discord block re-wrote that exact snapshot over the top of any in-flight saves.

Also note line 147-151: `cs.removeSession(sid)` is called for every orphan sid, which will drop those from in-memory state as well — so if orphan detection misfires, the chat that was just visible disappears from memory too.

This is the most plausible explanation for "reverting to an old state" because it's timed, asynchronous, and deliberately rewrites localStorage with stale data.

---

**H4 — saveToStorage merge loop can delete active-but-evicted sessions. VERIFIED (secondary cause).**

`src/stores/claudeStore.ts:176-181`:
```ts
for (const id of Object.keys(existing)) {
  if (!sessions[id] && (!existing[id]?.name || existing[id]?.name?.startsWith("[D] "))) {
    delete existing[id];
  }
}
```
This fires on every `saveToStorage`. If a Claude panel is closed — `App.tsx:293-296` removes the session from memory only when `!sess?.name`. But the test here is `!existing[id]?.name` against the previously-persisted row, not the current in-memory row. If a session existed in localStorage without a `name` (e.g. user sent a prompt before ever naming it) and was then closed, the next save by ANY other session deletes it. Plausible contributor, but less likely to explain "reverted to an old state" — this is pure data loss, not rollback.

---

**H3 — loadFromDisk overwrites newer in-memory messages. VERIFIED (conditional).**

`src/stores/claudeStore.ts:590-599`: `loadFromDisk` does `messages, promptCount, hasBeenStarted` replacement unconditionally (the doc comment even says "replaces current messages unconditionally"). Triggered from `App.tsx:517-523` in `onReopen` only when `hasMessages === false` in localStorage. So in the common path it's gated. But if localStorage was just wiped by H2 (so `hasMessages` reads as false) *and* JSONL is stale relative to the wiped-but-once-fresh localStorage, you get stale disk data loaded over a session that had newer content one heartbeat ago. H2 + H3 compound.

---

**H1 — Boot race with canvasStore.getInitialState. RULED OUT (standalone).**

`canvasStore.ts:176-208` runs synchronously at module load. `ClaudeChat.tsx:340-345` calls `createSession(sessionId)` which in `claudeStore.ts:291-325` checks in-memory first, then calls `loadSession` which reads localStorage. No intervening writer exists *in the boot path itself* — the only async writer is the discord block (H2). So on its own this isn't a race; it just provides the window H2 exploits.

---

**H5 — 5-second setInterval firing with empty sessions. RULED OUT.**

`claudeStore.ts:781-783` only calls `saveToStorage` when `isDirty` is true. `isDirty` is only set by `debouncedSave` (line 282). Boot does not set it. And even when it fires, `saveToStorage` merges with existing localStorage (line 168-181) so an empty in-memory map would still preserve named persisted rows. No standalone corruption path.

---

**H6 — quota-exceeded fallback truncates to last 200. NEEDS MORE INFO.**

`claudeStore.ts:204-227`: the recovery path only runs when the primary `setItem` throws (quota or serialization error). If the user's messages are very large (tool calls with big diffs), this would silently drop all but the last 200. It would present as "lost recent messages" but not as "reverted to an old state". Worth instrumenting: the code already `console.warn`s `"Saved truncated session data (quota recovery)"` — ask the user to check devtools console.

---

**H7 — loadFromDisk merges vs overwrites. VERIFIED (overwrites).**

Already covered in H3. `loadFromDisk` overwrites; `mergeFromDisk` (lines 605-619) is append-only by id. The refresh path after errors at `ClaudeChat.tsx:1966` uses `mergeFromDisk` (safe). The reopen path at `App.tsx:520` uses `loadFromDisk` (unsafe if combined with H2).

---

### Recommended fix order

1. **H2 (App.tsx:114-142)**: Re-read localStorage immediately before the mutate-and-write instead of using the pre-delay snapshot. Better: compute orphanSids, then mutate in one pass via the JSON parsed fresh. Even better: gate the orphan-prune behind an explicit user action — it's running on every launch.
2. **H4 (claudeStore.ts:176-181)**: Don't delete an `existing[id]` row just because it has no `name` — only delete when explicitly removed. Currently the "unnamed = disposable" heuristic fights with panels closed before naming.
3. **H3/H7 (claudeStore.ts:590)**: Make `loadFromDisk` a safe merge-or-replace that keeps whichever side has more messages, or refuses to overwrite if the in-memory array is longer. The reopen path currently only calls it when `!hasMessages`, but after H2 misfires `hasMessages` can be a lie.

Key citations:
- `/Users/janislacars/Documents/Terminal-64/src/App.tsx:114`, `:142`, `:147-151`, `:517-523`
- `/Users/janislacars/Documents/Terminal-64/src/stores/claudeStore.ts:164-229`, `:280-285`, `:590-599`, `:605-619`, `:781-783`
- `/Users/janislacars/Documents/Terminal-64/src/components/claude/ClaudeChat.tsx:340-345`
