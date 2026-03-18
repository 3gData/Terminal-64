import { useThemeStore } from "../../stores/themeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import "./SettingsPanel.css";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const themes = useThemeStore((s) => s.themes);
  const currentThemeName = useThemeStore((s) => s.currentThemeName);
  const setTheme = useThemeStore((s) => s.setTheme);
  const bgAlpha = useThemeStore((s) => s.bgAlpha);
  const setBgAlpha = useThemeStore((s) => s.setBgAlpha);

  const apiKey = useSettingsStore((s) => s.openaiApiKey);
  const model = useSettingsStore((s) => s.openaiModel);
  const setSetting = useSettingsStore((s) => s.set);

  if (!isOpen) return null;

  const opacityPercent = Math.round(bgAlpha * 100);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose}>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <label className="settings-label">Theme</label>
            <select
              className="settings-select"
              value={currentThemeName}
              onChange={(e) => {
                setTheme(e.target.value);
                setSetting({ theme: e.target.value });
              }}
            >
              {themes.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="settings-group">
            <label className="settings-label">
              Background Opacity
              <span className="settings-value">{opacityPercent}%</span>
            </label>
            <input
              type="range"
              className="settings-range"
              min={20}
              max={100}
              value={opacityPercent}
              onChange={(e) => {
                const a = Number(e.target.value) / 100;
                setBgAlpha(a);
                setSetting({ bgAlpha: a });
              }}
            />
          </div>

          <div className="settings-divider" />

          <div className="settings-group">
            <label className="settings-label">OpenAI API Key</label>
            <input
              type="password"
              className="settings-input"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setSetting({ openaiApiKey: e.target.value })}
            />
            <span className="settings-hint">For prompt rewriting in the text editor. Stored locally only.</span>
          </div>

          <div className="settings-group">
            <label className="settings-label">AI Model</label>
            <select
              className="settings-select"
              value={model}
              onChange={(e) => setSetting({ openaiModel: e.target.value })}
            >
              <option value="gpt-5.4-mini">gpt-5.4-mini (default, fast)</option>
              <option value="gpt-5.4">gpt-5.4 (frontier)</option>
              <option value="gpt-4o-mini">gpt-4o-mini (cheap)</option>
              <option value="gpt-4o">gpt-4o</option>
            </select>
          </div>
        </div>

        <div className="settings-shortcuts">
          <div className="settings-shortcuts-title">Keyboard Shortcuts</div>
          <div className="shortcut-grid">
            <div className="shortcut-row"><kbd>Ctrl+Shift+P</kbd><span>Command Palette</span></div>
            <div className="shortcut-row"><kbd>Ctrl+C</kbd><span>Copy / Interrupt</span></div>
            <div className="shortcut-row"><kbd>Ctrl+V</kbd><span>Paste</span></div>
            <div className="shortcut-row"><kbd>Ctrl+A</kbd><span>Select All</span></div>
            <div className="shortcut-row"><kbd>Ctrl+Scroll</kbd><span>Zoom Canvas</span></div>
            <div className="shortcut-row"><kbd>Double-click</kbd><span>New Terminal</span></div>
            <div className="shortcut-row"><kbd>Ctrl+Enter</kbd><span>Send (in editor)</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
