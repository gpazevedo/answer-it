import React, { useState, useRef, useEffect } from "react";
import { C } from "./theme.js";

export const ScanLines = () => (
  <div style={{
    position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20,
    background: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.055) 3px, rgba(0,0,0,0.055) 4px)",
  }} />
);

export const Vignette = ({ style }) => (
  <div style={{
    position: "absolute", inset: 0, pointerEvents: "none",
    background: "radial-gradient(ellipse 110% 100% at 50% 45%, transparent 38%, rgba(4,3,2,0.65) 100%)",
    ...style,
  }} />
);

export function DeviceSelect({ label, value, onChange, options, maxWidth }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: C.textFaint, fontSize: 11, letterSpacing: 2, whiteSpace: "nowrap" }}>
        {label}
      </span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: "#111008", color: C.text,
          border: `1px solid ${C.divider}`,
          borderRadius: 5, padding: "4px 8px",
          fontSize: 11, cursor: "pointer",
          fontFamily: "'Courier Prime', monospace",
          maxWidth: maxWidth || 140,
          overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

/** Mic level bar driven by a ref — no React re-renders on level change. */
export function AudioLevelMeter({ barRef }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: "#22cc66", fontSize: 11 }}>MIC</span>
      <div style={{
        width: 100, height: 10, borderRadius: 5,
        background: "rgba(255,255,255,0.06)",
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.08)",
      }}>
        <div ref={barRef} style={{
          width: "0%",
          height: "100%", borderRadius: 5,
          background: "#22cc66",
          transition: "width 0.05s linear",
        }} />
      </div>
    </div>
  );
}

const WAVE_BARS = 24;

/** Scrolling 24-bar waveform — reads levelRef.current every 100ms, no React re-renders. */
export function WaveformGadget({ levelRef, label = "" }) {
  const [heights, setHeights] = useState(new Array(WAVE_BARS).fill(0));
  const histRef = useRef(new Array(WAVE_BARS).fill(0));
  const lastTickRef = useRef(0);
  const rafRef = useRef(null);

  useEffect(() => {
    const draw = (now) => {
      if (now - lastTickRef.current > 100) {
        lastTickRef.current = now;
        histRef.current.shift();
        histRef.current.push(Math.min(1, levelRef?.current ?? 0));
        setHeights([...histRef.current]);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [levelRef]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {label && <span style={{ color: "#22cc66", fontSize: 11, letterSpacing: 1 }}>{label}</span>}
      <div style={{ display: "flex", gap: 2, height: 28, alignItems: "center" }}>
        {heights.map((h, i) => (
          <div
            key={i}
            style={{
              width: 3,
              height: `${Math.max(2, h * 28)}px`,
              opacity: 0.25 + h * 0.75,
              background: "linear-gradient(to top, #22cc66, #88ffbb)",
              borderRadius: 2,
              transition: "height 0.09s ease, opacity 0.09s ease",
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function VolumeSlider({ value, onChange, label, minValue = 0, maxValue = 200 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: C.textFaint, fontSize: 10, letterSpacing: 1, minWidth: 30 }}>{label}</span>
      <input
        type="range"
        min={minValue}
        max={maxValue}
        value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        style={{
          width: 80, height: 6, cursor: "pointer",
          accentColor: "#22cc66",
        }}
      />
      <span style={{ color: C.textFaint, fontSize: 9, minWidth: 25 }}>{value}%</span>
    </div>
  );
}
