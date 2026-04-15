import { shellExec } from "./tauriApi";

export const BORDER_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#eab308",
  "#ec4899", "#06b6d4", "#f97316", "#a855f7",
  "#14b8a6", "#6366f1", "#ffffff", "#6c7086",
];

export const DEFAULT_BORDER_COLOR = "#3b82f6";
export const DEFAULT_TERMINAL_WIDTH = 700;
export const DEFAULT_TERMINAL_HEIGHT = 450;
export const MIN_TERMINAL_WIDTH = 300;
export const MIN_TERMINAL_HEIGHT = 200;
export const AUTO_SAVE_INTERVAL_MS = 5000;
export const ACTIVITY_TIMEOUT_MS = 3000;
export const SNAP_THRESHOLD = 15;

/** Format seconds into a compact duration string (e.g. "5s", "2m 15s") */
export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** Format a timestamp (ms) as a relative time string (e.g. "just now", "5m ago", "3h ago") */
export function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Open a system folder in the platform file manager.
 *  Accepts paths with $HOME or %USERPROFILE% — they are expanded by the shell. */
export function openSystemFolder(folderPath: string): void {
  const isWin = navigator.platform.includes("Win");
  const resolved = isWin
    ? folderPath.replace("$HOME", "%USERPROFILE%").replace(/\//g, "\\")
    : folderPath;
  const cmd = isWin ? `explorer.exe "${resolved}"` : `open "${resolved}"`;
  shellExec(cmd).catch(() => {});
}
