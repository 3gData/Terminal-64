import { useEffect, useRef, useState } from "react";
import "./Widget.css";

interface PluginErrorCardProps {
  pluginId: string;
  message?: string;
  stderrTail?: string;
  onRestart: () => void | Promise<void>;
}

/**
 * Rendered in place of a plugin surface when the plugin subprocess crashes,
 * fails to start, or emits a `host.crash` frame. Styled on the existing
 * `wdg-panel--error` look so errors stay visually consistent with the rest
 * of the widget system.
 *
 * The Restart button is rate-limited to one click per 3s — we don't want a
 * stuck button triggering a spawn storm against a plugin that keeps crashing
 * on startup.
 */
export default function PluginErrorCard({
  pluginId,
  message,
  stderrTail,
  onRestart,
}: PluginErrorCardProps) {
  const [restarting, setRestarting] = useState(false);
  const lastClickRef = useRef(0);

  useEffect(() => {
    setRestarting(false);
  }, [pluginId]);

  const handleRestart = async () => {
    const now = Date.now();
    if (now - lastClickRef.current < 3000 || restarting) return;
    lastClickRef.current = now;
    setRestarting(true);
    try {
      await onRestart();
    } finally {
      // Leave the cooldown window in place even on success so a flapping
      // plugin can't burn cycles.
      setTimeout(() => setRestarting(false), 3000);
    }
  };

  return (
    <div className="wdg-panel wdg-panel--error wdg-plugin-error">
      <span className="wdg-error-icon">!</span>
      <span className="wdg-error-text">
        Plugin <code>{pluginId}</code> crashed
      </span>
      {message && <span className="wdg-plugin-error-detail">{message}</span>}
      {stderrTail && (
        <pre className="wdg-plugin-error-stderr" aria-label="stderr tail">
          {stderrTail}
        </pre>
      )}
      <button
        type="button"
        className="wdg-btn wdg-btn--create"
        onClick={handleRestart}
        disabled={restarting}
      >
        {restarting ? "Restarting..." : "Restart"}
      </button>
    </div>
  );
}
