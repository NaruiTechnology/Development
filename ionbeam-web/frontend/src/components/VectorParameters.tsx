/**
 * Vector scan parameter form. Fields map 1:1 to VectorRequest in
 * glasgow_service.models.
 *
 * Custom-points input accepts CSV-like text: one "x,y,dwell" triple per
 * line. We cap at 1 000 000 points to match the Pydantic max_length.
 */
import { useState } from "react";

import { updateVector } from "../store/scanSlice";
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
import { BeamEnergyField } from "./BeamEnergyField";
import { DwellHelp } from "./DwellHelp";
import { PresetNumberField, type PresetNumberOption } from "./PresetNumberField";

const MAX_POINTS = 1_000_000;
const VECTOR_RES_OPTIONS = [2048, 1024, 512, 256] as const;
const VECTOR_DWELL_OPTIONS: PresetNumberOption[] = [1, 2, 4, 8, 16, 32, 64].map((value) => ({ value }));

export function VectorParameters({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t, fmt } = useTranslation();
  const v = useAppSelector((s) => s.scan.vector);
  const [pointsText, setPointsText] = useState<string>(
    v.points ? v.points.map((p) => p.join(",")).join("\n") : ""
  );
  const [pointsErr, setPointsErr] = useState<string | null>(null);

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
          {t("vector.pattern")}
          <PatternHelp />
        </label>
        <select
          className="select"
          value={v.pattern}
          disabled={disabled}
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
            min={1}
            max={2048}
            disabled={disabled}
            title={resolutionTitle}
            helperText={t("vector.resolution.help")}
            onChange={(value) => dispatch(updateVector({ vector_resolution: value }))}
          />
          <PresetNumberField
            label={
              <label>
                {t("vector.dwell")}
                <DwellHelp />
              </label>
            }
            value={v.dwell}
            options={VECTOR_DWELL_OPTIONS}
            min={1}
            max={65535}
            disabled={disabled}
            onChange={(value) => dispatch(updateVector({ dwell: value }))}
          />
        </div>
      )}

      <div className="field-row">
        <div className="field">
          <label>
            {t("vector.latencyBytes")}
            <LatencyHelp />
          </label>
          <input
            className="input"
            type="number"
            min={2}
            value={v.latency_bytes}
            disabled={disabled}
            onChange={(e) =>
              dispatch(
                updateVector({
                  latency_bytes: clamp(e.target.value, 2, 1 << 20, 8196),
                })
              )
            }
          />
        </div>
        <div className="field">
          <label>
            {t("vector.outputMode")}
            <OutputModeHelp />
          </label>
          <select
            className="select"
            value={v.output_mode}
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
      </div>

      <div className="field">
        <label>
          {t("vector.cookie")}
          <CookieHelp />
        </label>
        <input
          className="input"
          type="number"
          min={0}
          max={0xffff}
          value={v.cookie}
          disabled={disabled}
          onChange={(e) =>
            dispatch(updateVector({ cookie: clamp(e.target.value, 0, 0xffff, 123) }))
          }
        />
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

      <label className="checkbox">
        <input
          type="checkbox"
          checked={v.pre_process}
          disabled={disabled}
          onChange={(e) => dispatch(updateVector({ pre_process: e.target.checked }))}
        />
        {t("vector.preProcess")}
        <PreProcessHelp />
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={v.do_validate}
          disabled={disabled}
          onChange={(e) => dispatch(updateVector({ do_validate: e.target.checked }))}
        />
        {t("vector.doValidate")}
        <ValidationHelp />
      </label>
    </div>
  );
}

function clamp(s: string, lo: number, hi: number, fallback: number): number {
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
