import { create } from "zustand";
import type { WidgetFrameDropCandidate, WidgetHostProtectionDecision } from "../lib/widgetHostProtection";

export type PerformanceEventKind = "frame-drop" | "event-loop-lag" | "long-task" | "storage-write";

export interface PerformanceDebugEvent {
  id: string;
  at: number;
  kind: PerformanceEventKind;
  durationMs: number;
  detail: string;
  bytes?: number;
  widgetCandidates?: WidgetFrameDropCandidate[];
  hostProtection?: WidgetHostProtectionDecision;
  visibility: DocumentVisibilityState;
}

interface PerformanceStoreState {
  events: PerformanceDebugEvent[];
  recordEvent: (event: Omit<PerformanceDebugEvent, "id" | "at" | "visibility"> & { at?: number }) => void;
  clearEvents: () => void;
  logSnapshot: () => void;
}

const MAX_EVENTS = 80;

export const usePerformanceStore = create<PerformanceStoreState>((set, get) => ({
  events: [],

  recordEvent: (event) => {
    const at = event.at ?? Date.now();
    set((state) => ({
      events: [
        {
          ...event,
          id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
          at,
          durationMs: Math.round(event.durationMs),
          visibility: document.visibilityState,
        },
        ...state.events,
      ].slice(0, MAX_EVENTS),
    }));
  },

  clearEvents: () => set({ events: [] }),

  logSnapshot: () => {
    console.table(get().events.map((event) => ({
      at: new Date(event.at).toLocaleTimeString(),
      kind: event.kind,
      durationMs: event.durationMs,
      detail: event.detail,
      bytes: event.bytes ?? null,
      widgetCandidates: event.widgetCandidates?.map((candidate) => candidate.widgetId).join(", ") ?? null,
      hostProtection: event.hostProtection?.detail ?? null,
      visibility: event.visibility,
    })));
  },
}));
