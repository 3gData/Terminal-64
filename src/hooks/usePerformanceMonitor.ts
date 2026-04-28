import { useEffect } from "react";
import { usePerformanceStore } from "../stores/performanceStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWidgetMetricsStore, type WidgetMetrics } from "../stores/widgetMetricsStore";
import {
  WIDGET_HOST_PROTECTION_COOLDOWN_MS,
  WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
  WIDGET_HOST_PROTECTION_WINDOW_MS,
  chooseWidgetProtectionTarget,
  getNoisyWidgetDefault,
  summarizeWidgetFrameDropCandidates,
  type WidgetFrameDropCandidate,
  type WidgetHostProtectionDecision,
} from "../lib/widgetHostProtection";

const TICK_MS = 250;
const FRAME_DROP_THRESHOLD_MS = 55;
const EVENT_LOOP_LAG_THRESHOLD_MS = 120;
const STORAGE_WRITE_THRESHOLD_MS = 20;

type SetItemWithMarker = Storage["setItem"] & { __t64PerfWrapped?: true };

interface WidgetMetricSample {
  at: number;
  bridgeInCount: number;
  bridgeOutCount: number;
}

interface WidgetDropWindow {
  firstAt: number;
  count: number;
  lastActionAt: number;
}

function storageAreaName(storage: Storage) {
  if (storage === window.localStorage) return "localStorage";
  if (storage === window.sessionStorage) return "sessionStorage";
  return "Storage";
}

function widgetIdFromIframe(iframe: HTMLIFrameElement) {
  const title = iframe.getAttribute("title");
  if (title?.startsWith("Widget: ")) return title.slice("Widget: ".length).trim();

  try {
    const url = new URL(iframe.src);
    const match = url.pathname.match(/\/widgets\/([^/]+)\//);
    return match ? decodeURIComponent(match[1] ?? "") : null;
  } catch {
    return null;
  }
}

function visibleWidgetFrames() {
  const counts = new Map<string, number>();
  for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>(".wdg-iframe"))) {
    const widgetId = widgetIdFromIframe(iframe);
    if (!widgetId) continue;
    const rect = iframe.getBoundingClientRect();
    const visible = rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    if (!visible) continue;
    counts.set(widgetId, (counts.get(widgetId) ?? 0) + 1);
  }
  return counts;
}

function sumMetrics(metrics: WidgetMetrics[]) {
  return metrics.reduce(
    (acc, metricsRow) => ({
      bridgeInCount: acc.bridgeInCount + metricsRow.bridgeInCount,
      bridgeOutCount: acc.bridgeOutCount + metricsRow.bridgeOutCount,
      bridgeErrorCount: acc.bridgeErrorCount + metricsRow.bridgeErrorCount,
      reloadCount: acc.reloadCount + metricsRow.reloadCount,
      browserActive: acc.browserActive || metricsRow.browserActive,
      subscriptionCount: acc.subscriptionCount +
        metricsRow.pluginSubscriptions +
        metricsRow.busSubscriptions +
        metricsRow.sessionEventSubscriptions +
        metricsRow.terminalWaiters +
        metricsRow.voiceSubscriptions,
    }),
    {
      bridgeInCount: 0,
      bridgeOutCount: 0,
      bridgeErrorCount: 0,
      reloadCount: 0,
      browserActive: false,
      subscriptionCount: 0,
    },
  );
}

function collectWidgetFrameDropCandidates(now: number, samples: Map<string, WidgetMetricSample>) {
  const frames = visibleWidgetFrames();
  if (frames.size === 0) return [];

  const activeMetrics = Object.values(useWidgetMetricsStore.getState().widgets)
    .filter((metrics) => metrics.unmountedAt === null);
  const metricsByWidget = new Map<string, WidgetMetrics[]>();
  for (const metrics of activeMetrics) {
    const group = metricsByWidget.get(metrics.widgetId) ?? [];
    group.push(metrics);
    metricsByWidget.set(metrics.widgetId, group);
  }

  const candidates: WidgetFrameDropCandidate[] = [];
  for (const [widgetId, visibleFrameCount] of frames) {
    const metricsRows = metricsByWidget.get(widgetId) ?? [];
    const totals = sumMetrics(metricsRows);
    const previous = samples.get(widgetId);
    const noisyDefault = getNoisyWidgetDefault(widgetId);
    const candidate: WidgetFrameDropCandidate = {
      widgetId,
      activeInstanceCount: metricsRows.length,
      visibleFrameCount,
      ...totals,
    };

    if (previous) {
      const seconds = Math.max((now - previous.at) / 1000, 0.001);
      const bridgeInDelta = Math.max(0, totals.bridgeInCount - previous.bridgeInCount);
      const bridgeOutDelta = Math.max(0, totals.bridgeOutCount - previous.bridgeOutCount);
      candidate.bridgeInDelta = bridgeInDelta;
      candidate.bridgeOutDelta = bridgeOutDelta;
      candidate.bridgeInRate = bridgeInDelta / seconds;
      candidate.bridgeOutRate = bridgeOutDelta / seconds;
    }

    if (noisyDefault) {
      candidate.knownNoisyReason = noisyDefault.reason;
      candidate.preferredRenderMode = noisyDefault.preferredRenderMode;
    }

    samples.set(widgetId, {
      at: now,
      bridgeInCount: totals.bridgeInCount,
      bridgeOutCount: totals.bridgeOutCount,
    });
    candidates.push(candidate);
  }

  return candidates;
}

function applyWidgetHostProtection(
  candidates: WidgetFrameDropCandidate[],
  windows: Map<string, WidgetDropWindow>,
  now: number,
): WidgetHostProtectionDecision | undefined {
  const target = chooseWidgetProtectionTarget(candidates);
  if (!target) return undefined;

  const existing = windows.get(target.widgetId);
  const dropWindow = existing && now - existing.firstAt <= WIDGET_HOST_PROTECTION_WINDOW_MS
    ? existing
    : { firstAt: now, count: 0, lastActionAt: existing?.lastActionAt ?? 0 };
  dropWindow.count += 1;
  windows.set(target.widgetId, dropWindow);

  if (dropWindow.count < WIDGET_HOST_PROTECTION_DROP_THRESHOLD) return undefined;

  const settings = useSettingsStore.getState();
  const mode = settings.widgetHostProtectionMode;
  const cooldownActive = now - dropWindow.lastActionAt < WIDGET_HOST_PROTECTION_COOLDOWN_MS;
  const thresholdDetail = `${target.widgetId} hit ${dropWindow.count}/${WIDGET_HOST_PROTECTION_DROP_THRESHOLD} frame drops in ${Math.round(WIDGET_HOST_PROTECTION_WINDOW_MS / 1000)}s`;

  if (mode === "observe") {
    return {
      mode,
      action: "observed",
      widgetId: target.widgetId,
      dropCount: dropWindow.count,
      threshold: WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
      windowMs: WIDGET_HOST_PROTECTION_WINDOW_MS,
      detail: `${thresholdDetail}; observe-only host protection`,
    };
  }

  if (cooldownActive) {
    return {
      mode,
      action: "pause-skipped",
      widgetId: target.widgetId,
      dropCount: dropWindow.count,
      threshold: WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
      windowMs: WIDGET_HOST_PROTECTION_WINDOW_MS,
      detail: `${thresholdDetail}; host protection action cooling down`,
    };
  }

  dropWindow.lastActionAt = now;
  dropWindow.firstAt = now;
  dropWindow.count = 0;

  if (mode === "auto-pause") {
    if (settings.widgetsPaused || settings.pausedWidgetIds.includes(target.widgetId)) {
      return {
        mode,
        action: "pause-skipped",
        widgetId: target.widgetId,
        dropCount: WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
        threshold: WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
        windowMs: WIDGET_HOST_PROTECTION_WINDOW_MS,
        detail: `${thresholdDetail}; widget already paused`,
      };
    }

    useSettingsStore.getState().set({
      pausedWidgetIds: [...settings.pausedWidgetIds, target.widgetId],
    });
    return {
      mode,
      action: "paused",
      widgetId: target.widgetId,
      dropCount: WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
      threshold: WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
      windowMs: WIDGET_HOST_PROTECTION_WINDOW_MS,
      detail: `${thresholdDetail}; auto-paused widget iframe`,
    };
  }

  useSettingsStore.getState().set({
    widgetRenderModesById: {
      ...settings.widgetRenderModesById,
      [target.widgetId]: "native-webview",
    },
  });
  return {
    mode,
    action: "promote-requested",
    widgetId: target.widgetId,
    dropCount: WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
    threshold: WIDGET_HOST_PROTECTION_DROP_THRESHOLD,
    windowMs: WIDGET_HOST_PROTECTION_WINDOW_MS,
    detail: `${thresholdDetail}; requested native-webview mode with iframe fallback until native transport is ready`,
  };
}

export function usePerformanceMonitor() {
  useEffect(() => {
    const store = usePerformanceStore.getState();
    const widgetSamples = new Map<string, WidgetMetricSample>();
    const widgetDropWindows = new Map<string, WidgetDropWindow>();
    let rafId = 0;
    let lastFrameAt = performance.now();
    let lastFrameDropReportAt = 0;
    const frameLoop = (now: number) => {
      const delta = now - lastFrameAt;
      lastFrameAt = now;
      if (
        document.visibilityState === "visible" &&
        delta > FRAME_DROP_THRESHOLD_MS &&
        now - lastFrameDropReportAt > 400
      ) {
        lastFrameDropReportAt = now;
        const at = performance.timeOrigin + now;
        const widgetCandidates = collectWidgetFrameDropCandidates(at, widgetSamples);
        const hostProtection = applyWidgetHostProtection(widgetCandidates, widgetDropWindows, at);
        store.recordEvent({
          kind: "frame-drop",
          durationMs: delta,
          detail: `requestAnimationFrame gap; ${summarizeWidgetFrameDropCandidates(widgetCandidates)}`,
          at,
          widgetCandidates,
          ...(hostProtection ? { hostProtection } : {}),
        });
        console.warn(`[perf] frame drop ${Math.round(delta)}ms`, { widgetCandidates, hostProtection });
      }
      rafId = requestAnimationFrame(frameLoop);
    };
    rafId = requestAnimationFrame(frameLoop);

    let expected = performance.now() + TICK_MS;
    const interval = window.setInterval(() => {
      const now = performance.now();
      const drift = now - expected;
      expected = now + TICK_MS;
      if (drift > EVENT_LOOP_LAG_THRESHOLD_MS) {
        store.recordEvent({
          kind: "event-loop-lag",
          durationMs: drift,
          detail: `timer drift over ${TICK_MS}ms heartbeat`,
        });
        console.warn(`[perf] event loop lag ${Math.round(drift)}ms`);
      }
    }, TICK_MS);

    let observer: PerformanceObserver | null = null;
    const supportsLongTask = PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false;
    if (supportsLongTask) {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          store.recordEvent({
            kind: "long-task",
            durationMs: entry.duration,
            detail: entry.name || "browser long task",
            at: performance.timeOrigin + entry.startTime,
          });
          console.warn(`[perf] long task ${Math.round(entry.duration)}ms`, entry.name || "");
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    }

    const originalSetItem = Storage.prototype.setItem;
    const existing = originalSetItem as SetItemWithMarker;
    if (!existing.__t64PerfWrapped) {
      const wrapped: SetItemWithMarker = function setItemWithPerfMarker(this: Storage, key: string, value: string) {
        const startedAt = performance.now();
        try {
          return originalSetItem.call(this, key, value);
        } finally {
          const elapsed = performance.now() - startedAt;
          if (elapsed > STORAGE_WRITE_THRESHOLD_MS) {
            const bytes = value.length * 2;
            const area = storageAreaName(this);
            store.recordEvent({
              kind: "storage-write",
              durationMs: elapsed,
              detail: `${area}.${key}`,
              bytes,
            });
            console.warn(`[perf] ${area}.setItem(${key}) took ${Math.round(elapsed)}ms for ${bytes} bytes`);
          }
        }
      };
      wrapped.__t64PerfWrapped = true;
      Storage.prototype.setItem = wrapped;
    }

    return () => {
      cancelAnimationFrame(rafId);
      clearInterval(interval);
      observer?.disconnect();
      if ((Storage.prototype.setItem as SetItemWithMarker).__t64PerfWrapped) {
        Storage.prototype.setItem = originalSetItem;
      }
    };
  }, []);
}
