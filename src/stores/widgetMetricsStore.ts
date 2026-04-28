import { create } from "zustand";

type WidgetMetricEventKind =
  | "mount"
  | "unmount"
  | "reload"
  | "iframe-load"
  | "bridge"
  | "bridge-error"
  | "resource"
  | "browser"
  | "report";

export interface WidgetMetricEvent {
  at: number;
  kind: WidgetMetricEventKind;
  detail: string;
}

export interface WidgetDebugReport {
  at: number;
  payload: unknown;
}

export interface WidgetMetrics {
  instanceId: string;
  widgetId: string;
  mountedAt: number;
  lastSeenAt: number;
  unmountedAt: number | null;
  reloadCount: number;
  iframeLoadCount: number;
  bridgeInCount: number;
  bridgeOutCount: number;
  bridgeErrorCount: number;
  pluginSubscriptions: number;
  busSubscriptions: number;
  sessionEventSubscriptions: number;
  terminalWaiters: number;
  voiceSubscriptions: number;
  browserActive: boolean;
  browserId: string | null;
  lastModifiedAt: number | null;
  hostHeapUsedBytes: number | null;
  hostHeapTotalBytes: number | null;
  hostHeapLimitBytes: number | null;
  lastWidgetReport: WidgetDebugReport | null;
  recentEvents: WidgetMetricEvent[];
}

interface WidgetMetricsState {
  widgets: Record<string, WidgetMetrics>;
  registerWidget: (instanceId: string, widgetId: string) => void;
  unregisterWidget: (instanceId: string) => void;
  recordIframeLoad: (instanceId: string) => void;
  recordReload: (instanceId: string, modifiedAt: number | null) => void;
  recordBridgeTraffic: (instanceId: string, traffic: { inbound: number; outbound: number; errors: number }) => void;
  recordBridgeError: (instanceId: string, detail: string) => void;
  setResourceCounts: (instanceId: string, counts: { pluginSubscriptions: number; busSubscriptions: number; sessionEventSubscriptions: number; terminalWaiters: number; voiceSubscriptions: number }) => void;
  setBrowserState: (instanceId: string, active: boolean, browserId: string | null) => void;
  setLastModified: (instanceId: string, modifiedAt: number | null) => void;
  recordWidgetReport: (instanceId: string, payload: unknown) => void;
  clearWidgetMetrics: () => void;
  logWidgetMetricsSnapshot: () => void;
}

const MAX_EVENTS = 60;
const MAX_CLOSED_WIDGETS = 20;

function readHostHeap(): Pick<WidgetMetrics, "hostHeapUsedBytes" | "hostHeapTotalBytes" | "hostHeapLimitBytes"> {
  const perf = performance as Performance & {
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
      jsHeapSizeLimit?: number;
    };
  };
  const memory = perf.memory;
  return {
    hostHeapUsedBytes: typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null,
    hostHeapTotalBytes: typeof memory?.totalJSHeapSize === "number" ? memory.totalJSHeapSize : null,
    hostHeapLimitBytes: typeof memory?.jsHeapSizeLimit === "number" ? memory.jsHeapSizeLimit : null,
  };
}

function initialMetrics(instanceId: string, widgetId: string): WidgetMetrics {
  const now = Date.now();
  return {
    instanceId,
    widgetId,
    mountedAt: now,
    lastSeenAt: now,
    unmountedAt: null,
    reloadCount: 0,
    iframeLoadCount: 0,
    bridgeInCount: 0,
    bridgeOutCount: 0,
    bridgeErrorCount: 0,
    pluginSubscriptions: 0,
    busSubscriptions: 0,
    sessionEventSubscriptions: 0,
    terminalWaiters: 0,
    voiceSubscriptions: 0,
    browserActive: false,
    browserId: null,
    lastModifiedAt: null,
    ...readHostHeap(),
    lastWidgetReport: null,
    recentEvents: [{ at: now, kind: "mount", detail: "mounted" }],
  };
}

function appendEvent(metrics: WidgetMetrics, kind: WidgetMetricEventKind, detail: string): WidgetMetrics {
  const now = Date.now();
  return {
    ...metrics,
    ...readHostHeap(),
    lastSeenAt: now,
    recentEvents: [...metrics.recentEvents, { at: now, kind, detail }].slice(-MAX_EVENTS),
  };
}

function pruneMetricMap(widgets: Record<string, WidgetMetrics>): Record<string, WidgetMetrics> {
  const active: WidgetMetrics[] = [];
  const closed: WidgetMetrics[] = [];
  for (const metrics of Object.values(widgets)) {
    if (metrics.unmountedAt === null) active.push(metrics);
    else closed.push(metrics);
  }
  closed.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const kept = [...active, ...closed.slice(0, MAX_CLOSED_WIDGETS)];
  return Object.fromEntries(kept.map((metrics) => [metrics.instanceId, metrics]));
}

function updateWidget(
  set: (partial: Partial<WidgetMetricsState> | ((state: WidgetMetricsState) => Partial<WidgetMetricsState>)) => void,
  instanceId: string,
  updater: (metrics: WidgetMetrics) => WidgetMetrics,
) {
  set((state) => {
    const metrics = state.widgets[instanceId];
    if (!metrics) return {};
    return {
      widgets: {
        ...state.widgets,
        [instanceId]: updater(metrics),
      },
    };
  });
}

export const useWidgetMetricsStore = create<WidgetMetricsState>((set, get) => ({
  widgets: {},

  registerWidget: (instanceId, widgetId) => {
    set((state) => ({
      widgets: pruneMetricMap({
        ...state.widgets,
        [instanceId]: initialMetrics(instanceId, widgetId),
      }),
    }));
  },

  unregisterWidget: (instanceId) => {
    set((state) => {
      const metrics = state.widgets[instanceId];
      if (!metrics) return {};
      return {
        widgets: pruneMetricMap({
          ...state.widgets,
          [instanceId]: {
            ...appendEvent(metrics, "unmount", "unmounted"),
            unmountedAt: Date.now(),
            pluginSubscriptions: 0,
            busSubscriptions: 0,
            sessionEventSubscriptions: 0,
            terminalWaiters: 0,
            voiceSubscriptions: 0,
            browserActive: false,
            browserId: null,
          },
        }),
      };
    });
  },

  recordIframeLoad: (instanceId) => {
    updateWidget(set, instanceId, (metrics) => ({
      ...appendEvent(metrics, "iframe-load", "iframe loaded"),
      iframeLoadCount: metrics.iframeLoadCount + 1,
    }));
  },

  recordReload: (instanceId, modifiedAt) => {
    updateWidget(set, instanceId, (metrics) => ({
      ...appendEvent(metrics, "reload", "hot reload"),
      reloadCount: metrics.reloadCount + 1,
      lastModifiedAt: modifiedAt,
    }));
  },

  recordBridgeTraffic: (instanceId, traffic) => {
    if (traffic.inbound === 0 && traffic.outbound === 0 && traffic.errors === 0) return;
    updateWidget(set, instanceId, (metrics) => ({
      ...appendEvent(metrics, "bridge", `in ${traffic.inbound}, out ${traffic.outbound}, err ${traffic.errors}`),
      bridgeInCount: metrics.bridgeInCount + traffic.inbound,
      bridgeOutCount: metrics.bridgeOutCount + traffic.outbound,
      bridgeErrorCount: metrics.bridgeErrorCount + traffic.errors,
    }));
  },

  recordBridgeError: (instanceId, detail) => {
    updateWidget(set, instanceId, (metrics) => ({
      ...appendEvent(metrics, "bridge-error", detail.slice(0, 180)),
      bridgeErrorCount: metrics.bridgeErrorCount + 1,
    }));
  },

  setResourceCounts: (instanceId, counts) => {
    updateWidget(set, instanceId, (metrics) => ({
      ...appendEvent(metrics, "resource", `plugins ${counts.pluginSubscriptions}, bus ${counts.busSubscriptions}, session ${counts.sessionEventSubscriptions}, terminals ${counts.terminalWaiters}, voice ${counts.voiceSubscriptions}`),
      pluginSubscriptions: counts.pluginSubscriptions,
      busSubscriptions: counts.busSubscriptions,
      sessionEventSubscriptions: counts.sessionEventSubscriptions,
      terminalWaiters: counts.terminalWaiters,
      voiceSubscriptions: counts.voiceSubscriptions,
    }));
  },

  setBrowserState: (instanceId, active, browserId) => {
    updateWidget(set, instanceId, (metrics) => ({
      ...appendEvent(metrics, "browser", active ? `active ${browserId ?? ""}` : "inactive"),
      browserActive: active,
      browserId,
    }));
  },

  setLastModified: (instanceId, modifiedAt) => {
    updateWidget(set, instanceId, (metrics) => ({
      ...metrics,
      ...readHostHeap(),
      lastSeenAt: Date.now(),
      lastModifiedAt: modifiedAt,
    }));
  },

  recordWidgetReport: (instanceId, payload) => {
    updateWidget(set, instanceId, (metrics) => ({
      ...appendEvent(metrics, "report", "widget report"),
      lastWidgetReport: { at: Date.now(), payload },
    }));
  },

  clearWidgetMetrics: () => {
    set((state) => {
      const widgets: Record<string, WidgetMetrics> = {};
      for (const metrics of Object.values(state.widgets)) {
        if (metrics.unmountedAt === null) {
          widgets[metrics.instanceId] = initialMetrics(metrics.instanceId, metrics.widgetId);
        }
      }
      return { widgets };
    });
  },

  logWidgetMetricsSnapshot: () => {
    const rows = Object.values(get().widgets).map((metrics) => ({
      widgetId: metrics.widgetId,
      instanceId: metrics.instanceId,
      mountedSeconds: Math.round((Date.now() - metrics.mountedAt) / 1000),
      reloads: metrics.reloadCount,
      iframeLoads: metrics.iframeLoadCount,
      bridgeIn: metrics.bridgeInCount,
      bridgeOut: metrics.bridgeOutCount,
      bridgeErrors: metrics.bridgeErrorCount,
      pluginSubscriptions: metrics.pluginSubscriptions,
      busSubscriptions: metrics.busSubscriptions,
      sessionEventSubscriptions: metrics.sessionEventSubscriptions,
      terminalWaiters: metrics.terminalWaiters,
      voiceSubscriptions: metrics.voiceSubscriptions,
      browserActive: metrics.browserActive,
      hostHeapMB: metrics.hostHeapUsedBytes ? Math.round(metrics.hostHeapUsedBytes / 1024 / 1024) : null,
      widgetReported: metrics.lastWidgetReport?.payload ?? null,
    }));
    console.table(rows);
  },
}));
