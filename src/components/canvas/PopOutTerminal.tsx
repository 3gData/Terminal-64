import { useState, useCallback, useEffect, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { useTheme } from "../../hooks/useTheme";
import { closeTerminal } from "../../lib/tauriApi";
import { BORDER_COLORS, ACTIVITY_TIMEOUT_MS } from "../../lib/constants";
import XTerminal from "../terminal/XTerminal";
import "./PopOutTerminal.css";

const appWindow = getCurrentWindow();
const params = new URLSearchParams(window.location.search);
const existingTerminalId = params.get("terminalId");
const initialBorderColor = params.get("borderColor") || "#89b4fa";
const titleParam = params.get("title") || "Terminal 64";

export default function PopOutTerminal() {
  const [terminalId] = useState(() => existingTerminalId || uuidv4());
  const [isMaximized, setIsMaximized] = useState(false);
  const [title, setTitle] = useState(titleParam);
  const [borderColor, setBorderColor] = useState(initialBorderColor);
  const [showColors, setShowColors] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const workTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useTheme();

  const handleActivity = useCallback(() => {
    setIsWorking(true);
    if (workTimer.current) clearTimeout(workTimer.current);
    workTimer.current = setTimeout(() => setIsWorking(false), ACTIVITY_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    return () => { if (workTimer.current) clearTimeout(workTimer.current); };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    appWindow.onCloseRequested(async (e) => {
      e.preventDefault();
      if (existingTerminalId) {
        await emit("terminal-pop-back", { terminalId: existingTerminalId, borderColor });
      } else {
        closeTerminal(terminalId).catch(() => {});
      }
      await appWindow.destroy();
    }).then((fn) => { unlistenFn = fn; });
    return () => { unlistenFn?.(); };
  }, [terminalId]);

  const handleMinimize = () => appWindow.minimize();
  const handleMaximize = async () => {
    await appWindow.toggleMaximize();
    setIsMaximized(await appWindow.isMaximized());
  };
  const handleClose = () => appWindow.close();

  return (
    <div
      className={`popout ${isWorking ? "popout--working" : ""}`}
      style={{ "--ft-border": borderColor } as React.CSSProperties}
    >
      <div className="popout-header" data-tauri-drag-region>
        <span className="popout-title" data-tauri-drag-region>{title}</span>
        <div className="popout-controls">
          <button
            className="popout-btn"
            onClick={() => setShowColors((v) => !v)}
            title="Border color"
          >
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: borderColor, border: "1px solid rgba(255,255,255,0.15)"
            }} />
          </button>
          <button className="popout-btn" onClick={handleMinimize}>
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button className="popout-btn" onClick={handleMaximize}>
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3V9H8V3H2ZM3 0H10V7H9V1H3V0Z" fill="currentColor" /></svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" strokeWidth="1" /></svg>
            )}
          </button>
          <button className="popout-btn popout-btn--close" onClick={handleClose}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>

      {showColors && (
        <div className="popout-colors">
          {BORDER_COLORS.map((c) => (
            <button
              key={c}
              className={`popout-swatch ${c === borderColor ? "popout-swatch--active" : ""}`}
              style={{ background: c }}
              onClick={() => { setBorderColor(c); setShowColors(false); }}
            />
          ))}
        </div>
      )}

      <div className="popout-body">
        <XTerminal
          terminalId={terminalId}
          isActive={true}
          onActivity={() => handleActivity()}
          onTitleChange={(_, t) => setTitle(t)}
          onExit={() => handleClose()}
        />
      </div>
    </div>
  );
}
