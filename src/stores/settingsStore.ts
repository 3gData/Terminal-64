import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { DEFAULT_WIDGET_HOST_PROTECTION_MODE, isWidgetHostProtectionMode, type WidgetHostProtectionMode } from "../lib/widgetHostProtection";

export interface QuickPaste {
  id: string;
  command: string;
  lastUsed: number;
}

export type WidgetRenderMode = "iframe" | "native-webview" | "auto";

export const WIDGET_RENDER_MODES: readonly WidgetRenderMode[] = ["iframe", "native-webview", "auto"];

export interface WidgetRenderModeResolution {
  requestedMode: WidgetRenderMode;
  effectiveMode: "iframe" | "native-webview";
  fallbackReason: string | null;
}

const WIDGET_NATIVE_WEBVIEW_READY: boolean = true;

export function normalizeWidgetRenderMode(value: unknown): WidgetRenderMode {
  return WIDGET_RENDER_MODES.includes(value as WidgetRenderMode)
    ? (value as WidgetRenderMode)
    : "iframe";
}

function normalizeWidgetRenderModesById(value: unknown): Record<string, WidgetRenderMode> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const modes: Record<string, WidgetRenderMode> = {};
  for (const [widgetId, mode] of Object.entries(value)) {
    const trimmedWidgetId = widgetId.trim();
    if (trimmedWidgetId) modes[trimmedWidgetId] = normalizeWidgetRenderMode(mode);
  }
  return modes;
}

export function resolveWidgetRenderMode(requestedMode: WidgetRenderMode): WidgetRenderModeResolution {
  if (requestedMode === "iframe") {
    return { requestedMode, effectiveMode: "iframe", fallbackReason: null };
  }

  if (!WIDGET_NATIVE_WEBVIEW_READY) {
    return {
      requestedMode,
      effectiveMode: "iframe",
      fallbackReason: requestedMode === "auto"
        ? "Auto promotion is not enabled yet"
        : "Native widget webview transport is not enabled yet",
    };
  }

  if (requestedMode === "auto") {
    return {
      requestedMode,
      effectiveMode: "iframe",
      fallbackReason: "Auto promotion has not promoted this widget",
    };
  }

  return { requestedMode, effectiveMode: "native-webview", fallbackReason: null };
}

interface Settings {
  claudeModel: string;
  claudeEffort: string;
  claudePermMode: string;
  claudeDefaultPermMode: string;
  claudeFont: string;
  theme: string;
  bgAlpha: number;
  snapToGrid: boolean;
  quickPastes: QuickPaste[];
  recentDirs: string[];
  discordBotToken: string;
  discordServerId: string;
  partyModeEnabled: boolean;
  partyEdgeGlow: boolean;
  partyEqualizer: boolean;
  partyBackgroundPulse: boolean;
  partyColorCycling: boolean;
  partyEqualizerDance: boolean;
  partyEqualizerRotation: boolean;
  partyIntensity: number;
  autoCompactEnabled: boolean;
  autoCompactThreshold: number; // 0-100, percentage of context window
  backgroundImage: string; // absolute file path or empty
  backgroundOpacity: number; // 0-1
  showGrid: boolean;
  openwolfEnabled: boolean;
  openwolfAutoInit: boolean;
  openwolfDaemon: boolean;
  openwolfDesignQC: boolean;
  widgetsPaused: boolean;
  pausedWidgetIds: string[];
  widgetRenderMode: WidgetRenderMode;
  widgetRenderModesById: Record<string, WidgetRenderMode>;
  widgetHostProtectionMode: WidgetHostProtectionMode;
}

const STORAGE_KEY = "terminal64-settings";

const defaultSettings: Settings = {
  claudeModel: "sonnet",
  claudeEffort: "high",
  claudePermMode: "",
  claudeDefaultPermMode: "",
  claudeFont: "system",
  theme: "Catppuccin Mocha",
  bgAlpha: 1,
  snapToGrid: false,
  quickPastes: [],
  recentDirs: [],
  discordBotToken: "",
  discordServerId: "",
  partyModeEnabled: false,
  partyEdgeGlow: true,
  partyEqualizer: false,
  partyBackgroundPulse: true,
  partyColorCycling: false,
  partyEqualizerDance: true,
  partyEqualizerRotation: true,
  partyIntensity: 0.7,
  autoCompactEnabled: false,
  autoCompactThreshold: 80,
  backgroundImage: "",
  backgroundOpacity: 0.15,
  showGrid: true,
  openwolfEnabled: false,
  openwolfAutoInit: true,
  openwolfDaemon: false,
  openwolfDesignQC: false,
  widgetsPaused: false,
  pausedWidgetIds: [],
  widgetRenderMode: "iframe",
  widgetRenderModesById: {},
  widgetHostProtectionMode: DEFAULT_WIDGET_HOST_PROTECTION_MODE,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        ...defaultSettings,
        ...parsed,
        pausedWidgetIds: Array.isArray(parsed.pausedWidgetIds)
          ? parsed.pausedWidgetIds.filter((id): id is string => typeof id === "string")
          : defaultSettings.pausedWidgetIds,
        widgetRenderMode: normalizeWidgetRenderMode(parsed.widgetRenderMode),
        widgetRenderModesById: normalizeWidgetRenderModesById(parsed.widgetRenderModesById),
        widgetHostProtectionMode: isWidgetHostProtectionMode(parsed.widgetHostProtectionMode)
          ? parsed.widgetHostProtectionMode
          : DEFAULT_WIDGET_HOST_PROTECTION_MODE,
      };
    }
  } catch (e) {
    console.warn("[settings] Failed to load settings:", e);
  }
  return defaultSettings;
}

function persist(state: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("[settings] Failed to persist settings:", e);
  }
}

interface SettingsState extends Settings {
  set: (partial: Partial<Settings>) => void;
  save: () => void;
  addQuickPaste: (command: string) => void;
  removeQuickPaste: (id: string) => void;
  touchQuickPaste: (id: string) => void;
  addRecentDir: (dir: string) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadSettings(),

  set: (partial) => {
    set(partial);
    persist({ ...get(), ...partial });
  },

  save: () => persist(get()),

  addQuickPaste: (command) => {
    const qp: QuickPaste = { id: uuidv4(), command, lastUsed: 0 };
    const updated = [...get().quickPastes, qp];
    set({ quickPastes: updated });
    persist({ ...get(), quickPastes: updated });
  },

  removeQuickPaste: (id) => {
    const updated = get().quickPastes.filter((q) => q.id !== id);
    set({ quickPastes: updated });
    persist({ ...get(), quickPastes: updated });
  },

  touchQuickPaste: (id) => {
    const updated = get().quickPastes.map((q) =>
      q.id === id ? { ...q, lastUsed: Date.now() } : q
    );
    set({ quickPastes: updated });
    persist({ ...get(), quickPastes: updated });
  },

  addRecentDir: (dir) => {
    const current = get().recentDirs.filter((d) => d !== dir);
    const updated = [dir, ...current].slice(0, 3);
    set({ recentDirs: updated });
    persist({ ...get(), recentDirs: updated });
  },
}));
