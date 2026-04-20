import { create } from "zustand";

export type VoiceState = "idle" | "listening" | "dictating" | "awaitingCommand";

/** Which wake-word classifier to load. "jarvis" is the stock openWakeWord
 * "Hey Jarvis" model shipped out of the box. "t64" is a user-trained
 * "T Six Four" model — see `docs/wake-training.md`. */
export type WakeWord = "jarvis" | "t64";

export type VoiceIntentKind = "Send" | "Exit" | "Rewrite" | "Dictation" | "SelectSession";

export type CommandFlashKind = "Send" | "Exit" | "Rewrite";

export interface CommandFlash {
  kind: CommandFlashKind;
  at: number; // epoch ms; consumers key their 150 ms flash off this
}

export interface VoiceIntent {
  kind: VoiceIntentKind;
  payload?: string;
}

export interface VoiceModelsDownloaded {
  wake: boolean;
  command: boolean;
  dictation: boolean;
}

export interface ChatInputVoiceActions {
  /** Send current textarea. If `text` is provided, it overrides; otherwise the in-flight partial is rolled back and the committed base is sent. */
  send: (text?: string) => void;
  exit: () => void;
  /** Rewrite & auto-send. If `text` is provided it's used verbatim; otherwise the committed base (partial rolled back) is used. */
  rewrite: (text?: string) => void;
  setText: (text: string) => void;
  getText: () => string;
  /** Legacy single-string partial render (voice-partial event). Kept for
   * backwards compat; prefer `applyCommittedTentative`. */
  applyPartial: (partialText: string) => void;
  /**
   * LocalAgreement-2 two-span render. `committed` words are stable (never
   * retracted) and go into the textarea as plain text; `tentative` is the
   * un-agreed tail and renders as a dimmed sibling span. The backend emits
   * these as split `voice-committed` / `voice-tentative` events.
   */
  applyCommittedTentative: (committed: string, tentative: string) => void;
  /** Flatten the partial into the committed text and append the finalized utterance. */
  commitDictation: (finalText: string) => void;
}

interface PersistedVoice {
  enabled: boolean;
  modelsDownloaded: VoiceModelsDownloaded;
  wakeWord: WakeWord;
}

interface VoiceStoreState {
  enabled: boolean;
  state: VoiceState;
  lastIntent: VoiceIntent | null;
  partial: string;
  /** LocalAgreement-2 committed prefix (stable, never retracted for the
   * current utterance). Mirrors the backend `voice-committed` event. */
  committed: string;
  /** LocalAgreement-2 tentative tail (unstable, may change or disappear
   * on the next partial tick). Mirrors the backend `voice-tentative`. */
  tentative: string;
  error: string | null;
  modelsDownloaded: VoiceModelsDownloaded;
  wakeWord: WakeWord;
  activeSessionId: string | null;
  listeningProgress: number;

  // Agent-3 §4 — AwaitingCommand overlay. `commandMode` is driven independently
  // of `state` so the backend can still emit its own state-machine string while
  // the frontend owns the 4 s countdown UI. `commandDeadline` is an epoch-ms
  // timestamp; consumers subtract `Date.now()` each frame to render the ring.
  commandMode: boolean;
  commandDeadline: number | null;

  // Agent-3 §5 — "command heard" flash. Bump `commandFlash` on every fired
  // Send/Exit/Rewrite intent; UI reads the timestamp to retrigger the 150 ms
  // keyframe. Kept in the store (not per-component state) so it survives
  // session switches and is scoped to `activeSessionId` implicitly.
  commandFlash: CommandFlash | null;

  toggleEnabled: () => void;
  setEnabled: (enabled: boolean) => void;
  setState: (state: VoiceState) => void;
  setPartial: (partial: string) => void;
  setCommitted: (committed: string) => void;
  setTentative: (tentative: string) => void;
  /** Reset both split fields — called on utterance boundaries. */
  clearDictationSplit: () => void;
  setLastIntent: (intent: VoiceIntent | null) => void;
  setError: (error: string | null) => void;
  setModelsDownloaded: (patch: Partial<VoiceModelsDownloaded>) => void;
  setWakeWord: (w: WakeWord) => void;
  setActiveSessionId: (id: string | null) => void;
  setListeningProgress: (p: number) => void;

  enterCommandMode: (durationMs?: number) => void;
  exitCommandMode: () => void;
  triggerCommandFlash: (kind: CommandFlashKind) => void;
}

export const AWAITING_COMMAND_MS = 4000;

const STORAGE_KEY = "terminal64-voice";

const defaultPersisted: PersistedVoice = {
  enabled: false,
  modelsDownloaded: { wake: false, command: false, dictation: false },
  wakeWord: "jarvis",
};

function loadPersisted(): PersistedVoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        enabled: !!parsed.enabled,
        modelsDownloaded: {
          wake: !!parsed.modelsDownloaded?.wake,
          command: !!parsed.modelsDownloaded?.command,
          dictation: !!parsed.modelsDownloaded?.dictation,
        },
        wakeWord: parsed.wakeWord === "t64" ? "t64" : "jarvis",
      };
    }
  } catch (e) {
    console.warn("[voice] Failed to load persisted state:", e);
  }
  return defaultPersisted;
}

function persist(state: VoiceStoreState) {
  try {
    const data: PersistedVoice = {
      enabled: state.enabled,
      modelsDownloaded: state.modelsDownloaded,
      wakeWord: state.wakeWord,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("[voice] Failed to persist:", e);
  }
}

// Module-level registry for ChatInput actions keyed by sessionId.
// Kept outside Zustand to avoid re-renders on register/unregister.
const chatInputActions = new Map<string, ChatInputVoiceActions>();

export function registerChatInputVoiceActions(sessionId: string, actions: ChatInputVoiceActions): void {
  chatInputActions.set(sessionId, actions);
}

export function unregisterChatInputVoiceActions(sessionId: string): void {
  chatInputActions.delete(sessionId);
}

export function getChatInputVoiceActions(sessionId: string): ChatInputVoiceActions | undefined {
  return chatInputActions.get(sessionId);
}

export const useVoiceStore = create<VoiceStoreState>((set, get) => ({
  ...{
    state: "idle" as VoiceState,
    lastIntent: null,
    partial: "",
    committed: "",
    tentative: "",
    error: null,
    activeSessionId: null,
    listeningProgress: 0,
    commandMode: false,
    commandDeadline: null,
    commandFlash: null,
  },
  ...loadPersisted(),

  toggleEnabled: () => {
    const next = !get().enabled;
    set({ enabled: next });
    persist(get());
  },

  setEnabled: (enabled) => {
    set({ enabled });
    persist(get());
  },

  setState: (state) => {
    const patch: Partial<VoiceStoreState> = { state };
    // Reset progress whenever we leave the listening state so the bar doesn't
    // linger from the previous cycle.
    if (state !== "listening") patch.listeningProgress = 0;
    // Keep the overlay mode synced with the backend state machine when the
    // backend is the one driving it. Manual `enterCommandMode`/`exit` still
    // works for tests or intent-driven overlays.
    if (state === "awaitingCommand") {
      patch.commandMode = true;
      patch.commandDeadline = Date.now() + AWAITING_COMMAND_MS;
    } else if (get().commandMode && state !== "listening") {
      patch.commandMode = false;
      patch.commandDeadline = null;
    }
    set(patch as VoiceStoreState);
  },

  setListeningProgress: (p) => {
    const next = Math.max(0, Math.min(1, p));
    if (get().listeningProgress === next) return;
    set({ listeningProgress: next });
  },

  setPartial: (partial) => {
    if (get().partial === partial) return;
    set({ partial });
  },

  setCommitted: (committed) => {
    if (get().committed === committed) return;
    set({ committed });
  },

  setTentative: (tentative) => {
    if (get().tentative === tentative) return;
    set({ tentative });
  },

  clearDictationSplit: () => set({ committed: "", tentative: "", partial: "" }),

  setLastIntent: (lastIntent) => set({ lastIntent }),

  setError: (error) => set({ error }),

  setModelsDownloaded: (patch) => {
    set({ modelsDownloaded: { ...get().modelsDownloaded, ...patch } });
    persist(get());
  },

  setWakeWord: (wakeWord) => {
    set({ wakeWord });
    persist(get());
  },

  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),

  enterCommandMode: (durationMs = AWAITING_COMMAND_MS) => {
    set({ commandMode: true, commandDeadline: Date.now() + durationMs });
  },

  exitCommandMode: () => {
    set({ commandMode: false, commandDeadline: null });
  },

  triggerCommandFlash: (kind) => {
    set({ commandFlash: { kind, at: Date.now() } });
  },
}));
