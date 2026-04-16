/** Platform detection and cross-platform path helpers for the frontend.
 *
 *  `navigator.platform` is deprecated but still populated by every browser
 *  Tauri embeds. `userAgentData` is the modern replacement but not in Safari /
 *  WebKit (used on macOS). We check both, then fall back to `userAgent`. */

type UAData = { platform?: string };
const uaData: UAData | undefined = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
const platform = (uaData?.platform || navigator.platform || "").toLowerCase();
const ua = navigator.userAgent || "";

export const IS_WIN = platform.includes("win") || /windows/i.test(ua);
export const IS_MAC = platform.includes("mac") || /mac os x|macintosh/i.test(ua);

export const PATH_SEP: "\\" | "/" = IS_WIN ? "\\" : "/";

/** True if `p` is absolute on either Unix (`/…`) or Windows (`C:\…`, `C:/…`,
 *  `\\server\share`, `//server/share`). */
export function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/** Pick `\` if any segment already uses it, otherwise `/`. Falls back to the
 *  host OS separator when no segment has hints. */
function detectSeparator(parts: string[]): "\\" | "/" {
  for (const p of parts) {
    if (!p) continue;
    if (p.includes("\\") && !p.includes("/")) return "\\";
    if (p.includes("/") && !p.includes("\\")) return "/";
  }
  return PATH_SEP;
}

/** Join path segments using a separator that matches the input style. Trims
 *  redundant separators between segments but preserves leading ones (e.g.
 *  drive letters, UNC prefixes, leading `/`). */
export function joinPath(...parts: string[]): string {
  const sep = detectSeparator(parts);
  const rx = /[\\/]+$/;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let seg = parts[i];
    if (seg == null || seg === "") continue;
    if (i > 0) seg = seg.replace(/^[\\/]+/, "");
    if (i < parts.length - 1) seg = seg.replace(rx, "");
    if (seg) out.push(seg);
  }
  return out.join(sep);
}

/** Last segment of a path, splitting on either separator. */
export function baseName(p: string): string {
  if (!p) return "";
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** Directory portion of a path, trimmed of its trailing separator. */
export function dirName(p: string): string {
  if (!p) return "";
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return "";
  return trimmed.slice(0, idx).replace(/[\\/]+$/, "");
}
