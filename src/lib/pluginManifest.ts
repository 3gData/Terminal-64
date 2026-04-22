/**
 * Plugin manifest schema + validator. Kept in sync with the Rust
 * `PluginManifest` in `src-tauri/src/widget_server.rs`.
 *
 * The manifest lives at `~/.terminal64/widgets/{id}/widget.json` and declares
 * everything the host needs to load a plugin safely: kind, surfaces,
 * permissions (with human-readable reasons shown on the consent screen),
 * autostart, singleton, and optional RPC metadata.
 */

export type ManifestKind = "web" | "plugin" | "hybrid";

export type SurfaceType =
  | "panel"
  | "fullscreen"
  | "overlay"
  | "headless"
  | "settings-section";

export interface SurfaceDef {
  id: string;
  type: SurfaceType;
  entry?: string;
  title?: string;
}

/**
 * Canonical permission identifiers (mirrors the host capability names).
 * The frontend uses `PERMISSION_LABELS` to render human-readable titles on
 * the Review Permissions consent screen; unknown names fall back to the raw
 * permission string so plugins can declare host-extensions gracefully.
 */
export type PermissionName =
  | "host.emit"
  | "host.subscribe"
  | "host.invoke"
  | "host.state.get"
  | "host.state.set"
  | "host.secrets.get"
  | "host.secrets.set"
  | "host.audio.transcribe_file"
  | "host.log"
  | (string & {});

export interface PermissionEntry {
  name: PermissionName;
  /** Required — shown verbatim on the consent screen so users understand
   *  why the plugin is asking for this capability. */
  reason: string;
  /** Optional scope qualifiers (e.g. specific topic names for emit/subscribe). */
  scopes?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** Wire version; the host rejects plugins whose apiVersion is > host max. */
  apiVersion: number;
  kind: ManifestKind;
  surfaces: SurfaceDef[];
  permissions: PermissionEntry[];
  /** Free-form config surfaced to the plugin at launch. */
  config?: unknown;
  /** Free-form RPC metadata (declared methods, schemas). */
  rpc?: unknown;
  autostart?: boolean;
  singleton?: boolean;
}

export const HOST_MAX_API_VERSION = 1;

const SURFACE_TYPES: ReadonlySet<string> = new Set<SurfaceType>([
  "panel",
  "fullscreen",
  "overlay",
  "headless",
  "settings-section",
]);

/** Display labels for the consent screen. */
export const PERMISSION_LABELS: Record<string, string> = {
  "host.emit": "Publish events to other plugins",
  "host.subscribe": "Receive events from other plugins",
  "host.invoke": "Invoke host commands",
  "host.state.get": "Read persistent state",
  "host.state.set": "Write persistent state",
  "host.secrets.get": "Read secrets from OS keychain",
  "host.secrets.set": "Store secrets in OS keychain",
  "host.audio.transcribe_file": "Transcribe audio files via Whisper",
  "host.log": "Write to Terminal 64 logs",
};

export function labelForPermission(name: string): string {
  return PERMISSION_LABELS[name] ?? name;
}

export type ValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a parsed JSON blob against the manifest schema. Returns either the
 * typed manifest or a list of human-readable validation errors (collected
 * rather than fail-fast, so the user sees everything at once).
 */
export function validateManifest(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }

  const requireString = (key: string): string | undefined => {
    const v = raw[key];
    if (typeof v !== "string" || v.length === 0) {
      errors.push(`\`${key}\` must be a non-empty string`);
      return undefined;
    }
    return v;
  };

  const id = requireString("id");
  if (id && !ID_RE.test(id)) {
    errors.push("`id` may only contain A-Z, a-z, 0-9, `-`, `_`");
  }
  const name = requireString("name");
  const version = requireString("version");

  const apiVersionRaw = raw.apiVersion ?? 1;
  const apiVersion = typeof apiVersionRaw === "number" ? apiVersionRaw : NaN;
  if (!Number.isInteger(apiVersion) || apiVersion < 1) {
    errors.push("`apiVersion` must be a positive integer");
  } else if (apiVersion > HOST_MAX_API_VERSION) {
    errors.push(
      `\`apiVersion\` ${apiVersion} is newer than host supports (${HOST_MAX_API_VERSION})`
    );
  }

  const kindRaw = raw.kind;
  let kind: ManifestKind | undefined;
  if (kindRaw === "web" || kindRaw === "plugin" || kindRaw === "hybrid") {
    kind = kindRaw;
  } else {
    errors.push("`kind` must be one of: web, plugin, hybrid");
  }

  const surfaces: SurfaceDef[] = [];
  const surfacesRaw = raw.surfaces;
  if (surfacesRaw !== undefined) {
    if (!Array.isArray(surfacesRaw)) {
      errors.push("`surfaces` must be an array");
    } else {
      surfacesRaw.forEach((s, i) => {
        if (!isPlainObject(s)) {
          errors.push(`surfaces[${i}] must be an object`);
          return;
        }
        const sid = typeof s.id === "string" ? s.id : undefined;
        const stype = typeof s.type === "string" ? s.type : undefined;
        if (!sid) errors.push(`surfaces[${i}].id must be a string`);
        if (!stype || !SURFACE_TYPES.has(stype)) {
          errors.push(
            `surfaces[${i}].type must be one of: panel, fullscreen, overlay, headless, settings-section`
          );
        }
        if (sid && stype && SURFACE_TYPES.has(stype)) {
          const surf: SurfaceDef = { id: sid, type: stype as SurfaceType };
          if (typeof s.entry === "string") surf.entry = s.entry;
          if (typeof s.title === "string") surf.title = s.title;
          surfaces.push(surf);
        }
      });
    }
  }

  const permissions: PermissionEntry[] = [];
  const permsRaw = raw.permissions;
  if (permsRaw !== undefined) {
    if (!Array.isArray(permsRaw)) {
      errors.push("`permissions` must be an array");
    } else {
      permsRaw.forEach((p, i) => {
        if (!isPlainObject(p)) {
          errors.push(`permissions[${i}] must be an object`);
          return;
        }
        const pname = typeof p.name === "string" ? p.name : undefined;
        const reason = typeof p.reason === "string" ? p.reason : undefined;
        if (!pname) errors.push(`permissions[${i}].name must be a string`);
        if (!reason || reason.length === 0) {
          errors.push(
            `permissions[${i}].reason must be a non-empty string (shown to the user on consent)`
          );
        }
        if (pname && reason) {
          const entry: PermissionEntry = { name: pname, reason };
          if (Array.isArray(p.scopes)) {
            entry.scopes = p.scopes.filter((x): x is string => typeof x === "string");
          }
          permissions.push(entry);
        }
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const manifest: PluginManifest = {
    id: id!,
    name: name!,
    version: version!,
    apiVersion,
    kind: kind!,
    surfaces,
    permissions,
  };
  if (raw.config !== undefined) manifest.config = raw.config;
  if (raw.rpc !== undefined) manifest.rpc = raw.rpc;
  if (typeof raw.autostart === "boolean") manifest.autostart = raw.autostart;
  if (typeof raw.singleton === "boolean") manifest.singleton = raw.singleton;

  return { ok: true, manifest };
}

/**
 * Hash the raw manifest JSON text (UTF-8 bytes) with SHA-256, hex-encoded.
 * Matches the backend hash used in `.approved.json`.
 */
export async function hashManifestText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Shape written to `~/.terminal64/widgets/{id}/.approved.json` when the user
 * approves a permission set. `permissionNames` is stored sorted so set
 * comparisons are order-independent.
 */
export interface ApprovalRecord {
  manifestHash: string;
  approvedAt: string; // ISO timestamp
  /** Sorted canonical list. Used to detect widening vs. narrowing. */
  permissionNames: string[];
  apiVersion: number;
}

export function permissionNames(manifest: PluginManifest): string[] {
  return [...manifest.permissions.map((p) => p.name)].sort();
}

/**
 * Decide whether the new manifest needs a fresh consent prompt.
 *
 * - No prior approval → always consent.
 * - Same permission set (or a subset) → auto-approve silently.
 * - New permissions added → re-consent required.
 * - Hash changed but permissions identical → auto-approve (manifest bump only).
 */
export function requiresReconsent(
  manifest: PluginManifest,
  prior: ApprovalRecord | null
): boolean {
  if (!prior) return true;
  const current = permissionNames(manifest);
  const priorSet = new Set(prior.permissionNames);
  for (const name of current) {
    if (!priorSet.has(name)) return true; // widening
  }
  return false;
}
