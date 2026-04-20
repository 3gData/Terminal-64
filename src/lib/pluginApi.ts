/**
 * Thin client for the widget server's plugin routes.
 *
 * Host callers and widget iframes both talk to the same endpoints:
 *   POST /widgets/{id}/plugin/invoke — request/response RPC
 *   GET  /widgets/{id}/plugin/stream — Server-Sent Events
 *
 * Errors surface as rejected promises with an `Error` whose message is the
 * server-provided `error` field when available.
 */

import { getWidgetServerPort } from "./tauriApi";

let cachedOrigin: Promise<string> | null = null;

function origin(): Promise<string> {
  if (!cachedOrigin) {
    cachedOrigin = getWidgetServerPort().then((port) => `http://127.0.0.1:${port}`);
  }
  return cachedOrigin;
}

export interface InvokeEnvelope {
  method: string;
  args?: unknown;
  requestId?: string;
}

export interface InvokeSuccess<T> {
  ok: true;
  requestId: string;
  result: T;
}

export interface InvokeFailure {
  ok: false;
  requestId: string;
  error: string;
  code?: string;
}

export type InvokeResponse<T> = InvokeSuccess<T> | InvokeFailure;

/**
 * Call a plugin method. Resolves with the `result` payload; rejects with the
 * plugin/bridge error message (never surfaces the raw HTTP envelope).
 */
export async function invokePlugin<T = unknown>(
  pluginId: string,
  method: string,
  args?: unknown
): Promise<T> {
  const base = await origin();
  const requestId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  const envelope: InvokeEnvelope = { method, requestId };
  if (args !== undefined) envelope.args = args;

  const res = await fetch(`${base}/widgets/${pluginId}/plugin/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });

  const body = (await res.json().catch(() => ({}))) as InvokeResponse<T>;
  if (!res.ok || !body.ok) {
    const msg =
      (body as InvokeFailure).error || `plugin invoke failed (${res.status})`;
    throw new Error(msg);
  }
  return body.result;
}

export interface PluginEvent<T = unknown> {
  type: string;
  topic?: string;
  payload?: T;
  [key: string]: unknown;
}

export interface PluginStreamHandle {
  close(): void;
}

/**
 * Subscribe to plugin-pushed events via SSE. Returns a handle whose `close()`
 * tears down the connection.
 *
 * `topic` filters to events whose frame has a matching `topic` field. Pass
 * `"*"` (or omit) to receive every frame.
 *
 * The callback receives the parsed JSON frame — plugins are expected to emit
 * one `{ type, topic?, payload? }` object per frame. Malformed frames are
 * dropped silently; `host.crash` frames are forwarded so callers can render
 * the PluginErrorCard.
 */
export function onPluginEvent<T = unknown>(
  pluginId: string,
  topic: string | "*",
  cb: (event: PluginEvent<T>) => void
): PluginStreamHandle {
  let closed = false;
  let source: EventSource | null = null;

  const wantAll = topic === "*" || topic === "";
  const want = wantAll ? null : topic;

  void origin().then((base) => {
    if (closed) return;
    const url = `${base}/widgets/${pluginId}/plugin/stream`;
    source = new EventSource(url);
    source.onmessage = (ev) => {
      if (!ev.data) return;
      let frame: PluginEvent<T>;
      try {
        frame = JSON.parse(ev.data) as PluginEvent<T>;
      } catch {
        return;
      }
      if (!want || frame.topic === want || frame.type === "host.crash") {
        try {
          cb(frame);
        } catch (err) {
          console.warn("[pluginApi] event callback threw", err);
        }
      }
    };
    // EventSource auto-reconnects on .onerror; we leave the default behavior
    // in place so a transient host restart doesn't require the caller to
    // re-subscribe.
  });

  return {
    close() {
      closed = true;
      source?.close();
      source = null;
    },
  };
}
