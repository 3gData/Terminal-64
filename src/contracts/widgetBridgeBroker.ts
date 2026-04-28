export const WIDGET_BRIDGE_REQUEST_EVENT = "widget-bridge-request" as const;
export const WIDGET_BRIDGE_TRANSPORT_NATIVE_WEBVIEW = "native-webview" as const;
export const WIDGET_BRIDGE_DEFAULT_TIMEOUT_MS = 15_000;
export const WIDGET_BRIDGE_MAX_TIMEOUT_MS = 60_000;

export type WidgetBridgeTransport = typeof WIDGET_BRIDGE_TRANSPORT_NATIVE_WEBVIEW;

export interface WidgetBridgeMessage {
  type: string;
  payload?: unknown;
}

export interface WidgetBridgeRequestEvent {
  widgetId: string;
  instanceId: string;
  requestId: string;
  transport: WidgetBridgeTransport;
  timeoutMs: number;
  message: WidgetBridgeMessage;
}

export interface WidgetBridgeError {
  code: string;
  message: string;
  details?: unknown;
}

export type WidgetBridgeResponse =
  | {
      ok: true;
      requestId?: string;
      result?: unknown;
    }
  | {
      ok: false;
      requestId?: string;
      error: WidgetBridgeError;
    };

export interface WidgetBridgeEventFrame {
  widgetId: string;
  instanceId: string;
  event: WidgetBridgeMessage;
}

export interface WidgetBridgeRespondRequest {
  widgetId: string;
  instanceId: string;
  requestId: string;
  response: WidgetBridgeResponse;
}

export interface WidgetBridgeEmitEventRequest {
  widgetId: string;
  instanceId: string;
  event: WidgetBridgeMessage;
}

export interface WidgetBridgeHostControls {
  emit: (event: WidgetBridgeMessage) => Promise<number>;
}

export type WidgetBridgeHostHandler = (
  request: WidgetBridgeRequestEvent,
  controls: WidgetBridgeHostControls,
) => Promise<WidgetBridgeResponse | void> | WidgetBridgeResponse | void;
