import { useEffect, useRef, useState } from "react";

import type { AdcStreamState } from "../hooks/useAdcTestStream";
import { useAppSelector } from "../store";
import { useTranslation } from "../i18n";

interface ControlsProps {
  state: AdcStreamState;
  onStart: (request: {
    durationMinutes: 5 | 10 | 15 | 20;
    simulation: boolean;
    seed: number;
  }) => void;
  onStop: () => void;
}

export function AdcTestControls({ state, onStart, onStop }: ControlsProps) {
  const { t } = useTranslation();
  const defaults = useAppSelector((root) => root.status.defaults);
  const production = defaults?.is_production === true;
  const [durationMinutes, setDurationMinutes] = useState<5 | 10 | 15 | 20>(5);
  const [simulation, setSimulation] = useState(!production);
  const simulationTouchedRef = useRef(false);
  const [seed, setSeed] = useState(42);
  const active = state.phase === "connecting" || state.phase === "running";
  const remaining = Math.max(0, durationMinutes * 60 - state.elapsedSeconds);

  useEffect(() => {
    if (simulationTouchedRef.current || defaults?.is_production === undefined) return;
    setSimulation(defaults.is_production !== true);
  }, [defaults?.is_production]);

  return (
    <div className="adc-test-controls">
      <div className="field">
        <label htmlFor="adc-test-duration">{t("adc.duration")}</label>
        <select
          id="adc-test-duration"
          className="input"
          value={durationMinutes}
          disabled={active}
          onChange={(event) => setDurationMinutes(Number(event.target.value) as 5 | 10 | 15 | 20)}
        >
          {[5, 10, 15, 20].map((minutes) => (
            <option key={minutes} value={minutes}>{minutes} {t("adc.minutes")}</option>
          ))}
        </select>
      </div>
      <label className="checkbox vacuum-switch app-switch adc-mode-switch">
        <input
          type="checkbox"
          checked={simulation}
          disabled={active}
          onChange={(event) => {
            simulationTouchedRef.current = true;
            setSimulation(event.target.checked);
          }}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        <span>{t("adc.simulation")}</span>
      </label>
      {simulation && (
        <div className="field adc-test-seed">
          <div className="adc-test-seed__header">
            <label htmlFor="adc-test-seed">{t("adc.seed")}</label>
            <span className="adc-test-seed__hint">1–16383</span>
          </div>
          <div className="adc-test-seed__control">
            <span className="adc-test-seed__prefix" aria-hidden="true">#</span>
            <input
              id="adc-test-seed"
              className="adc-test-seed__input"
              type="number"
              min={1}
              max={16383}
              value={seed}
              disabled={active}
              onChange={(event) => setSeed(Math.max(1, Math.min(16383, Number(event.target.value))))}
            />
            <span className="adc-test-seed__unit" aria-hidden="true">U14</span>
          </div>
        </div>
      )}
      <div className="adc-test-settings">
        <span>{t("adc.halfPeriod")}</span><b>{String(defaults?.adc?.adcHalfPeriod ?? 3)} {t("adc.cycles")}</b>
        <span>{t("adc.settle")}</span><b>{String(defaults?.adc?.adcSettleCycles ?? 1)} {t("adc.cycles")}</b>
        <span>{t("settings.general.adcLatchCycles")}</span><b>{String(defaults?.adc?.adcLatchCycles ?? 1)} {t("adc.cycles")}</b>
        <span>{t("adc.dataDirection")}</span><b>{t("adc.inputOnly")}</b>
        <span>{t("adc.xyActivity")}</span><b>{t("adc.disabled")}</b>
      </div>
      {production && !simulation && <div className="adc-test-mode-note">{t("adc.productionRequired")}</div>}
      <button
        type="button"
        className={`btn ${active ? "btn--danger" : "btn--primary"}`}
        onClick={() => active
          ? onStop()
          : onStart({ durationMinutes, simulation, seed })}
      >
        {active ? t("adc.stop") : t("adc.run")}
      </button>
      <div className="adc-test-status" data-phase={state.phase}>
        <b>{t(PHASE_LABELS[state.phase])}</b>
        <span>{formatTime(state.elapsedSeconds)} {t("adc.elapsed")}</span>
        <span>{formatTime(remaining)} {t("adc.remaining")}</span>
        <span>{state.sampleCount.toLocaleString()} {t("adc.samples")}</span>
        {state.error && <span className="field-warning">{localizeAdcError(state.error, t)}</span>}
      </div>
    </div>
  );
}

const PHASE_LABELS = {
  idle: "adc.phase.idle",
  connecting: "adc.phase.connecting",
  running: "adc.phase.sampling",
  done: "adc.phase.complete",
  error: "adc.phase.error",
} as const;

function localizeAdcError(error: string, t: ReturnType<typeof useTranslation>["t"]): string {
  if (error.startsWith("adc.")) return t(error as "adc.error.timeout");
  return error;
}

export function AdcTimelineCanvas({ state }: { state: AdcStreamState }) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const render = () => drawTimeline(canvas, wrap, state);
    render();
    const observer = new ResizeObserver(render);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [state]);

  return (
    <div ref={wrapRef} className="adc-timeline">
      <canvas ref={canvasRef} aria-label={t("card.adcTimeline")} />
      <div className="adc-timeline__summary">
        {t("adc.minimum")} {state.minimum ?? "—"} · {t("adc.maximum")} {state.maximum ?? "—"} · {t("adc.grayMapping")}
      </div>
    </div>
  );
}

function drawTimeline(
  canvas: HTMLCanvasElement,
  wrap: HTMLDivElement,
  state: AdcStreamState,
) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, wrap.clientWidth);
  const height = Math.max(320, wrap.clientHeight - 32);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(ratio, ratio);
  context.fillStyle = "#050a14";
  context.fillRect(0, 0, width, height);
  const left = 44;
  const bottom = 28;
  const plotWidth = width - left - 10;
  const plotHeight = height - bottom - 10;
  context.strokeStyle = "rgba(148, 163, 184, .3)";
  context.fillStyle = "#94a3b8";
  context.font = "11px sans-serif";
  for (let gray = 0; gray <= 255; gray += 51) {
    const y = 10 + plotHeight - (gray / 255) * plotHeight;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(width - 10, y);
    context.stroke();
    context.fillText(String(gray), 8, y + 4);
  }
  state.bins.forEach((bin, index) => {
    if (!bin) return;
    const x = left + (index / state.bins.length) * plotWidth;
    // Keep this conversion identical to the image canvas: raw 14-bit ADC
    // values map linearly to the displayed 8-bit grayscale range.
    const gray = Math.round((Math.min(0x3fff, bin.latest) * 255) / 0x3fff);
    const barHeight = (gray / 255) * plotHeight;
    context.fillStyle = `rgb(${gray}, ${gray}, ${gray})`;
    context.fillRect(x, 10 + plotHeight - barHeight, Math.max(1, plotWidth / state.bins.length), barHeight);
  });
  context.fillStyle = "#94a3b8";
  context.fillText("0", left, height - 7);
  context.fillText(`${state.durationMinutes} min`, width - 46, height - 7);
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
