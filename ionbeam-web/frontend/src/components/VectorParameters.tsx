/**
 * Vector scan parameter form. Fields map 1:1 to VectorRequest in
 * glasgow_service.models.
 *
 * Custom-points input accepts CSV-like text: one "x,y,dwell" triple per
 * line. We cap at 1 000 000 points to match the Pydantic max_length.
 */
import { useState } from "react";

import { updateVector, updateROI } from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import { LatencyHelp } from "./LatencyHelp";
import { CookieHelp } from "./CookieHelp";
import { OutputModeHelp } from "./OutputModeHelp";
import { PatternHelp } from "./PatternHelp";
import { VectorResolutionHelp } from "./VectorResolutionHelp";
import { CustomPointsHelp } from "./CustomPointsHelp";
import { PreProcessHelp } from "./PreProcessHelp";
import { ValidationHelp } from "./ValidationHelp";
import { AdcValidHelp } from "./AdcValidHelp";
import { ScanModeHelp } from "./ScanModeHelp";
import { BeamEnergyField } from "./BeamEnergyField";
import { DwellHelp } from "./DwellHelp";
import { PresetNumberField, type PresetNumberOption } from "./PresetNumberField";
import { NumberStepperInput } from "./NumberStepperField";
import type { VectorPoint, VectorPointTuple } from "../types/api";
import { VectorScanPathField } from "./VectorScanPathField";
import { estimateRevC3ScanTiming, formatDuration, formatNanoseconds, revC3DwellPresetOptions } from "../lib/scanTiming";

const MAX_POINTS = 1_000_000;
const VECTOR_RES_OPTIONS = [2048, 1024, 512, 256, 128] as const;

function validateCustomVectorResolution(value: number, t: (key: "vector.resolution.validation.powerOfTwo" | "vector.resolution.validation.min128") => string): string | null {
  const intValue = Math.trunc(value);
  if (intValue < 128) return t("vector.resolution.validation.min128");
  if (!Number.isInteger(intValue) || (intValue & (intValue - 1)) !== 0) {
    return t("vector.resolution.validation.powerOfTwo");
  }
  return null;
}

export function VectorParameters({
  disabled,
  grayLevelFilterActive = false,
}: {
  disabled: boolean;
  grayLevelFilterActive?: boolean;
}) {
  const dispatch = useAppDispatch();
  const { t, fmt } = useTranslation();
  const v = useAppSelector((s) => s.scan.vector);
  const roi = useAppSelector((s) => s.scan.roi);
  const [pointsText, setPointsText] = useState<string>(
    v.points ? v.points.map((p) => formatPoint(p)).join("\n") : ""
  );
  const [pointsErr, setPointsErr] = useState<string | null>(null);
  const halfPeriod = useAppSelector((s) => Number(s.status.defaults?.adc?.adcHalfPeriod ?? 3));
  const timing = estimateRevC3ScanTiming(v.vector_resolution, v.dwell, halfPeriod);
  const vectorDwellOptions = revC3DwellPresetOptions(undefined, halfPeriod);

  function commitPoints(text: string) {
    setPointsText(text);
    if (!text.trim()) {
      dispatch(updateVector({ points: null }));
      setPointsErr(null);
      return;
    }
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > MAX_POINTS) {
      // Error messages are user-visible, so they go through t() with
      // numeric interpolation. fmt() applies locale-appropriate digit
      // grouping (or absence thereof in zh-CN/zh-TW).
      setPointsErr(
        t("vector.customPoints.error.tooMany", {
          count: fmt(lines.length),
          max: fmt(MAX_POINTS),
        })
      );
      return;
    }
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(/[,\s]+/).map(Number);
      if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
        setPointsErr(t("vector.customPoints.error.format", { line: i + 1 }));
        return;
      }
      out.push([parts[0] | 0, parts[1] | 0, parts[2] | 0]);
    }
    setPointsErr(null);
    dispatch(updateVector({ points: out }));
  }

  const vectorResolutionOptions: PresetNumberOption[] = VECTOR_RES_OPTIONS.map((value) => ({
    value,
    label: t(`vector.resolution.option.${value}` as const),
  }));
  const latencyMin = grayLevelFilterActive ? 8196 : 2;
  const resolutionTitle =
    v.vector_resolution === 2048
      ? t("vector.resolution.title.native")
      : 2048 % v.vector_resolution === 0
      ? t("vector.resolution.title.stride", { stride: 2048 / v.vector_resolution })
      : t("vector.resolution.title.custom", { resolution: v.vector_resolution });

  return (
    <div>
      <BeamEnergyField disabled={disabled} />

      <div className="field">
        <label>
          {t("scan.modeGuide")}
          <ScanModeHelp />
        </label>
      </div>

      <div className="field">
        <label>
          {t("vector.pattern")}
          <PatternHelp />
        </label>
        <select
          className="select"
          value={v.pattern}
          disabled={disabled || grayLevelFilterActive}
          onChange={(e) =>
            dispatch(
              updateVector({ pattern: e.target.value as "default" | "custom" })
            )
          }
        >
          <option value="default">{t("vector.pattern.default")}</option>
          <option value="custom">{t("vector.pattern.custom")}</option>
        </select>
      </div>

      {v.pattern === "default" && (
        <>
          <VectorScanPathField disabled={disabled} />
          <div className="field-row">
            <PresetNumberField
              label={
                <label>
                  {t("vector.resolution")}
                  <VectorResolutionHelp />
                </label>
              }
              value={v.vector_resolution}
              options={vectorResolutionOptions}
              min={grayLevelFilterActive ? 128 : 1}
              max={2048}
              disabled={disabled}
              title={resolutionTitle}
              customValidate={(value) => validateCustomVectorResolution(value, t)}
              normalizeValue={(value) => grayLevelFilterActive ? Math.max(128, value) : value}
              onChange={(value) => dispatch(updateVector({ vector_resolution: value }))}
            />
            <PresetNumberField
              label={
                <label>
                  {t("scan.dwell.dynamic", {
                    dwell: v.dwell,
                    period: formatNanoseconds(timing.samplePeriodNs),
                    pixel: formatNanoseconds(timing.pixelDwellNs),
                    resolution: v.vector_resolution,
                    frame: formatDuration(timing.frameSeconds),
                  })}
                  <DwellHelp />
                </label>
              }
              value={v.dwell}
          options={vectorDwellOptions}
              min={1}
              max={65535}
              disabled={disabled}
              normalizeValue={(value) => grayLevelFilterActive ? Math.max(2, value) : value}
              onChange={(value) =>
                dispatch(updateVector({ dwell: value }))
              }
            />
          </div>
        </>
      )}

      <div className="field-row">
        <div className="field">
          <label>
            {t("vector.outputMode")}
            <OutputModeHelp />
          </label>
          <select
            className="select"
            value={v.output_mode ?? "SixteenBit"}
            disabled={disabled}
            onChange={(e) =>
              dispatch(
                updateVector({
                  output_mode: e.target.value as "SixteenBit" | "EightBit",
                })
              )
            }
          >
            <option value="SixteenBit">SixteenBit</option>
            <option value="EightBit">EightBit</option>
          </select>
        </div>
        <label className="checkbox vacuum-switch app-switch">
          <input type="checkbox" checked={v.adc_valid} disabled={disabled}
            onChange={(e) => dispatch(updateVector({ adc_valid: e.target.checked }))} />
          <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
          {t("vector.adcValid")} <AdcValidHelp />
        </label>
      </div>

      <div className="field-row">
        <div className="field">
          <label>{t("vector.latencyBytes")} <LatencyHelp /></label>
          <NumberStepperInput value={v.latency_bytes} min={latencyMin} step={1}
            inputMode="numeric" disabled={disabled}
            onValueChange={(next) => dispatch(updateVector({ latency_bytes: clamp(next, latencyMin, 1 << 20, 8196) }))} />
        </div>
        <div className="field">
        <label>
          {t("vector.cookie")}
          <CookieHelp />
        </label>
        <NumberStepperInput
          value={v.cookie}
          min={0}
          max={0xffff}
          step={1}
          inputMode="numeric"
          disabled={disabled}
          onValueChange={(next) =>
            dispatch(updateVector({ cookie: clamp(next, 0, 0xffff, 123) }))
          }
        />
        </div>
      </div>

      {v.pattern === "custom" && (
        <div className="field">
          <label>
            {t("vector.customPoints.label")}
            <CustomPointsHelp />
          </label>
          <textarea
            className="input"
            style={{ minHeight: 110, fontFamily: "var(--font-mono)" }}
            // Placeholder is example numeric data, not prose; doesn't
            // need translation.
            placeholder={"0,0,2\n100,100,2\n200,100,2"}
            value={pointsText}
            disabled={disabled}
            onChange={(e) => commitPoints(e.target.value)}
          />
          <small className="muted">
            {pointsErr ? (
              <span style={{ color: "var(--c-danger)" }}>{pointsErr}</span>
            ) : v.points ? (
              t("vector.customPoints.count", { count: fmt(v.points.length) })
            ) : (
              t("vector.customPoints.empty")
            )}
          </small>
        </div>
      )}

      <div className="divider" />

      <div className="card__title" style={{ marginBottom: 6 }}>
        {t("card.validatedRunOptions")}
      </div>

      <label className="checkbox vacuum-switch app-switch">
        <input
          type="checkbox"
          checked={v.pre_process}
          disabled={disabled}
          onChange={(e) => dispatch(updateVector({ pre_process: e.target.checked }))}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        {t("vector.preProcess")}
        <PreProcessHelp />
      </label>

      <label className="checkbox vacuum-switch app-switch">
        <input
          type="checkbox"
          checked={v.do_validate}
          disabled={disabled}
          onChange={(e) => dispatch(updateVector({ do_validate: e.target.checked }))}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
        {t("vector.doValidate")}
        <ValidationHelp />
      </label>

    </div>
  );
}

function formatPoint(point: VectorPointTuple | VectorPoint): string {
  if (Array.isArray(point)) {
    return point.join(",");
  }
  return [point.x, point.y, point.dwell].join(",");
}

function clamp(s: string, lo: number, hi: number, fallback: number): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
