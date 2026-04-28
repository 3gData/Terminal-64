import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  WIDGET_BRIDGE_REQUEST_EVENT,
  type WidgetBridgeEmitEventRequest,
  type WidgetBridgeError,
  type WidgetBridgeHostHandler,
  type WidgetBridgeMessage,
  type WidgetBridgeRequestEvent,
  type WidgetBridgeRespondRequest,
  type WidgetBridgeResponse,
} from "../contracts/widgetBridgeBroker";

export function onWidgetBridgeRequest(
  callback: (request: WidgetBridgeRequestEvent) => void,
): Promise<UnlistenFn> {
  return listen<WidgetBridgeRequestEvent>(WIDGET_BRIDGE_REQUEST_EVENT, (event) => {
    callback(event.payload);
  });
}

export async function respondWidgetBridgeRequest(req: WidgetBridgeRespondRequest): Promise<void> {
  await invoke("widget_bridge_respond", { req });
}

export async function emitWidgetBridgeEvent(req: WidgetBridgeEmitEventRequest): Promise<number> {
  return invoke<number>("widget_bridge_emit_event", { req });
}

export function widgetBridgeSuccess(requestId: string, result?: unknown): WidgetBridgeResponse {
  const response: WidgetBridgeResponse = { ok: true, requestId };
  if (result !== undefined) {
    response.result = result;
  }
  return response;
}

export function widgetBridgeError(
  requestId: string,
  code: string,
  message: string,
  details?: unknown,
): WidgetBridgeResponse {
  const error: WidgetBridgeError = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return { ok: false, requestId, error };
}

export async function registerWidgetBridgeHost(
  handler: WidgetBridgeHostHandler,
): Promise<UnlistenFn> {
  return onWidgetBridgeRequest((request) => {
    void handleWidgetBridgeRequest(request, handler);
  });
}

async function handleWidgetBridgeRequest(
  request: WidgetBridgeRequestEvent,
  handler: WidgetBridgeHostHandler,
): Promise<void> {
  const route = {
    widgetId: request.widgetId,
    instanceId: request.instanceId,
  };
  const emit = (event: WidgetBridgeMessage) => emitWidgetBridgeEvent({ ...route, event });

  try {
    const response = await handler(request, { emit });
    await respondWidgetBridgeRequest({
      ...route,
      requestId: request.requestId,
      response: response ?? widgetBridgeSuccess(request.requestId),
    });
  } catch (err) {
    await respondWidgetBridgeRequest({
      ...route,
      requestId: request.requestId,
      response: widgetBridgeError(request.requestId, "handler_error", String(err)),
    }).catch(() => {});
  }
}
