import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { vectorIndexSession } from "../lib/tauriApi";
import { useClaudeStore } from "../stores/claudeStore";
import type { HookEventPayload } from "../lib/types";

/**
 * Auto-indexing hook for the vector search system.
 *
 * Listens for:
 * - claude-hook-SessionEnd events → auto-embeds session summaries
 * - claude-done fallback → indexes when Claude process exits
 *
 * Mount this once at the app level (e.g. in App.tsx).
 */

export function useVectorAutoIndex() {
  useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];

    function indexSession(sessionId: string) {
      const session = useClaudeStore.getState().sessions[sessionId];
      if (!session) return;
      // Build a summary from the last few messages
      const msgs = session.messages || [];
      const summary = msgs
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-10)
        .map((m) => typeof m.content === "string" ? m.content : "")
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000);
      if (!summary) return;
      const cwd = session.cwd || "";
      vectorIndexSession(sessionId, summary, cwd).catch((err) => {
        console.warn("[vector-autoindex] Failed to index session:", sessionId, err);
      });
    }

    async function setup() {
      const unSessionEnd = await listen<HookEventPayload>(
        "claude-hook-SessionEnd",
        (event) => {
          if (cancelled) return;
          const { session_id } = event.payload;
          if (session_id) indexSession(session_id);
        },
      );
      if (cancelled) { unSessionEnd(); return; }
      unlisteners.push(unSessionEnd);

      const unClaudeDone = await listen<{ session_id: string }>(
        "claude-done",
        (event) => {
          if (cancelled) return;
          const { session_id } = event.payload;
          if (session_id) {
            setTimeout(() => indexSession(session_id), 1000);
          }
        },
      );
      if (cancelled) { unClaudeDone(); return; }
      unlisteners.push(unClaudeDone);
    }

    setup();

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);
}
