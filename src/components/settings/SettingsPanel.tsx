import { useState, useEffect } from "react";
import { useThemeStore } from "../../stores/themeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { startDiscordBot, stopDiscordBot, discordBotStatus, partyModeStatus } from "../../lib/tauriApi";
import "./SettingsPanel.css";

import { FONT_OPTIONS, fontStack } from "../../lib/fonts";

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

  const quickPastes = useSettingsStore((s) => s.quickPastes);
  const setSetting = useSettingsStore((s) => s.set);
  const addQuickPaste = useSettingsStore((s) => s.addQuickPaste);
  const removeQuickPaste = useSettingsStore((s) => s.removeQuickPaste);
  const snapToGrid = useSettingsStore((s) => s.snapToGrid);

  const [newCommand, setNewCommand] = useState("");

  // Party Mode
  const partyEnabled = useSettingsStore((s) => s.partyModeEnabled);
  const partyEdgeGlow = useSettingsStore((s) => s.partyEdgeGlow);
  const partyEqualizer = useSettingsStore((s) => s.partyEqualizer);
  const partyBackgroundPulse = useSettingsStore((s) => s.partyBackgroundPulse);
  const partyColorCycling = useSettingsStore((s) => s.partyColorCycling);
  const partyEqualizerDance = useSettingsStore((s) => s.partyEqualizerDance);
  const partyEqualizerRotation = useSettingsStore((s) => s.partyEqualizerRotation);
  const partyIntensity = useSettingsStore((s) => s.partyIntensity);

  const discordToken = useSettingsStore((s) => s.discordBotToken);
  const discordServerId = useSettingsStore((s) => s.discordServerId);
  const [botConnected, setBotConnected] = useState(false);
  const [botLoading, setBotLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      discordBotStatus().then(setBotConnected).catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const opacityPercent = Math.round(bgAlpha * 100);

  const handleAddQuickPaste = () => {
    if (!newCommand.trim()) return;
    addQuickPaste(newCommand.trim());
    setNewCommand("");
  };

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
            <label className="settings-label">Claude Chat Font</label>
            <select
              className="settings-select"
              value={useSettingsStore.getState().claudeFont || "system"}
              onChange={(e) => {
                setSetting({ claudeFont: e.target.value });
                document.documentElement.style.setProperty("--claude-font", fontStack(e.target.value));
              }}
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
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

          <div className="settings-group">
            <label className="settings-label settings-label--row">
              <span>Snap to Grid</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={snapToGrid}
                onChange={(e) => setSetting({ snapToGrid: e.target.checked })}
              />
            </label>
            <span className="settings-hint">Snap windows to edges and sizes of nearby windows when dragging or resizing</span>
          </div>

          <div className="settings-divider" />

          {/* Quick Pastes */}
          <div className="settings-group">
            <label className="settings-label">Quick Pastes</label>
            <span className="settings-hint">Ctrl+Shift+P to open quick paste palette</span>

            {quickPastes.length > 0 && (
              <div className="qp-list">
                {quickPastes.map((qp) => (
                  <div key={qp.id} className="qp-item">
                    <div className="qp-item-info">
                        <span className="qp-item-cmd" style={{ fontSize: "11.5px", color: "var(--fg-secondary)" }}>{qp.command}</span>
                    </div>
                    <button
                      className="qp-item-delete"
                      onClick={() => removeQuickPaste(qp.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="qp-add">
              <input
                className="settings-input"
                placeholder="e.g. claude --dangerously-skip-permissions"
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddQuickPaste()}
              />
              <button
                className="qp-add-btn"
                onClick={handleAddQuickPaste}
                disabled={!newCommand.trim()}
              >
                + Add
              </button>
            </div>
          </div>

          <div className="settings-divider" />

          {/* Party Mode */}
          <div className="settings-group">
            <label className="settings-label">
              Party Mode
              <span className={`settings-dot ${partyEnabled ? "settings-dot--on" : ""}`} />
            </label>
            <span className="settings-hint">Capture system audio and visualize it across the UI.</span>
            <button
              className={`settings-discord-btn ${partyEnabled ? "settings-discord-btn--stop" : ""}`}
              onClick={() => setSetting({ partyModeEnabled: !partyEnabled })}
            >
              {partyEnabled ? "Disable" : "Enable"}
            </button>

            {partyEnabled && (
              <div className="party-sub-settings">
                <div className="settings-group" style={{ marginTop: 4 }}>
                  <label className="settings-label">
                    Intensity
                    <span className="settings-value">{Math.round(partyIntensity * 100)}%</span>
                  </label>
                  <input
                    type="range"
                    className="settings-range"
                    min={10}
                    max={100}
                    value={Math.round(partyIntensity * 100)}
                    onChange={(e) => setSetting({ partyIntensity: Number(e.target.value) / 100 })}
                  />
                </div>
                <label className="settings-checkbox">
                  <input type="checkbox" checked={partyEdgeGlow} onChange={(e) => setSetting({ partyEdgeGlow: e.target.checked })} />
                  Edge Glow
                </label>
                <label className="settings-checkbox">
                  <input type="checkbox" checked={partyEqualizer} onChange={(e) => setSetting({ partyEqualizer: e.target.checked })} />
                  Equalizer Bars
                </label>
                <label className="settings-checkbox">
                  <input type="checkbox" checked={partyBackgroundPulse} onChange={(e) => setSetting({ partyBackgroundPulse: e.target.checked })} />
                  Background Pulse
                </label>
                <label className="settings-checkbox">
                  <input type="checkbox" checked={partyColorCycling} onChange={(e) => setSetting({ partyColorCycling: e.target.checked })} />
                  Color Cycling
                </label>
                <label className="settings-checkbox">
                  <input type="checkbox" checked={partyEqualizerDance} onChange={(e) => setSetting({ partyEqualizerDance: e.target.checked })} />
                  Equalizer Dance
                </label>
                <label className="settings-checkbox">
                  <input type="checkbox" checked={partyEqualizerRotation} onChange={(e) => setSetting({ partyEqualizerRotation: e.target.checked })} />
                  Equalizer Rotation
                </label>
              </div>
            )}
          </div>

          <div className="settings-divider" />

          {/* Discord Bot */}
          <div className="settings-group">
            <label className="settings-label">
              Discord Bot
              <span className={`settings-dot ${botConnected ? "settings-dot--on" : ""}`} />
            </label>
            <input
              type="password"
              className="settings-input"
              placeholder="Bot token"
              value={discordToken}
              onChange={(e) => setSetting({ discordBotToken: e.target.value })}
            />
            <input
              className="settings-input"
              placeholder="Server ID"
              value={discordServerId}
              onChange={(e) => setSetting({ discordServerId: e.target.value })}
            />
            <span className="settings-hint">Named sessions get a Discord channel for remote interaction.</span>
            <button
              className={`settings-discord-btn ${botConnected ? "settings-discord-btn--stop" : ""}`}
              disabled={botLoading || (!botConnected && (!discordToken || !discordServerId))}
              onClick={async () => {
                setBotLoading(true);
                try {
                  if (botConnected) {
                    await stopDiscordBot();
                    setBotConnected(false);
                  } else {
                    await startDiscordBot(discordToken, discordServerId);
                    setBotConnected(true);
                  }
                } catch (err) {
                  alert(String(err));
                } finally {
                  setBotLoading(false);
                }
              }}
            >
              {botLoading ? "..." : botConnected ? "Disconnect" : "Connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
