/**
 * DAC Ramp panel — single-axis DAC linearity check. Rendered inside its
 * own "DAC check" card (App.tsx), directly below the scan Controls
 * (Run-button) card. Default OFF. The slider switch IS the start/stop
 * control: flipping it on immediately starts the scan; flipping it off
 * (or the scan finishing) flips it back. There is no separate Run
 * button and this never touches ScanControls/useScanStream's raster
 * /vector Redux pipeline — see the module docstring in
 * useDacRampStream.ts for why that isolation is deliberate.
 *
 * Server-side: glasgow_service's /scan/dac_ramp/run (blocking) and
 * /scan/dac_ramp/stream (this panel) both build the same
 * RasterScanCommand — full resolution on the swept axis, the other
 * pinned to fixed_code — via DeviceService._build_dac_ramp_cmd, the
 * production port of upstream OBI's manual_dac_ctrl.RampControl.
 */
import { useEffect, useRef, useState } from "react";

import type { DacRampAxis } from "../types/api";
import { useDacRampStream } from "../hooks/useDacRampStream";
import { useTranslation } from "../i18n";
import { useAppSelector } from "../store";
import { NumberStepperField } from "./NumberStepperField";

export function DacRampPanel({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const { state, start, stop } = useDacRampStream();
  const adcValid = useAppSelector((s) => s.scan.vector.adc_valid);
  const [axis, setAxis] = useState<DacRampAxis>("x");
  const [fixedCode, setFixedCode] = useState(8192);
  const [dwell, setDwell] = useState(500);
  const active = state.phase === "connecting" || state.phase === "running";
  // The switch reflects "a DAC ramp scan is on" — checked while
  // active, and it snaps back to unchecked on its own once the scan
  // reaches done/error, since there's nothing left running to be "on".
  const switchOn = active;

  const handleToggle = (next: boolean) => {
    if (next) {
      start({ axis, fixedCode, dwell, adcValid });
    } else {
      stop();
    }
  };

  return (
    <div className="dac-ramp-body">
      <label className="checkbox vacuum-switch app-switch dac-ramp-switch">
        <input
          type="checkbox"
          checked={switchOn}
          disabled={disabled || state.phase === "connecting"}
          onChange={(event) => handleToggle(event.target.checked)}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        <span>{t("dacRamp.toggle")}</span>
      </label>
      <p className="dac-ramp-body__hint">{t("dacRamp.hint")}</p>

      <div className="dac-ramp-body__fields">
        <div className="field">
          <label htmlFor="dac-ramp-axis">{t("dacRamp.axis")}</label>
          <select
            id="dac-ramp-axis"
            className="select"
            value={axis}
            disabled={active || disabled}
            onChange={(event) => setAxis(event.target.value === "y" ? "y" : "x")}
          >
            <option value="x">{t("dacRamp.axis.x")}</option>
            <option value="y">{t("dacRamp.axis.y")}</option>
          </select>
        </div>
        <NumberStepperField
          label={t("dacRamp.fixedCode")}
          value={fixedCode}
          onValueChange={(next) => {
            const parsed = Number(next);
            if (Number.isFinite(parsed)) {
              setFixedCode(Math.max(0, Math.min(16383, Math.round(parsed))));
            }
          }}
          disabled={active || disabled}
          step={1}
          min={0}
          max={16383}
          inputMode="numeric"
          ariaLabel={t("dacRamp.fixedCode")}
        />
        <NumberStepperField
          label={t("dacRamp.dwell")}
          value={dwell}
          onValueChange={(next) => {
            const parsed = Number(next);
            if (Number.isFinite(parsed)) {
              setDwell(Math.max(0, Math.min(65535, Math.round(parsed))));
            }
          }}
          disabled={active || disabled}
          step={1}
          min={0}
          max={65535}
          inputMode="numeric"
          ariaLabel={t("dacRamp.dwell")}
        />
      </div>

      {(active || state.phase === "done" || state.phase === "error") && (
        <>
          <div className="dac-ramp-status" data-phase={state.phase}>
            <b>{t(PHASE_LABELS[state.phase])}</b>
            <span>{state.sampleCount.toLocaleString()} / 16384 {t("dacRamp.samples")}</span>
            {state.error && <span className="field-warning">{localizeDacRampError(state.error, t)}</span>}
          </div>
          <DacRampWaveformCanvas samples={state.samples} axis={state.axis} />
        </>
      )}
    </div>
  );
}

const PHASE_LABELS = {
  idle: "dacRamp.phase.idle",
  connecting: "dacRamp.phase.connecting",
  running: "dacRamp.phase.running",
  done: "dacRamp.phase.done",
  error: "dacRamp.phase.error",
} as const;

function localizeDacRampError(error: string, t: ReturnType<typeof useTranslation>["t"]): string {
  if (error.startsWith("dacRamp.")) return t(error as "dacRamp.error.generic");
  return error;
}

function DacRampWaveformCanvas({
  samples,
  axis,
}: {
  samples: Array<number | null>;
  axis: DacRampAxis;
}) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const render = () => drawWaveform(canvas, wrap, samples);
    render();
    const observer = new ResizeObserver(render);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [samples]);

  return (
    <div ref={wrapRef} className="dac-ramp-waveform">
      <canvas ref={canvasRef} aria-label={t("dacRamp.waveform")} />
      <div className="dac-ramp-waveform__summary">
        {t("dacRamp.axis")} {axis.toUpperCase()} · {t("dacRamp.waveformHint")}
      </div>
    </div>
  );
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  wrap: HTMLDivElement,
  samples: Array<number | null>,
) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, wrap.clientWidth);
  const height = Math.max(220, wrap.clientHeight - 24);
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
  const bottom = 10;
  const plotWidth = width - left - 10;
  const plotHeight = height - bottom - 10;

  // Gridlines at 0 / 4096 / 8192 / 12288 / 16383, matching OBI's
  // WaveformViewer (0..16384 y-range, midline at 8191).
  context.strokeStyle = "rgba(148, 163, 184, .3)";
  context.fillStyle = "#94a3b8";
  context.font = "11px sans-serif";
  for (let code = 0; code <= 16384; code += 4096) {
    const y = 10 + plotHeight - (Math.min(code, 16383) / 16383) * plotHeight;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(width - 10, y);
    context.stroke();
    context.fillText(String(code), 4, y + 4);
  }

  // The trace fills in progressively as chunks stream in, rather than
  // jumping from blank to complete.
  context.strokeStyle = "#22d3ee";
  context.lineWidth = 1.5;
  context.beginPath();
  let started = false;
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index];
    if (value === null) continue;
    const x = left + (index / (samples.length - 1)) * plotWidth;
    const y = 10 + plotHeight - (value / 16383) * plotHeight;
    if (!started) {
      context.moveTo(x, y);
      started = true;
    } else {
      context.lineTo(x, y);
    }
  }
  if (started) context.stroke();
}
