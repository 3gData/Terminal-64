import { useEffect, useRef } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  startPartyMode,
  stopPartyMode,
  onPartyModeSpectrum,
  SpectrumData,
} from "../lib/tauriApi";

// Module-level ref for components that need raw band data (e.g. equalizer)
// Updated at ~30fps by the spectrum listener — read via requestAnimationFrame
export const spectrumRef: { current: SpectrumData | null } = { current: null };

export function usePartyMode() {
  const enabled = useSettingsStore((s) => s.partyModeEnabled);
  const intensity = useSettingsStore((s) => s.partyIntensity);
  const colorCycling = useSettingsStore((s) => s.partyColorCycling);

  // Use refs so the spectrum callback reads live values without restarting the effect
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;
  const colorCyclingRef = useRef(colorCycling);
  colorCyclingRef.current = colorCycling;

  useEffect(() => {
    const root = document.documentElement.style;

    if (!enabled) {
      root.setProperty("--party-active", "0");
      root.removeProperty("--party-bass");
      root.removeProperty("--party-mid");
      root.removeProperty("--party-treble");
      root.removeProperty("--party-peak");
      root.removeProperty("--party-hue");
      spectrumRef.current = null;
      stopPartyMode().catch(() => {});
      return;
    }

    root.setProperty("--party-active", "1");
    startPartyMode().catch((err) => {
      console.warn("[party] Failed to start audio capture:", err);
    });

    // Mild curve for equalizer — keeps contrast but doesn't crush mid values
    const eqCurve = (v: number) => Math.min(Math.pow(v, 1.2) * 1.8, 1);
    // Softer curve for glow/CSS vars
    const glowCurve = (v: number) => Math.min(Math.pow(v, 1.3) * 1.5, 1);

    let hue = 220; // start at blue
    const unlistenPromise = onPartyModeSpectrum((data) => {
      // Equalizer band data — amplified so bars are lively at any volume
      spectrumRef.current = {
        bands: data.bands.map((b) => eqCurve(b)),
        bass: eqCurve(data.bass),
        mid: eqCurve(data.mid),
        treble: eqCurve(data.treble),
        peak: eqCurve(data.peak),
      };

      // Read live settings from refs — no effect restart needed
      const i = intensityRef.current;
      root.setProperty("--party-bass", String(glowCurve(data.bass) * i));
      root.setProperty("--party-mid", String(glowCurve(data.mid) * i));
      root.setProperty("--party-treble", String(glowCurve(data.treble) * i));
      root.setProperty("--party-peak", String(glowCurve(data.peak) * i));

      if (colorCyclingRef.current) {
        // Base rotation speed + beat-reactive boost
        hue = (hue + 1.5 + glowCurve(data.peak) * 8) % 360;
      }
      root.setProperty("--party-hue", String(hue));
    });

    return () => {
      unlistenPromise.then((fn) => fn());
      stopPartyMode().catch(() => {});
      spectrumRef.current = null;
      root.setProperty("--party-active", "0");
      root.removeProperty("--party-bass");
      root.removeProperty("--party-mid");
      root.removeProperty("--party-treble");
      root.removeProperty("--party-peak");
      root.removeProperty("--party-hue");
    };
  }, [enabled]); // Only restart capture when enabled/disabled — intensity/colorCycling read from refs
}
