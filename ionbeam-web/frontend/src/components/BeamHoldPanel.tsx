/**
 * Beam hold panel — the blank takeover check. Rendered in its own card
 * (App.tsx) under the scan controls for Raster and Vector.
 *
 * Reproduces the takeover of the scan Run would start (same frames, frame
 * time and Frame blank, from lib/takeoverTiming.ts) with the beam parked on
 * one DAC position, and records the detector signal. It takes over the scan
 * and blank relays exactly as that scan does (unless "Take control" is off)
 * and ends with its last frame, like the scan; there is no timer. With the
 * beam parked and our blanker in charge the trace should be flat; periodic
 * dark dips mean something outside our scan is interrupting the beam,
 * typically the instrument's own blanker still reaching the column.
 *
 * Runs exactly when a scan would use the hardware (IsProduction=true, or
 * simulation switched off; the service's rule). A simulated scan takes over
 * nothing, so then the card shows the calculated takeover and keeps the
 * switch disabled.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";

import type { BeamHoldBeam } from "../types/api";
import { useBeamHoldStream, type BeamHoldStreamState } from "../hooks/useBeamHoldStream";
import type { BeamHoldRecorder } from "../lib/beamHoldAnalysis";
import { formatDuration } from "../lib/scanTiming";
import { estimateTakeover } from "../lib/takeoverTiming";
import { useTranslation } from "../i18n";
import { useAppSelector } from "../store";
import { LoadingSpinner } from "./LoadingSpinner";
import { NumberStepperField } from "./NumberStepperField";
import {
  useScanTakeoverPlan,
  useScansUseHardware,
} from "./TakeoverEstimate";

type T = ReturnType<typeof useTranslation>["t"];

/** Sampling dwell of the recorded trace: ~1 us samples resolve 1 ms dips. */
const HOLD_SAMPLE_DWELL = 7;

export function BeamHoldPanel({
  disabled,
  kind,
}: {
  disabled: boolean;
  kind: "raster" | "vector";
}) {
  const { t, fmt } = useTranslation();
  const { state, start, stop, recorderRef } = useBeamHoldStream();
  const adcValid = useAppSelector((s) => s.scan.raster.adc_valid);
  const usesHardware = useScansUseHardware();
  const sessionSimulation = useAppSelector((s) => s.status.sessionSimulation);
  const plan = useScanTakeoverPlan(kind);
  const estimate = estimateTakeover(plan);
  const [beam, setBeam] = useState<BeamHoldBeam>("on");
  const [externalControl, setExternalControl] = useState(true);
  const [xCode, setXCode] = useState(8192);
  const [yCode, setYCode] = useState(8192);
  const active = state.phase === "connecting" || state.phase === "running";
  const locked = active || disabled;

  const clampInt = (raw: string, lo: number, hi: number, set: (v: number) => void) => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) set(Math.max(lo, Math.min(hi, Math.round(parsed))));
  };

  const onToggle = (on: boolean) => {
    if (!on) {
      stop();
      return;
    }
    start({
      xCode,
      yCode,
      beam,
      dwell: HOLD_SAMPLE_DWELL,
      match: {
        frame_pixels: estimate.framePixels,
        dwell: plan.dwell,
        frames: estimate.frames ?? 1,
        frame_blank: plan.frameBlank,
      },
      expectedSeconds: estimate.scanSeconds ?? estimate.frameSeconds,
      externalControl,
      adcValid,
      // The service applies the same hardware-or-simulation rule as a scan.
      simulation: sessionSimulation,
    });
  };

  return (
    <div className="beam-hold-body">
      <label className="checkbox vacuum-switch app-switch beam-hold-switch">
        <input
          type="checkbox"
          checked={active}
          disabled={disabled || !usesHardware || state.phase === "connecting"}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        <span>{t("beamHold.toggle")}</span>
        {active && <LoadingSpinner inline size={20} ariaLabel={t(PHASE_LABELS[state.phase])} />}
      </label>
      <p className="beam-hold-body__hint">{t("beamHold.hint")}</p>
      {!usesHardware && <p className="field-warning">{t("beamHold.productionOnly")}</p>}

      <div className="beam-hold-body__fields">
        <div className="field">
          <label htmlFor="beam-hold-beam">{t("beamHold.beam")}</label>
          <select
            id="beam-hold-beam"
            className="select"
            value={beam}
            disabled={locked}
            onChange={(event) => setBeam(event.target.value === "blanked" ? "blanked" : "on")}
          >
            <option value="on">{t("beamHold.beam.on")}</option>
            <option value="blanked">{t("beamHold.beam.blanked")}</option>
          </select>
        </div>
        <NumberStepperField
          label={t("beamHold.xCode")}
          value={xCode}
          onValueChange={(next) => clampInt(next, 0, 16383, setXCode)}
          disabled={locked}
          min={0}
          max={16383}
          inputMode="numeric"
          ariaLabel={t("beamHold.xCode")}
        />
        <NumberStepperField
          label={t("beamHold.yCode")}
          value={yCode}
          onValueChange={(next) => clampInt(next, 0, 16383, setYCode)}
          disabled={locked}
          min={0}
          max={16383}
          inputMode="numeric"
          ariaLabel={t("beamHold.yCode")}
        />
      </div>
      <label className="checkbox beam-hold-body__control">
        <input
          type="checkbox"
          checked={externalControl}
          disabled={locked}
          onChange={(event) => setExternalControl(event.target.checked)}
        />
        <span>{t("beamHold.externalControl")}</span>
      </label>
      {!externalControl && <p className="field-warning">{t("beamHold.observeOnly")}</p>}

      {state.phase !== "idle" && (
        <>
          <div className="dac-ramp-status beam-hold-status" data-phase={state.phase}>
            <b>{t(PHASE_LABELS[state.phase])}</b>
            <span>
              {formatDuration(state.elapsedMs / 1000)} / {formatDuration(state.durationS)}
              {" · "}{fmt(state.sampleCount)} {t("beamHold.samples")}
            </span>
            {state.mock && <span className="field-warning">{t("beamHold.mock")}</span>}
            {state.error && <span className="field-warning">{localizeError(state.error, t)}</span>}
          </div>
          <BeamHoldSummary state={state} />
          <BeamHoldTrace recorderRef={recorderRef} state={state} />
        </>
      )}
    </div>
  );
}

const PHASE_LABELS = {
  idle: "beamHold.phase.idle",
  connecting: "beamHold.phase.connecting",
  running: "beamHold.phase.running",
  done: "beamHold.phase.done",
  error: "beamHold.phase.error",
} as const;

function localizeError(error: string, t: T): string {
  if (error.startsWith("beamHold.")) return t(error as "beamHold.error.generic");
  return error;
}

function BeamHoldSummary({ state }: { state: BeamHoldStreamState }) {
  const { t, fmt } = useTranslation();
  const a = state.analysis;
  if (state.beam === "blanked") {
    return <p className="beam-hold-verdict">{t("beamHold.verdict.blanked")}</p>;
  }
  if (!a || a.verdict === "tooShort") {
    // A finished hold that is still too short: this scan's takeover is
    // shorter than the ~0.3 s the dip analysis needs.
    const finished = state.phase === "done" || state.phase === "error";
    return (
      <p className="beam-hold-verdict">
        {finished ? t("beamHold.verdict.tooShortDone") : t("beamHold.verdict.tooShort")}
      </p>
    );
  }
  const ms = (v: number | null) => (v == null ? "-" : fmt(v, { maximumFractionDigits: 1 }));
  return (
    <div className="beam-hold-verdict" data-verdict={a.verdict}>
      <b>
        {t("beamHold.dips", {
          count: a.dips.length,
          spacing: ms(a.medianSpacingMs),
          length: ms(a.medianLengthMs),
        })}
      </b>
      <p>
        {a.verdict === "periodic"
          ? t(state.externalControl ? "beamHold.verdict.periodic" : "beamHold.verdict.periodicObserve", {
            spacing: ms(a.medianSpacingMs),
          })
          : t(a.verdict === "clean" ? "beamHold.verdict.clean" : "beamHold.verdict.irregular")}
      </p>
    </div>
  );
}

function BeamHoldTrace({
  recorderRef,
  state,
}: {
  recorderRef: MutableRefObject<BeamHoldRecorder | null>;
  state: BeamHoldStreamState;
}) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const render = () => drawTrace(canvas, wrap, recorderRef.current, state);
    render();
    const observer = new ResizeObserver(render);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [recorderRef, state.revision, state.analysis, state.durationS]);

  return (
    <div ref={wrapRef} className="dac-ramp-waveform beam-hold-trace">
      <canvas ref={canvasRef} aria-label={t("beamHold.trace")} />
      <div className="dac-ramp-waveform__summary">{t("beamHold.traceHint")}</div>
    </div>
  );
}

/** Whole recording on a fixed time axis (0 .. duration): per pixel column,
 *  the lowest bucket (so a 1 ms dip survives compression) and the mean. */
function drawTrace(
  canvas: HTMLCanvasElement,
  wrap: HTMLDivElement,
  rec: BeamHoldRecorder | null,
  state: BeamHoldStreamState,
) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, wrap.clientWidth);
  const height = 200;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = "#050a14";
  ctx.fillRect(0, 0, width, height);

  const left = 48;
  const top = 14;
  const plotW = width - left - 10;
  const plotH = height - top - 22;
  const totalMs = Math.max(1, state.durationS * 1000);
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#94a3b8";
  ctx.strokeStyle = "rgba(148, 163, 184, .3)";
  for (let k = 0; k <= 4; k++) {
    const x = left + (k / 4) * plotW;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + plotH);
    ctx.stroke();
    const label = k === 0 ? "0" : formatDuration((totalMs / 1000) * k / 4);
    ctx.textAlign = k === 0 ? "left" : k === 4 ? "right" : "center";
    ctx.fillText(label, x, height - 6);
    ctx.textAlign = "left";
  }
  if (!rec || rec.length === 0) return;

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < rec.length; i++) {
    lo = Math.min(lo, rec.mins[i]);
    hi = Math.max(hi, rec.means[i]);
  }
  if (!(hi > lo)) { hi = lo + 1; }
  const pad = (hi - lo) * 0.08;
  lo = Math.max(0, lo - pad);
  hi = Math.min(16383, hi + pad);
  const yOf = (v: number) => top + plotH - ((v - lo) / (hi - lo)) * plotH;
  ctx.fillText(String(Math.round(hi)), 4, top + 8);
  ctx.fillText(String(Math.round(lo)), 4, top + plotH);

  const columns = Math.max(1, Math.round((rec.elapsedMs / totalMs) * plotW));
  const perColumn = rec.length / columns;
  ctx.strokeStyle = "rgba(34, 211, 238, .35)";
  ctx.beginPath();
  for (let c = 0; c < columns; c++) {
    const a = Math.floor(c * perColumn);
    const b = Math.max(a + 1, Math.floor((c + 1) * perColumn));
    let min = Infinity;
    let sum = 0;
    for (let i = a; i < b && i < rec.length; i++) {
      min = Math.min(min, rec.mins[i]);
      sum += rec.means[i];
    }
    const x = left + c + 0.5;
    ctx.moveTo(x, yOf(sum / (b - a)));
    ctx.lineTo(x, yOf(min));
  }
  ctx.stroke();

  ctx.strokeStyle = "#22d3ee";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let c = 0; c < columns; c++) {
    const a = Math.floor(c * perColumn);
    const b = Math.max(a + 1, Math.floor((c + 1) * perColumn));
    let sum = 0;
    for (let i = a; i < b && i < rec.length; i++) sum += rec.means[i];
    const x = left + c + 0.5;
    const y = yOf(sum / (b - a));
    if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  const analysis = state.analysis;
  if (analysis && analysis.verdict !== "tooShort" && state.beam === "on") {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(248, 113, 113, .6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, yOf(analysis.threshold));
    ctx.lineTo(left + plotW, yOf(analysis.threshold));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#f87171";
    for (const dip of analysis.dips) {
      const x = left + (dip.startMs / totalMs) * plotW;
      ctx.fillRect(x - 0.5, top - 10, 2, 7);
    }
  }
}
