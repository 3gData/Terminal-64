import { useEffect, useState } from "react";
import { useVoiceStore, type VoiceState } from "../../stores/voiceStore";

export default function VoiceLivePanel() {
  const enabled = useVoiceStore((s) => s.enabled);
  const state = useVoiceStore((s) => s.state);
  const partial = useVoiceStore((s) => s.partial);
  const lastIntent = useVoiceStore((s) => s.lastIntent);
  const error = useVoiceStore((s) => s.error);
  const listeningProgress = useVoiceStore((s) => s.listeningProgress);

  // Show the last intent briefly after it fires, then fade.
  const [recentIntent, setRecentIntent] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  useEffect(() => {
    if (!lastIntent) return;
    const label = formatIntent(lastIntent.kind, lastIntent.payload);
    if (!label) return;
    setRecentIntent(label);
    if (lastIntent.kind === "SelectSession") setFlashKey((k) => k + 1);
    const t = window.setTimeout(() => setRecentIntent(null), 2400);
    return () => window.clearTimeout(t);
  }, [lastIntent]);

  if (!enabled) return null;

  // Priority: error > partial text > recent intent > state label.
  const { text, tone } = deriveDisplay({ state, partial, recentIntent, error });
  const isSelectFlash = recentIntent != null && lastIntent?.kind === "SelectSession";

  return (
    <div
      key={isSelectFlash ? `flash-${flashKey}` : "idle"}
      className={`vl-panel vl-panel--${tone}${isSelectFlash ? " vl-panel--flash" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className={`vl-state vl-state--${state}`}>
        {state === "listening" && <span className="vl-pulse" aria-hidden="true" />}
        {stateLabel(state)}
      </span>
      <span className="vl-sep" aria-hidden="true">·</span>
      <span className="vl-text" title={text}>{text}</span>
      {state === "listening" && (
        <div className="vl-progress" aria-hidden="true">
          <div
            className="vl-progress-fill"
            style={{ width: `${Math.round(listeningProgress * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function stateLabel(s: VoiceState) {
  if (s === "listening") return "LISTENING";
  if (s === "dictating") return "DICTATING";
  if (s === "awaitingCommand") return "COMMAND?";
  return "IDLE";
}

function formatIntent(kind: string, payload?: string): string | null {
  switch (kind) {
    case "Send":
      return "Sent";
    case "Exit":
      return "Cleared";
    case "Rewrite":
      return "Rewriting…";
    case "SelectSession":
      return payload ? `Selected ${payload}` : "Selected session";
    case "Dictation":
      return null;
    default:
      return null;
  }
}

/** Tail the last N words of a running partial so the status panel shows a
 *  short rolling glimpse ("…word1 word2 word3") instead of the whole
 *  sentence — keeps the badge compact and stops distracting the user while
 *  they're mid-sentence. */
function lastWords(text: string, n: number): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= n) return tokens.join(" ");
  return "…" + tokens.slice(-n).join(" ");
}

function deriveDisplay(args: {
  state: VoiceState;
  partial: string;
  recentIntent: string | null;
  error: string | null;
}): { text: string; tone: "neutral" | "error" | "active" } {
  const { state, partial, recentIntent, error } = args;
  if (error) return { text: error, tone: "error" };
  if (partial.trim() && state === "dictating") {
    return { text: lastWords(partial, 3), tone: "active" };
  }
  if (partial.trim()) return { text: partial, tone: "active" };
  if (recentIntent) return { text: recentIntent, tone: "active" };
  if (state === "listening") return { text: "Waiting for command…", tone: "neutral" };
  if (state === "dictating") return { text: "…", tone: "active" };
  return { text: "Say \"Hey Jarvis\"", tone: "neutral" };
}
