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
