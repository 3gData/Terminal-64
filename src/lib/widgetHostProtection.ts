export type WidgetHostProtectionMode = "observe" | "auto-pause" | "auto-promote";
export type WidgetPreferredRenderMode = "native-webview";

export interface NoisyWidgetDefault {
  widgetId: string;
  label: string;
  preferredRenderMode: WidgetPreferredRenderMode;
  fallbackProtection: Extract<WidgetHostProtectionMode, "auto-pause">;
  reason: string;
}

export interface WidgetFrameDropCandidate {
  widgetId: string;
  activeInstanceCount: number;
  visibleFrameCount: number;
  bridgeInCount: number;
  bridgeOutCount: number;
  bridgeErrorCount: number;
  reloadCount: number;
  browserActive: boolean;
  subscriptionCount: number;
  bridgeInDelta?: number;
  bridgeOutDelta?: number;
  bridgeInRate?: number;
  bridgeOutRate?: number;
  knownNoisyReason?: string;
  preferredRenderMode?: WidgetPreferredRenderMode;
}

export interface WidgetHostProtectionDecision {
  mode: WidgetHostProtectionMode;
  action: "observed" | "paused" | "pause-skipped" | "promote-requested";
  widgetId: string;
  dropCount: number;
  threshold: number;
  windowMs: number;
  detail: string;
}

export const DEFAULT_WIDGET_HOST_PROTECTION_MODE: WidgetHostProtectionMode = "observe";
export const WIDGET_HOST_PROTECTION_DROP_THRESHOLD = 4;
export const WIDGET_HOST_PROTECTION_WINDOW_MS = 15_000;
export const WIDGET_HOST_PROTECTION_COOLDOWN_MS = 30_000;

export const NOISY_WIDGET_DEFAULTS: Record<string, NoisyWidgetDefault> = {
  "ro-sync": {
    widgetId: "ro-sync",
    label: "Rojo Sync",
    preferredRenderMode: "native-webview",
    fallbackProtection: "auto-pause",
    reason: "High-volume daemon WebSocket traffic can keep an iframe busy enough to drop host frames.",
  },
};

export function isWidgetHostProtectionMode(value: unknown): value is WidgetHostProtectionMode {
  return value === "observe" || value === "auto-pause" || value === "auto-promote";
}

export function getNoisyWidgetDefault(widgetId: string): NoisyWidgetDefault | null {
  return NOISY_WIDGET_DEFAULTS[widgetId] ?? null;
}

export function scoreWidgetFrameDropCandidate(candidate: WidgetFrameDropCandidate): number {
  const noisy = candidate.knownNoisyReason ? 40 : 0;
  const bridgeRate = (candidate.bridgeInRate ?? 0) + (candidate.bridgeOutRate ?? 0);
  const bridgeDelta = (candidate.bridgeInDelta ?? 0) + (candidate.bridgeOutDelta ?? 0);
  const browser = candidate.browserActive ? 8 : 0;
  const subscriptions = Math.min(candidate.subscriptionCount, 20);
  const reloads = Math.min(candidate.reloadCount * 2, 20);

  return (
    noisy +
    candidate.visibleFrameCount * 10 +
    candidate.activeInstanceCount * 3 +
    Math.min(bridgeRate / 5, 30) +
    Math.min(bridgeDelta / 10, 20) +
    browser +
    subscriptions +
    reloads +
    candidate.bridgeErrorCount * 4
  );
}

export function chooseWidgetProtectionTarget(candidates: WidgetFrameDropCandidate[]): WidgetFrameDropCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => scoreWidgetFrameDropCandidate(b) - scoreWidgetFrameDropCandidate(a))[0] ?? null;
}

export function summarizeWidgetFrameDropCandidates(candidates: WidgetFrameDropCandidate[]): string {
  if (candidates.length === 0) return "no visible widget iframes";
  return candidates
    .slice(0, 3)
    .map((candidate) => {
      const bridgeRate = candidate.bridgeInRate === undefined
        ? ""
        : `, bridge ${Math.round(candidate.bridgeInRate)}/${Math.round(candidate.bridgeOutRate ?? 0)}/s`;
      const noisy = candidate.preferredRenderMode ? `, prefers ${candidate.preferredRenderMode}` : "";
      return `${candidate.widgetId} (${candidate.visibleFrameCount} visible${bridgeRate}${noisy})`;
    })
    .join("; ");
}
