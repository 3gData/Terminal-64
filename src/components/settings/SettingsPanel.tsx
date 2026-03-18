import { useThemeStore } from "../../stores/themeStore";
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
              onChange={(e) => setTheme(e.target.value)}
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
              onChange={(e) => setBgAlpha(Number(e.target.value) / 100)}
            />
          </div>
        </div>

        <div className="settings-shortcuts">
          <div className="settings-shortcuts-title">Keyboard Shortcuts</div>
          <div className="shortcut-grid">
            <div className="shortcut-row"><kbd>Ctrl+Shift+T</kbd><span>New Tab</span></div>
            <div className="shortcut-row"><kbd>Ctrl+Shift+W</kbd><span>Close Tab</span></div>
            <div className="shortcut-row"><kbd>Ctrl+Shift+D</kbd><span>Split Right</span></div>
            <div className="shortcut-row"><kbd>Ctrl+Shift+E</kbd><span>Split Down</span></div>
            <div className="shortcut-row"><kbd>Ctrl+Shift+G</kbd><span>2x2 Grid</span></div>
            <div className="shortcut-row"><kbd>Ctrl+Shift+P</kbd><span>Command Palette</span></div>
            <div className="shortcut-row"><kbd>Ctrl+Tab</kbd><span>Next Tab</span></div>
            <div className="shortcut-row"><kbd>Ctrl+C</kbd><span>Copy / Interrupt</span></div>
            <div className="shortcut-row"><kbd>Ctrl+V</kbd><span>Paste</span></div>
            <div className="shortcut-row"><kbd>Ctrl+A</kbd><span>Select All</span></div>
            <div className="shortcut-row"><kbd>Tab</kbd><span>Shell Autocomplete</span></div>
            <div className="shortcut-row"><kbd>Up/Down</kbd><span>Command History</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
