import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeBrowser,
  closeWidgetWebview,
  createWidgetWebview,
  getWidgetServerPort,
  setBrowserBounds,
  setBrowserZoom,
  setWidgetWebviewBounds,
  setWidgetWebviewZoom,
  widgetFileModified,
  type WidgetWebviewBounds,
} from "../../lib/tauriApi";
import { useCanvasStore } from "../../stores/canvasStore";
import { resolveWidgetRenderMode, useSettingsStore } from "../../stores/settingsStore";
import { useWidgetMetricsStore } from "../../stores/widgetMetricsStore";
import { useWidgetBridgeHost, type WidgetBridgeTraffic } from "./useWidgetBridgeHost";
import { emitWidgetBridgeEvent, onWidgetBridgeRequest, respondWidgetBridgeRequest, widgetBridgeSuccess } from "../../lib/widgetBridgeBroker";
import "./Widget.css";

interface WidgetPanelProps {
  widgetId: string;
}

const POLL_INTERVAL = 1500;

function makeWidgetMetricsInstanceId(widgetId: string) {
  return `widget-${widgetId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function WidgetPanel({ widgetId }: WidgetPanelProps) {
  const widgetsPaused = useSettingsStore((s) => s.widgetsPaused);
  const widgetPaused = useSettingsStore((s) => s.pausedWidgetIds.includes(widgetId)) || widgetsPaused;
  const requestedRenderMode = useSettingsStore((s) => s.widgetRenderModesById[widgetId] ?? s.widgetRenderMode);
  const renderMode = resolveWidgetRenderMode(requestedRenderMode);
  const isNativeWidget = renderMode.effectiveMode === "native-webview";
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastModifiedRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const disposedRef = useRef(false);
  const reloadCounterRef = useRef(0);
  const metricsInstanceIdRef = useRef(makeWidgetMetricsInstanceId(widgetId));
  const nativeWidgetWebviewIdRef = useRef(makeWidgetMetricsInstanceId(widgetId));
  const bridgeTrafficRef = useRef<WidgetBridgeTraffic>({ inbound: 0, outbound: 0, errors: 0 });

  // Embedded browser state — native webview overlaid on the widget panel.
  const embeddedBrowserId = useRef<string | null>(null);
  const [browserActive, setBrowserActive] = useState(false);
  const browserRafRef = useRef<number>(0);
  const lastBoundsRef = useRef("");
  const lastZoomRef = useRef(0);
  const lastNativeZoomRef = useRef(0);

  const flushWidgetTraffic = useCallback((instanceId = metricsInstanceIdRef.current) => {
    const traffic = bridgeTrafficRef.current;
    if (traffic.inbound === 0 && traffic.outbound === 0 && traffic.errors === 0) return;
    bridgeTrafficRef.current = { inbound: 0, outbound: 0, errors: 0 };
    useWidgetMetricsStore.getState().recordBridgeTraffic(instanceId, traffic);
  }, []);

  useEffect(() => {
    const instanceId = makeWidgetMetricsInstanceId(widgetId);
    metricsInstanceIdRef.current = instanceId;
    bridgeTrafficRef.current = { inbound: 0, outbound: 0, errors: 0 };
    useWidgetMetricsStore.getState().registerWidget(instanceId, widgetId);

    const interval = setInterval(() => flushWidgetTraffic(instanceId), 1000);
    return () => {
      clearInterval(interval);
      flushWidgetTraffic(instanceId);
      useWidgetMetricsStore.getState().unregisterWidget(instanceId);
    };
  }, [flushWidgetTraffic, widgetId]);

  useEffect(() => {
    useWidgetMetricsStore.getState().setBrowserState(
      metricsInstanceIdRef.current,
      browserActive,
      embeddedBrowserId.current,
    );
  }, [browserActive]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWidgetUrl(null);
    lastModifiedRef.current = 0;
    reloadCounterRef.current = 0;

    getWidgetServerPort()
      .then((port) => {
        if (cancelled) return;
        setWidgetUrl(`http://127.0.0.1:${port}/widgets/${widgetId}/index.html`);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(`Widget server not available: ${err}`);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [widgetId]);

  // Sync embedded browser position and zoom to widget panel bounds.
  const syncBrowserBounds = useCallback(() => {
    if (!embeddedBrowserId.current || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const inset = 6;
    const bx = rect.x + inset;
    const by = rect.y;
    const bw = rect.width - inset * 2;
    const bh = rect.height - inset;
    const key = `${Math.round(bx)},${Math.round(by)},${Math.round(bw)},${Math.round(bh)}`;
    if (key !== lastBoundsRef.current) {
      lastBoundsRef.current = key;
      setBrowserBounds(embeddedBrowserId.current, bx, by, bw, bh).catch(() => {});
    }
    const canvasZoom = useCanvasStore.getState().zoom;
    if (canvasZoom !== lastZoomRef.current) {
      lastZoomRef.current = canvasZoom;
      setBrowserZoom(embeddedBrowserId.current, canvasZoom).catch(() => {});
    }
  }, []);

  const widgetWebviewBounds = useCallback((): WidgetWebviewBounds | null => {
    if (!panelRef.current) return null;
    const rect = panelRef.current.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  const syncNativeWidgetBounds = useCallback(() => {
    if (!isNativeWidget) return;
    const bounds = widgetWebviewBounds();
    if (!bounds) return;
    const key = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`;
    if (key !== lastBoundsRef.current) {
      lastBoundsRef.current = key;
      setWidgetWebviewBounds(nativeWidgetWebviewIdRef.current, bounds).catch(() => {});
    }
    const canvasZoom = useCanvasStore.getState().zoom;
    if (canvasZoom !== lastNativeZoomRef.current) {
      lastNativeZoomRef.current = canvasZoom;
      setWidgetWebviewZoom(nativeWidgetWebviewIdRef.current, canvasZoom).catch(() => {});
    }
  }, [isNativeWidget, widgetWebviewBounds]);

  const postToWidget = useCallback((msg: unknown) => {
    bridgeTrafficRef.current.outbound += 1;
    if (isNativeWidget) {
      if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
        return;
      }
      emitWidgetBridgeEvent({
        widgetId,
        instanceId: nativeWidgetWebviewIdRef.current,
        event: msg as { type: string; payload?: unknown },
      }).catch((err) => {
        useWidgetMetricsStore.getState().recordBridgeError(metricsInstanceIdRef.current, String(err));
      });
      return;
    }
    try {
      iframeRef.current?.contentWindow?.postMessage(msg, "*");
    } catch (err) {
      useWidgetMetricsStore.getState().recordBridgeError(metricsInstanceIdRef.current, String(err));
    }
  }, [isNativeWidget, widgetId]);

  const { handleRequest: handleBridgeRequest, sendInit: sendBridgeInit } = useWidgetBridgeHost({
    widgetId,
    enabled: Boolean(widgetUrl && !widgetPaused),
    lifecycleKey: widgetUrl,
    post: postToWidget,
    panelRef,
    embeddedBrowserIdRef: embeddedBrowserId,
    disposedRef,
    lastBoundsRef,
    metricsInstanceIdRef,
    bridgeTrafficRef,
    setBrowserActive,
    syncBrowserBounds,
  });

  useEffect(() => {
    if (!isNativeWidget || widgetPaused || !widgetUrl) return;
    let stopped = false;

    const create = () => {
      const bounds = widgetWebviewBounds();
      if (!bounds) {
        requestAnimationFrame(() => {
          if (!stopped) create();
        });
        return;
      }
      lastBoundsRef.current = `${Math.round(bounds.x)},${Math.round(bounds.y)},${Math.round(bounds.width)},${Math.round(bounds.height)}`;
      lastNativeZoomRef.current = 0;
      createWidgetWebview(nativeWidgetWebviewIdRef.current, widgetUrl, bounds)
        .then(() => {
          if (stopped) {
            closeWidgetWebview(nativeWidgetWebviewIdRef.current).catch(() => {});
            return;
          }
          syncNativeWidgetBounds();
          useWidgetMetricsStore.getState().recordIframeLoad(metricsInstanceIdRef.current);
        })
        .catch((err) => {
          useWidgetMetricsStore.getState().recordBridgeError(metricsInstanceIdRef.current, String(err));
        });
    };

    create();

    return () => {
      stopped = true;
      closeWidgetWebview(nativeWidgetWebviewIdRef.current).catch(() => {});
      lastBoundsRef.current = "";
      lastNativeZoomRef.current = 0;
    };
  }, [isNativeWidget, syncNativeWidgetBounds, widgetPaused, widgetUrl, widgetWebviewBounds]);

  useEffect(() => {
    if (!isNativeWidget || widgetPaused || !widgetUrl) return;
    const el = panelRef.current;
    if (!el) return;

    const scheduleSync = () => {
      if (browserRafRef.current) return;
      browserRafRef.current = requestAnimationFrame(() => {
        browserRafRef.current = 0;
        syncNativeWidgetBounds();
      });
    };

    scheduleSync();
    const unsubscribeCanvas = useCanvasStore.subscribe(scheduleSync);
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(el);
    window.addEventListener("resize", scheduleSync);

    return () => {
      unsubscribeCanvas();
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (browserRafRef.current) {
        cancelAnimationFrame(browserRafRef.current);
        browserRafRef.current = 0;
      }
    };
  }, [isNativeWidget, syncNativeWidgetBounds, widgetPaused, widgetUrl]);

  useEffect(() => {
    if (!isNativeWidget || widgetPaused || !widgetUrl) return;
    let unlisten: (() => void) | null = null;
    onWidgetBridgeRequest((request) => {
      if (request.widgetId !== widgetId || request.instanceId !== nativeWidgetWebviewIdRef.current) {
        return;
      }
      handleBridgeRequest(request.message);
      respondWidgetBridgeRequest({
        widgetId,
        instanceId: nativeWidgetWebviewIdRef.current,
        requestId: request.requestId,
        response: widgetBridgeSuccess(request.requestId),
      }).catch((err) => {
        useWidgetMetricsStore.getState().recordBridgeError(metricsInstanceIdRef.current, String(err));
      });
    })
      .then((fn) => { unlisten = fn; })
      .catch((err) => {
        useWidgetMetricsStore.getState().recordBridgeError(metricsInstanceIdRef.current, String(err));
      });

    return () => {
      unlisten?.();
    };
  }, [handleBridgeRequest, isNativeWidget, widgetId, widgetPaused, widgetUrl]);

  // Embedded browser bounds sync. Native webviews sit outside the DOM, so sync
  // on canvas/layout changes and coalesce bursts into one animation frame.
  useEffect(() => {
    if (!browserActive || widgetPaused) return;
    const el = panelRef.current;
    if (!el) return;

    const scheduleSync = () => {
      if (browserRafRef.current) return;
      browserRafRef.current = requestAnimationFrame(() => {
        browserRafRef.current = 0;
        syncBrowserBounds();
      });
    };

    scheduleSync();
    const unsubscribeCanvas = useCanvasStore.subscribe(scheduleSync);
    const observer = new ResizeObserver(scheduleSync);
    observer.observe(el);
    window.addEventListener("resize", scheduleSync);

    return () => {
      unsubscribeCanvas();
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (browserRafRef.current) {
        cancelAnimationFrame(browserRafRef.current);
        browserRafRef.current = 0;
      }
    };
  }, [browserActive, syncBrowserBounds, widgetPaused]);

  // Cleanup embedded browser on unmount.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (embeddedBrowserId.current) {
        closeBrowser(embeddedBrowserId.current).catch(() => {});
        embeddedBrowserId.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!widgetPaused || !embeddedBrowserId.current) return;
    closeBrowser(embeddedBrowserId.current).catch(() => {});
    embeddedBrowserId.current = null;
    lastBoundsRef.current = "";
    setBrowserActive(false);
    useWidgetMetricsStore.getState().setBrowserState(metricsInstanceIdRef.current, false, null);
  }, [widgetPaused]);

  useEffect(() => {
    if (!widgetPaused || !isNativeWidget) return;
    closeWidgetWebview(nativeWidgetWebviewIdRef.current).catch(() => {});
    lastBoundsRef.current = "";
    lastNativeZoomRef.current = 0;
  }, [isNativeWidget, widgetPaused]);

  // Poll for file changes (hot-reload any file in the widget dir).
  useEffect(() => {
    if (widgetPaused) return;
    let stopped = false;

    const poll = async () => {
      if (stopped || document.hidden || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const modified = await widgetFileModified(widgetId);
        if (stopped) return;
        if (modified > 0 && modified !== lastModifiedRef.current) {
          if (lastModifiedRef.current === 0) {
            lastModifiedRef.current = modified;
            useWidgetMetricsStore.getState().setLastModified(metricsInstanceIdRef.current, modified);
            return;
          }
          lastModifiedRef.current = modified;
          useWidgetMetricsStore.getState().recordReload(metricsInstanceIdRef.current, modified);
          reloadCounterRef.current += 1;
          setWidgetUrl((prev) => {
            if (!prev) return prev;
            const base = prev.split("?")[0];
            return `${base}?t=${reloadCounterRef.current}`;
          });
        }
      } catch (e) {
        console.warn("[widget] Poll for file changes failed:", e);
      } finally {
        pollInFlightRef.current = false;
      }
    };

    void poll();
    const interval = setInterval(() => { void poll(); }, POLL_INTERVAL);
    const onVisibilityChange = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [widgetId, widgetPaused]);

  // Iframe transport: keep postMessage compatibility while delegating bridge
  // command handling to the transport-neutral host hook.
  useEffect(() => {
    if (widgetPaused || !widgetUrl || isNativeWidget) return;
    const iframe = iframeRef.current;

    const onLoad = () => {
      useWidgetMetricsStore.getState().recordIframeLoad(metricsInstanceIdRef.current);
      sendBridgeInit();
    };

    iframe?.addEventListener("load", onLoad);

    if (iframe && iframe.contentDocument?.readyState === "complete") {
      onLoad();
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      handleBridgeRequest(event.data);
    };

    window.addEventListener("message", handleMessage);

    return () => {
      iframe?.removeEventListener("load", onLoad);
      window.removeEventListener("message", handleMessage);
    };
  }, [handleBridgeRequest, isNativeWidget, sendBridgeInit, widgetPaused, widgetUrl]);

  if (error) {
    return (
      <div className="wdg-panel wdg-panel--error">
        <span className="wdg-error-icon">!</span>
        <span className="wdg-error-text">{error}</span>
      </div>
    );
  }

  if (widgetPaused) {
    return (
      <div className="wdg-panel wdg-panel--loading">
        <span className="wdg-loading-text">Widgets paused</span>
        <span className="wdg-loading-sub">Settings {"->"} Widget Debug is unmounting widget iframes for performance isolation.</span>
      </div>
    );
  }

  if (loading || !widgetUrl) {
    return (
      <div className="wdg-panel wdg-panel--loading">
        <div className="wdg-spinner" />
        <span className="wdg-loading-text">Waiting for widget content...</span>
        <span className="wdg-loading-sub">Claude is building your widget in ~/.terminal64/widgets/{widgetId}/</span>
      </div>
    );
  }

  return (
    <div
      className="wdg-panel"
      ref={panelRef}
      data-widget-requested-render-mode={renderMode.requestedMode}
      data-widget-render-mode={renderMode.effectiveMode}
      title={renderMode.fallbackReason ?? undefined}
    >
      {isNativeWidget ? (
        <div className="wdg-native-surface" aria-label={`Widget: ${widgetId}`} />
      ) : (
        <iframe
          ref={iframeRef}
          className="wdg-iframe"
          src={widgetUrl}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
          allow="camera; microphone; geolocation; clipboard-read; clipboard-write"
          title={`Widget: ${widgetId}`}
        />
      )}
    </div>
  );
}
