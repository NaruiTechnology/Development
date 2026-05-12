/**
 * Vector scan parameter form. Fields map 1:1 to VectorRequest in
 * glasgow_service.models.
 *
 * Custom-points input accepts CSV-like text: one "x,y,dwell" triple per
 * line. We cap at 1 000 000 points to match the Pydantic max_length.
 *
 * Every parameter has an inline "?" help button next to its label,
 * opening a modal with a technical explanation. Help components
 * live in their own files (Pattern, VectorResolutionHelp, …) and
 * are shared with RasterParameters where the field has the same
 * meaning (LatencyHelp, CookieHelp, OutputModeHelp, ValidationHelp).
 */
import { useState } from "react";

import { updateVector } from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";
import { LatencyHelp } from "./LatencyHelp";
import { CookieHelp } from "./CookieHelp";
import { OutputModeHelp } from "./OutputModeHelp";
import { PatternHelp } from "./PatternHelp";
import { VectorResolutionHelp } from "./VectorResolutionHelp";
import { CustomPointsHelp } from "./CustomPointsHelp";
import { PreProcessHelp } from "./PreProcessHelp";
import { ValidationHelp } from "./ValidationHelp";

const MAX_POINTS = 1_000_000;

export function VectorParameters({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
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
      setPointsErr(`too many points: ${lines.length} > ${MAX_POINTS}`);
      return;
    }
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(/[,\s]+/).map(Number);
      if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
        setPointsErr(`line ${i + 1}: expected "x,y,dwell"`);
        return;
      }
      out.push([parts[0] | 0, parts[1] | 0, parts[2] | 0]);
    }
    setPointsErr(null);
    dispatch(updateVector({ points: out }));
  }

  return (
    <div>
      <div className="field">
        <label>
          Pattern
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
          <option value="default">Default sweep (full DAC range)</option>
          <option value="custom">Custom points</option>
        </select>
      </div>

      {v.pattern === "default" && (
        <div className="field">
          <label>
            Resolution (samples per axis)
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
            title={(() => {
              const stride = 2048 / v.vector_resolution;
              return stride === 1
                ? "Native: every DAC code is sampled."
                : `Stride ${stride}: every ${stride}th DAC code is sampled. Full DAC range still covered.`;
            })()}
          >
            <option value="2048">2048 × 2048 — native (stride 1)</option>
            <option value="1024">1024 × 1024 — stride 2</option>
            <option value="512">512 × 512 — stride 4</option>
            <option value="256">256 × 256 — stride 8</option>
          </select>
          <small className="muted">
            Smaller resolution → faster scan, sparser sampling. Coverage is
            always the full 0..2047 DAC range.
          </small>
        </div>
      )}

      <div className="field-row">
        <div className="field">
          <label>
            Latency (bytes)
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
            Output mode
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
          Cookie
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
            Custom points (x,y,dwell per line)
            <CustomPointsHelp />
          </label>
          <textarea
            className="input"
            style={{ minHeight: 110, fontFamily: "var(--font-mono)" }}
            placeholder={"0,0,2\n100,100,2\n200,100,2"}
            value={pointsText}
            disabled={disabled}
            onChange={(e) => commitPoints(e.target.value)}
          />
          <small className="muted">
            {pointsErr ? (
              <span style={{ color: "var(--c-danger)" }}>{pointsErr}</span>
            ) : v.points ? (
              `${v.points.length.toLocaleString()} points`
            ) : (
              "0 points"
            )}
          </small>
        </div>
      )}

      <div className="divider" />

      <div className="card__title" style={{ marginBottom: 6 }}>
        Validated run options
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={v.pre_process}
          disabled={disabled}
          onChange={(e) => dispatch(updateVector({ pre_process: e.target.checked }))}
        />
        Pre-process chunks (timed separately as <code>process_time_s</code>)
        <PreProcessHelp />
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={v.do_validate}
          disabled={disabled}
          onChange={(e) => dispatch(updateVector({ do_validate: e.target.checked }))}
        />
        Run non-empty / padding checks
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
