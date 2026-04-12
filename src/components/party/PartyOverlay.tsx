import { useEffect, useRef } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { spectrumRef } from "../../hooks/usePartyMode";
import "./PartyOverlay.css";

const ATTACK = 0.25;
const RELEASE = 0.08;
function smoothStep(current: number, target: number) {
  const factor = target > current ? ATTACK : RELEASE;
  return current + (target - current) * factor;
}

interface Spring {
  pos: number;
  vel: number;
}

function tickSpring(s: Spring, stiffness: number, damping: number) {
  s.vel += -stiffness * s.pos;
  s.vel *= damping;
  s.pos += s.vel;
}

const NUM_BARS = 48;

// Light neighbor smoothing — 1 pass, keeps frequency shape intact
function smoothBands(raw: number[]): number[] {
  const arr = raw.slice();
  for (let i = 1; i < arr.length - 1; i++) {
    arr[i] = raw[i] * 0.6 + raw[i - 1] * 0.2 + raw[i + 1] * 0.2;
  }
  return arr;
}

function Equalizer() {
  const barsRef = useRef<HTMLDivElement>(null);
  const dance = useSettingsStore((s) => s.partyEqualizerDance);
  const rotation = useSettingsStore((s) => s.partyEqualizerRotation);

  useEffect(() => {
    let raf: number;

    const heightSprings: Spring[] = Array.from({ length: NUM_BARS }, () => ({ pos: 0, vel: 0 }));
    const tiltSprings: Spring[] = Array.from({ length: NUM_BARS }, () => ({ pos: 0, vel: 0 }));

    // Peak caps
    const peakPos: number[] = new Array(NUM_BARS).fill(0);
    const peakVel: number[] = new Array(NUM_BARS).fill(0);
    const peakHold: number[] = new Array(NUM_BARS).fill(0);

    // Container dance
    const containerTilt: Spring = { pos: 0, vel: 0 };
    const containerScale: Spring = { pos: 0, vel: 0 };

    // Beat detection
    let prevBass = 0;
    let beatCooldown = 0;
    let beatFlash = 0;

    let frame = 0;

    const draw = () => {
      const data = spectrumRef.current;
      if (!data || !barsRef.current) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const container = barsRef.current;
      const bars = container.children;
      const len = Math.min(bars.length, data.bands.length);
      const hue = parseFloat(
        document.documentElement.style.getPropertyValue("--party-hue") || "0"
      );
      const bass = data.bass;

      frame++;

      // Light smoothing — keeps the frequency shape, just softens jaggedness
      const smoothed = smoothBands(data.bands);

      // Beat detection
      beatCooldown = Math.max(0, beatCooldown - 1);
      const isBeat = bass - prevBass > 0.1 && bass > 0.2 && beatCooldown === 0;
      if (isBeat) {
        beatCooldown = 6;
        beatFlash = 0.3 + bass * 0.4;
        containerScale.vel += 0.02 + bass * 0.04;
      }
      prevBass = bass;
      beatFlash *= 0.85;

      for (let i = 0; i < len; i++) {
        const el = bars[i] as HTMLElement;
        let target = smoothed[i] * 100;

        // Gentle idle breathing so bars are never fully flat
        const idle = Math.sin(frame * 0.025 + i * 0.2) * 1.2 + 1.5;
        target = Math.max(target, idle);

        // Height spring — snappy attack, smooth fall
        const hs = heightSprings[i];
        hs.vel += (target - hs.pos) * 0.35;
        hs.vel *= 0.7;
        hs.pos += hs.vel;
        const h = Math.max(1, hs.pos);

        // Gentle tilt: lean toward taller neighbor
        const leftVal = smoothed[Math.max(0, i - 1)];
        const rightVal = smoothed[Math.min(len - 1, i + 1)];
        const lean = (rightVal - leftVal) * 1.5;
        tiltSprings[i].vel += lean;
        tickSpring(tiltSprings[i], 0.2, 0.88);

        // Color
        const barHue = (hue + (i / len) * 120) % 360;
        const lightness = 42 + (h / 100) * 25;
        const flashMix = beatFlash * Math.max(0.3, smoothed[i]);
        const sat = (85 - flashMix * 40) | 0;
        const lit = lightness + flashMix * 20;
        const glowIntensity = Math.max(0, (h - 35) / 65) + flashMix * 0.4;

        // Batch all style writes into a single cssText assignment per element
        // (~2 DOM writes per bar instead of ~9)
        const transform = rotation ? `transform:rotate(${tiltSprings[i].pos.toFixed(1)}deg);` : "";
        const glow = glowIntensity > 0.05
          ? `box-shadow:0 0 ${(4 + glowIntensity * 14) | 0}px hsla(${barHue | 0},90%,60%,${Math.min(glowIntensity * 0.65, 0.85).toFixed(2)});`
          : "";
        el.style.cssText = `height:${h.toFixed(1)}%;${transform}background:linear-gradient(to top,hsl(${barHue | 0},${sat}%,${(lit * 0.55) | 0}%),hsl(${barHue | 0},${sat}%,${lit | 0}%));${glow}`;

        // Peak cap
        if (h > peakPos[i]) {
          peakPos[i] = h;
          peakVel[i] = 0;
          peakHold[i] = 15;
        } else if (peakHold[i] > 0) {
          peakHold[i]--;
        } else {
          peakVel[i] += 0.15;
          peakPos[i] -= peakVel[i];
          if (peakPos[i] < h) {
            peakPos[i] = h;
            peakVel[i] = 0;
          }
        }

        const cap = el.firstElementChild as HTMLElement | null;
        if (cap) {
          const capOffset = peakPos[i] - h;
          const capVis = peakPos[i] > 3;
          cap.style.cssText = `bottom:${capOffset.toFixed(1)}%;background:hsl(${barHue | 0},90%,80%);opacity:${capVis ? "0.9" : "0"};${capVis && peakPos[i] > 20 ? `box-shadow:0 0 4px hsla(${barHue | 0},90%,80%,0.6);` : ""}`;
        }
      }

      // Container dance — subtle tilt + scale only
      if (dance) {
        if (isBeat) {
          const dir = Math.random() > 0.5 ? 1 : -1;
          containerTilt.vel += dir * (0.4 + bass * 1.2);
        }
        tickSpring(containerTilt, 0.12, 0.9);
        tickSpring(containerScale, 0.2, 0.86);
        const s = 1 + containerScale.pos;
        container.style.transform = `rotate(${containerTilt.pos}deg) scale(${s})`;
      } else {
        container.style.transform = "";
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [dance, rotation]);

  return (
    <div ref={barsRef} className="party-eq">
      {Array.from({ length: NUM_BARS }, (_, i) => (
        <div key={i} className="party-eq-bar">
          <div className="party-eq-cap" />
        </div>
      ))}
    </div>
  );
}

function EdgeGlow() {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf: number;
    let sBass = 0;
    let sMid = 0;
    let sTreble = 0;
    let sHue = 220;

    const draw = () => {
      const el = overlayRef.current;
      if (el) {
        const root = document.documentElement.style;
        const bass = parseFloat(root.getPropertyValue("--party-bass") || "0");
        const mid = parseFloat(root.getPropertyValue("--party-mid") || "0");
        const treble = parseFloat(root.getPropertyValue("--party-treble") || "0");
        const hue = parseFloat(root.getPropertyValue("--party-hue") || "220");

        // Faster smoothing for glow: attack 0.3, release 0.12
        sBass += (bass - sBass) * (bass > sBass ? 0.3 : 0.12);
        sMid += (mid - sMid) * (mid > sMid ? 0.3 : 0.12);
        sTreble += (treble - sTreble) * (treble > sTreble ? 0.3 : 0.12);
        let hDiff = hue - sHue;
        if (hDiff > 180) hDiff -= 360;
        if (hDiff < -180) hDiff += 360;
        sHue = (sHue + hDiff * 0.1 + 360) % 360;

        const hBottom = sHue % 360;
        const hTop = (sHue + 80) % 360;
        const hLeft = (sHue + 40) % 360;
        const hRight = (sHue + 100) % 360;

        // Amplify values so glow is clearly visible
        const bAmp = Math.min(sBass * 2.5, 1);
        const mAmp = Math.min(sMid * 2.5, 1);
        const tAmp = Math.min(sTreble * 2.5, 1);

        const reach = 12 + bAmp * 25;

        const bottom = `radial-gradient(ellipse 100% ${reach}% at 50% 100%, hsla(${hBottom}, 90%, 55%, ${bAmp * 0.9}) 0%, transparent 100%)`;
        const top = `radial-gradient(ellipse 100% ${reach * 0.6}% at 50% 0%, hsla(${hTop}, 85%, 60%, ${tAmp * 0.75}) 0%, transparent 100%)`;
        const left = `radial-gradient(ellipse ${reach * 0.5}% 100% at 0% 50%, hsla(${hLeft}, 80%, 55%, ${mAmp * 0.65}) 0%, transparent 100%)`;
        const right = `radial-gradient(ellipse ${reach * 0.5}% 100% at 100% 50%, hsla(${hRight}, 80%, 55%, ${mAmp * 0.65}) 0%, transparent 100%)`;

        el.style.background = `${bottom}, ${top}, ${left}, ${right}`;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <div ref={overlayRef} className="party-overlay" />;
}

export function PartyEdgeGlow() {
  const enabled = useSettingsStore((s) => s.partyModeEnabled);
  const edgeGlow = useSettingsStore((s) => s.partyEdgeGlow);
  if (!enabled || !edgeGlow) return null;
  return <EdgeGlow />;
}

export function PartyEqualizer() {
  const enabled = useSettingsStore((s) => s.partyModeEnabled);
  const equalizer = useSettingsStore((s) => s.partyEqualizer);
  if (!enabled || !equalizer) return null;
  return <Equalizer />;
}
