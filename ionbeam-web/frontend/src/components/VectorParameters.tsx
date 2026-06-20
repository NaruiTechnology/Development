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
import { useTranslation, type TranslationKey } from "../i18n";
import { LatencyHelp } from "./LatencyHelp";
import { CookieHelp } from "./CookieHelp";
import { OutputModeHelp } from "./OutputModeHelp";
import { PatternHelp } from "./PatternHelp";
import { VectorResolutionHelp } from "./VectorResolutionHelp";
import { CustomPointsHelp } from "./CustomPointsHelp";
import { PreProcessHelp } from "./PreProcessHelp";
import { ValidationHelp } from "./ValidationHelp";
import { BeamEnergyField } from "./BeamEnergyField";

const MAX_POINTS = 1_000_000;

// vector_resolution → translation-key + stride map. Defined here, not
// in i18n/locales/en.ts, because the canonical schema there only
// stores the labels — the stride numbers are app logic.
const VECTOR_RES_OPTIONS: Array<{ value: number; labelKey: TranslationKey }> = [
  { value: 2048, labelKey: "vector.resolution.option.2048" },
  { value: 1024, labelKey: "vector.resolution.option.1024" },
  { value: 512, labelKey: "vector.resolution.option.512" },
  { value: 256, labelKey: "vector.resolution.option.256" },
];

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

  // Build the stride tooltip for the resolution select once per render.
  const stride = 2048 / v.vector_resolution;
  const resolutionTitle =
    stride === 1
      ? t("vector.resolution.title.native")
      : t("vector.resolution.title.stride", { stride });

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
        <div className="field">
          <label>
            {t("vector.resolution")}
            <VectorResolutionHelp />
          </label>
          <select
            className="select"
            value={String(v.vector_resolution)}
            disabled={disabled}
            onChange={(e) =>
              dispatch(
                updateVector({ vector_resolution: Number(e.target.value) })
              )
            }
            title={resolutionTitle}
          >
            {VECTOR_RES_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
          <small className="muted">{t("vector.resolution.help")}</small>
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
