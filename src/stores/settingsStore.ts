import { create } from "zustand";

export interface Settings {
  openaiApiKey: string;
  openaiModel: string;
  theme: string;
  bgAlpha: number;
}

const STORAGE_KEY = "terminal64-settings";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
  return defaultSettings;
}

const defaultSettings: Settings = {
  openaiApiKey: "",
  openaiModel: "gpt-5.4-mini",
  theme: "Catppuccin Mocha",
  bgAlpha: 1,
};

interface SettingsState extends Settings {
  set: (partial: Partial<Settings>) => void;
  save: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadSettings(),

  set: (partial) => {
    set(partial);
    // Auto-save on every change
    const state = { ...get(), ...partial };
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          openaiApiKey: state.openaiApiKey,
          openaiModel: state.openaiModel,
          theme: state.theme,
          bgAlpha: state.bgAlpha,
        })
      );
    } catch {}
  },

  save: () => {
    const s = get();
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          openaiApiKey: s.openaiApiKey,
          openaiModel: s.openaiModel,
          theme: s.theme,
          bgAlpha: s.bgAlpha,
        })
      );
    } catch {}
  },
}));
