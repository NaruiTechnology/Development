import { useEffect, useRef, type ReactNode } from "react";

import { useTranslation } from "../i18n";
import { useAppDispatch, useAppSelector } from "../store";
import {
  addCurrentPoint,
  fetchMagCalibration,
  saveMagCalibration,
  setCurrentPath,
  setCurrentPoints,
  setMag,
  setMeasuredLengthM,
  setMeasuredPixels,
  setResolution,
  setSelectedBeam,
} from "../store/magCalibrationSlice";
import { Icon } from "./Icon";
import { MagCalibrationHelp } from "./MagCalibrationHelp";
import { NumberStepperInput } from "./NumberStepperField";

export function MagCalibrationControls({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const state = useAppSelector((s) => s.magCalibration);
  const beam = state.beams[state.selectedBeam] ?? { path: "", m_per_fov: {} };
  const computedFov =
    state.measuredPixels > 0 ? state.measuredLengthM * (state.resolution / state.measuredPixels) : 0;

  useEffect(() => {
    dispatch(fetchMagCalibration());
  }, [dispatch]);

  function save() {
    dispatch(
      saveMagCalibration({
        beam: state.selectedBeam,
        points: beam.m_per_fov,
        path: beam.path,
      })
    );
  }

  function importCsv(file: File) {
    file.text().then((text) => {
      dispatch(setCurrentPoints(parseMagCsv(text)));
      dispatch(setCurrentPath(file.name));
    });
  }

  function exportCsv() {
    const rows = [
      `Beam,${state.selectedBeam}`,
      `Date,${new Date().toISOString()}`,
      "Magnification,FOV (m)",
      ...Object.entries(beam.m_per_fov).map(([mag, fov]) => `${mag},${fov}`),
    ];
    const blob = new Blob([`${rows.join("\n")}\n`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `mag-calibration-${state.selectedBeam}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mag-calibration">
      <div className="field-row">
        <div className="field">
          <label>{t("mag.beam")}</label>
          <select
            className="select"
            value={state.selectedBeam}
            disabled={disabled || state.loading || state.saving}
            onChange={(event) => dispatch(setSelectedBeam(event.target.value))}
          >
            <option value="ion">{t("mag.beam.ion")}</option>
            <option value="ebeam">{t("mag.beam.ebeam")}</option>
          </select>
        </div>
        <NumberField
          label={
            <>
              {t("mag.magnification")}
              <MagCalibrationHelp />
            </>
          }
          value={state.mag}
          min={1}
          step={1}
          disabled={disabled}
          onChange={(value) => dispatch(setMag(value))}
        />
      </div>

      <div className="field-row">
        <NumberField
          label={t("mag.measuredLengthM")}
          value={state.measuredLengthM}
          min={Number.MIN_VALUE}
          step="any"
          disabled={disabled}
          onChange={(value) => dispatch(setMeasuredLengthM(value))}
        />
        <NumberField
          label={t("mag.measuredPixels")}
          value={state.measuredPixels}
          min={Number.MIN_VALUE}
          step="any"
          disabled={disabled}
          onChange={(value) => dispatch(setMeasuredPixels(value))}
        />
      </div>

      <div className="field-row">
        <NumberField
          label={t("mag.imageResolution")}
          value={state.resolution}
          min={1}
          step={1}
          disabled={disabled}
          onChange={(value) => dispatch(setResolution(value))}
        />
        <div className="field">
          <label>
            {t("mag.hfovLengthM")}
            <MagCalibrationHelp />
          </label>
          <input className="input" value={formatScientific(computedFov)} readOnly />
        </div>
      </div>

      <div className="button-row">
        <button
          className="btn btn--primary"
          disabled={disabled || computedFov <= 0}
          onClick={() => dispatch(addCurrentPoint())}
        >
          <Icon name="plus" />
          {t("mag.updateCurve")}
        </button>
        <button className="btn btn--ghost" disabled={disabled || state.saving} onClick={save}>
          <Icon name="save" />
          {t("mag.save")}
        </button>
      </div>

      <div className="button-row">
        <button className="btn btn--ghost" disabled={disabled} onClick={exportCsv}>
          <Icon name="download" />
          {t("mag.exportCsv")}
        </button>
        <button className="btn btn--ghost" disabled={disabled} onClick={() => fileRef.current?.click()}>
          <Icon name="upload" />
          {t("mag.importCsv")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importCsv(file);
            event.currentTarget.value = "";
          }}
        />
      </div>

      {beam.path && <div className="muted mag-calibration__path">{beam.path}</div>}
      {state.error && <div className="field-warning">{state.error}</div>}
      <MagCalibrationTable disabled={disabled} />
    </div>
  );
}

export function MagCalibrationChart() {
  const { t } = useTranslation();
  const state = useAppSelector((s) => s.magCalibration);
  const beam = state.beams[state.selectedBeam] ?? { path: "", m_per_fov: {} };
  const points = Object.entries(beam.m_per_fov)
    .map(([mag, fov]) => ({ mag: Number(mag), fov }))
    .filter((point) => point.mag > 0 && point.fov > 0)
    .sort((a, b) => a.mag - b.mag);
  const domain = chartDomain(points);

  return (
    <div className="mag-chart">
      <svg className="mag-chart__plot" viewBox="0 0 640 420" role="img" aria-label={t("mag.chart.aria")}>
        <rect x="0" y="0" width="640" height="420" className="mag-chart__background" />
        {domain.xMinorTicks.map((tick) => {
          const x = scaleLog(tick, domain.minMag, domain.maxMag, 72, 608);
          return <line key={`x-minor-grid-${tick}`} x1={x} y1="32" x2={x} y2="350" className="mag-chart__grid mag-chart__grid--minor" />;
        })}
        {domain.yMinorTicks.map((tick) => {
          const y = scaleLog(tick, domain.minFov, domain.maxFov, 350, 32);
          return <line key={`y-minor-grid-${tick}`} x1="72" y1={y} x2="608" y2={y} className="mag-chart__grid mag-chart__grid--minor" />;
        })}
        {domain.xTicks.map((tick) => {
          const x = scaleLog(tick, domain.minMag, domain.maxMag, 72, 608);
          return <line key={`x-grid-${tick}`} x1={x} y1="32" x2={x} y2="350" className="mag-chart__grid" />;
        })}
        {domain.yTicks.map((tick) => {
          const y = scaleLog(tick, domain.minFov, domain.maxFov, 350, 32);
          return <line key={`y-grid-${tick}`} x1="72" y1={y} x2="608" y2={y} className="mag-chart__grid" />;
        })}
        <line x1="72" y1="32" x2="72" y2="350" className="mag-chart__axis" />
        <line x1="72" y1="350" x2="608" y2="350" className="mag-chart__axis" />
        {domain.xMinorTicks.map((tick) => {
          const x = scaleLog(tick, domain.minMag, domain.maxMag, 72, 608);
          return <line key={`x-minor-${tick}`} x1={x} y1="348" x2={x} y2="352" className="mag-chart__minor-tick" />;
        })}
        {domain.yMinorTicks.map((tick) => {
          const y = scaleLog(tick, domain.minFov, domain.maxFov, 350, 32);
          return <line key={`y-minor-${tick}`} x1="70" y1={y} x2="74" y2={y} className="mag-chart__minor-tick" />;
        })}
        {domain.xTicks.map((tick) => {
          const x = scaleLog(tick, domain.minMag, domain.maxMag, 72, 608);
          return (
            <g key={`x-${tick}`}>
              <line x1={x} y1="346" x2={x} y2="354" className="mag-chart__tick" />
              <text x={x} y="372" className="mag-chart__tick-text">
                {formatTick(tick)}
              </text>
            </g>
          );
        })}
        {domain.yTicks.map((tick) => {
          const y = scaleLog(tick, domain.minFov, domain.maxFov, 350, 32);
          return (
            <g key={`y-${tick}`}>
              <line x1="68" y1={y} x2="76" y2={y} className="mag-chart__tick" />
              <text x="64" y={y + 4} className="mag-chart__tick-text mag-chart__tick-text--y">
                {formatTick(tick)}
              </text>
            </g>
          );
        })}
        {points.length >= 2 && (
          <polyline
            className="mag-chart__line"
            points={points.map((point) => plotPoint(point, domain)).join(" ")}
          />
        )}
        {points.map((point) => {
          const [x, y] = plotPoint(point, domain).split(",").map(Number);
          return (
            <g key={point.mag}>
              <circle cx={x} cy={y} r="5" className="mag-chart__dot" />
              <text x={x + 8} y={y - 8} className="mag-chart__text">
                {point.mag}x
              </text>
            </g>
          );
        })}
        <text x="76" y="24" className="mag-chart__text">{t("mag.chart.fov")}</text>
        <text x="492" y="390" className="mag-chart__text">{t("mag.chart.magnification")}</text>
      </svg>
      {points.length === 0 && <div className="muted mag-chart__empty">{t("mag.chart.empty")}</div>}
    </div>
  );
}

function MagCalibrationTable({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const state = useAppSelector((s) => s.magCalibration);
  const beam = state.beams[state.selectedBeam] ?? { path: "", m_per_fov: {} };
  const rows = Object.entries(beam.m_per_fov);

  return (
    <table className="mag-table">
      <thead>
        <tr>
          <th>{t("mag.table.magnification")}</th>
          <th>{t("mag.table.fov")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map(([mag, fov]) => (
          <tr key={mag}>
            <td>{mag}</td>
            <td>{formatScientific(fov)}</td>
            <td>
              <button
                className="btn btn--ghost"
                disabled={disabled}
                onClick={() => {
                  const next = { ...beam.m_per_fov };
                  delete next[mag];
                  dispatch(setCurrentPoints(next));
                }}
              >
                <Icon name="trash" tone="danger" />
              </button>
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={3} className="muted">{t("mag.table.empty")}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function NumberField(props: {
  label: ReactNode;
  value: number;
  min: number;
  step: number | "any";
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="field">
      <label>{props.label}</label>
      <NumberStepperInput
        value={props.value}
        min={props.min}
        step={props.step === "any" ? 1 : props.step}
        disabled={props.disabled}
        inputMode={props.step === "any" ? "decimal" : "numeric"}
        onValueChange={(next) => props.onChange(Number(next))}
      />
    </div>
  );
}

interface ChartDomain {
  minMag: number;
  maxMag: number;
  minFov: number;
  maxFov: number;
  xTicks: number[];
  yTicks: number[];
  xMinorTicks: number[];
  yMinorTicks: number[];
}

function plotPoint(point: { mag: number; fov: number }, domain: ChartDomain): string {
  const x = scaleLog(point.mag, domain.minMag, domain.maxMag, 72, 608);
  const y = scaleLog(point.fov, domain.minFov, domain.maxFov, 350, 32);
  return `${x},${y}`;
}

function chartDomain(points: Array<{ mag: number; fov: number }>): ChartDomain {
  const mags = points.map((p) => p.mag);
  const fovs = points.map((p) => p.fov);
  const [minMag, maxMag] = logBounds(mags.length ? Math.min(...mags) : 1, mags.length ? Math.max(...mags) : 100);
  const [minFov, maxFov] = logBounds(fovs.length ? Math.min(...fovs) : 1e-6, fovs.length ? Math.max(...fovs) : 1e-3);
  return {
    minMag,
    maxMag,
    minFov,
    maxFov,
    xTicks: uniqueTicks([minMag, Math.sqrt(minMag * maxMag), maxMag]),
    yTicks: uniqueTicks([minFov, Math.sqrt(minFov * maxFov), maxFov]),
    xMinorTicks: minorTicks(minMag, maxMag),
    yMinorTicks: minorTicks(minFov, maxFov),
  };
}

function logBounds(min: number, max: number): [number, number] {
  if (min === max) {
    return [min / 10, max * 10];
  }
  return [min, max];
}

function uniqueTicks(ticks: number[]): number[] {
  return [...new Set(ticks.map((tick) => Number(tick.toPrecision(6))))];
}

function minorTicks(min: number, max: number): number[] {
  const ticks: number[] = [];
  const minLog = Math.log10(min);
  const maxLog = Math.log10(max);
  const startExp = Math.floor(minLog);
  const endExp = Math.ceil(maxLog);
  for (let exp = startExp; exp <= endExp; exp += 1) {
    const base = 10 ** exp;
    for (let multiplier = 2; multiplier < 10; multiplier += 1) {
      const tick = base * multiplier;
      if (tick > min && tick < max) ticks.push(tick);
    }
  }
  return uniqueTicks(ticks);
}

function scaleLog(value: number, min: number, max: number, outMin: number, outMax: number): number {
  const lo = Math.log10(min);
  const hi = Math.log10(max);
  const ratio = (Math.log10(value) - lo) / (hi - lo);
  return outMin + ratio * (outMax - outMin);
}

function formatTick(value: number): string {
  if (value >= 0.01 && value < 10000) return value.toPrecision(3);
  return value.toExponential(1);
}

function parseMagCsv(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.toLowerCase().startsWith("beam,") || line.toLowerCase().startsWith("date,")) continue;
    const [magText, fovText] = line.split(",").map((part) => part.trim());
    if (magText.toLowerCase().startsWith("magnification")) continue;
    const mag = Math.trunc(Number(magText));
    const fov = Number(fovText);
    if (Number.isFinite(mag) && mag > 0 && Number.isFinite(fov) && fov > 0) {
      out[String(mag)] = fov;
    }
  }
  return out;
}

function formatScientific(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value >= 0.001 && value < 1000 ? value.toPrecision(6) : value.toExponential(6);
}
