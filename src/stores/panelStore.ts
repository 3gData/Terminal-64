import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { AUTO_SAVE_INTERVAL_MS } from "../lib/constants";

export type PanelContentType = "empty" | "custom" | "html";

export interface CustomPanel {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  isOpen: boolean;
  isMinimized: boolean;
  contentType: PanelContentType;
  content: string; // HTML content, URL, or empty
  borderColor: string;
}

interface PanelState {
  panels: CustomPanel[];
  nextZ: number;

  addPanel: (overrides?: Partial<CustomPanel>) => CustomPanel;
  removePanel: (id: string) => void;
  movePanel: (id: string, x: number, y: number) => void;
  resizePanel: (id: string, width: number, height: number) => void;
  bringToFront: (id: string) => void;
  toggleMinimize: (id: string) => void;
  closePanel: (id: string) => void;
  openPanel: (id: string) => void;
  setTitle: (id: string, title: string) => void;
  setContent: (id: string, contentType: PanelContentType, content: string) => void;
  setBorderColor: (id: string, color: string) => void;
  saveSession: () => void;
  loadSession: () => boolean;
}

const STORAGE_KEY = "terminal64-panels";
const DEFAULT_PANEL_WIDTH = 400;
const DEFAULT_PANEL_HEIGHT = 350;
const MIN_PANEL_WIDTH = 200;
const MIN_PANEL_HEIGHT = 150;
const DEFAULT_PANEL_BORDER = "#a855f7";

function makePanel(zIndex: number, overrides: Partial<CustomPanel> = {}): CustomPanel {
  return {
    id: uuidv4(),
    title: "Panel",
    x: 40,
    y: 80,
    width: DEFAULT_PANEL_WIDTH,
    height: DEFAULT_PANEL_HEIGHT,
    zIndex,
    isOpen: true,
    isMinimized: false,
    contentType: "empty",
    content: "",
    borderColor: DEFAULT_PANEL_BORDER,
    ...overrides,
  };
}

function getInitialState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const session = JSON.parse(raw);
      if (session.panels?.length) {
        const panels: CustomPanel[] = session.panels.map((p: any, i: number) => ({
          id: p.id || uuidv4(),
          title: p.title ?? "Panel",
          x: p.x ?? 40,
          y: p.y ?? 80,
          width: p.width ?? DEFAULT_PANEL_WIDTH,
          height: p.height ?? DEFAULT_PANEL_HEIGHT,
          zIndex: i + 1,
          isOpen: p.isOpen ?? true,
          isMinimized: p.isMinimized ?? false,
          contentType: p.contentType ?? "empty",
          content: p.content ?? "",
          borderColor: p.borderColor ?? DEFAULT_PANEL_BORDER,
        }));
        return { panels, nextZ: panels.length + 1 };
      }
    }
  } catch {}
  return { panels: [], nextZ: 1 };
}

let dirty = false;

export const usePanelStore = create<PanelState>((set, get) => {
  const initial = getInitialState();

  // Auto-save when dirty
  setInterval(() => {
    if (dirty) {
      try {
        usePanelStore.getState().saveSession();
        dirty = false;
      } catch {}
    }
  }, AUTO_SAVE_INTERVAL_MS);

  const markDirty = () => { dirty = true; };

  return {
    ...initial,

    addPanel: (overrides = {}) => {
      const state = get();
      const count = state.panels.length;
      const panel = makePanel(state.nextZ, {
        x: 40 + (count % 5) * 30,
        y: 80 + (count % 5) * 30,
        ...overrides,
      });
      set({
        panels: [...state.panels, panel],
        nextZ: state.nextZ + 1,
      });
      markDirty();
      return panel;
    },

    removePanel: (id) => {
      set((s) => ({ panels: s.panels.filter((p) => p.id !== id) }));
      markDirty();
    },

    movePanel: (id, x, y) => {
      set((s) => ({
        panels: s.panels.map((p) => (p.id === id ? { ...p, x, y } : p)),
      }));
      markDirty();
    },

    resizePanel: (id, width, height) => {
      set((s) => ({
        panels: s.panels.map((p) =>
          p.id === id
            ? {
                ...p,
                width: Math.max(MIN_PANEL_WIDTH, width),
                height: Math.max(MIN_PANEL_HEIGHT, height),
              }
            : p
        ),
      }));
      markDirty();
    },

    bringToFront: (id) => {
      const state = get();
      const panel = state.panels.find((p) => p.id === id);
      if (!panel || panel.zIndex === state.nextZ - 1) return;
      set({
        panels: state.panels.map((p) =>
          p.id === id ? { ...p, zIndex: state.nextZ } : p
        ),
        nextZ: state.nextZ + 1,
      });
    },

    toggleMinimize: (id) => {
      set((s) => ({
        panels: s.panels.map((p) =>
          p.id === id ? { ...p, isMinimized: !p.isMinimized } : p
        ),
      }));
      markDirty();
    },

    closePanel: (id) => {
      set((s) => ({
        panels: s.panels.map((p) =>
          p.id === id ? { ...p, isOpen: false } : p
        ),
      }));
      markDirty();
    },

    openPanel: (id) => {
      set((s) => ({
        panels: s.panels.map((p) =>
          p.id === id ? { ...p, isOpen: true, isMinimized: false } : p
        ),
      }));
      markDirty();
    },

    setTitle: (id, title) => {
      set((s) => ({
        panels: s.panels.map((p) => (p.id === id ? { ...p, title } : p)),
      }));
      markDirty();
    },

    setContent: (id, contentType, content) => {
      set((s) => ({
        panels: s.panels.map((p) =>
          p.id === id ? { ...p, contentType, content } : p
        ),
      }));
      markDirty();
    },

    setBorderColor: (id, color) => {
      set((s) => ({
        panels: s.panels.map((p) => (p.id === id ? { ...p, borderColor: color } : p)),
      }));
      markDirty();
    },

    saveSession: () => {
      const s = get();
      const session = {
        panels: s.panels.map((p) => ({
          id: p.id,
          title: p.title,
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          isOpen: p.isOpen,
          isMinimized: p.isMinimized,
          contentType: p.contentType,
          content: p.content,
          borderColor: p.borderColor,
        })),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } catch {}
    },

    loadSession: () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const session = JSON.parse(raw);
        if (!session.panels?.length) return false;
        const panels: CustomPanel[] = session.panels.map((p: any, i: number) => ({
          id: p.id || uuidv4(),
          title: p.title ?? "Panel",
          x: p.x ?? 40,
          y: p.y ?? 80,
          width: p.width ?? DEFAULT_PANEL_WIDTH,
          height: p.height ?? DEFAULT_PANEL_HEIGHT,
          zIndex: i + 1,
          isOpen: p.isOpen ?? true,
          isMinimized: p.isMinimized ?? false,
          contentType: p.contentType ?? "empty",
          content: p.content ?? "",
          borderColor: p.borderColor ?? DEFAULT_PANEL_BORDER,
        }));
        set({ panels, nextZ: panels.length + 1 });
        return true;
      } catch {
        return false;
      }
    },
  };
});
