import { useEffect, useRef, useState } from "react";

import { updateROI, type ROIState } from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";
import type { ROIRequest } from "../types/api";

const EDGE = 640;
const UNITS = [
  { value: "um", label: "μm" },
  { value: "mm", label: "mm" },
  { value: "cm", label: "cm" },
  { value: "nm", label: "nm" },
];

export function ROIEditor({
  disabled,
  variant = "all",
}: {
  disabled: boolean;
  variant?: "controls" | "canvas" | "all";
}) {
  const dispatch = useAppDispatch();
  const roi = useAppSelector((s) => s.scan.roi);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<ROIRequest | null>(roi.selection);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    if (!roi.imageDataUrl) {
      imageRef.current = null;
      draw();
      return;
    }
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      draw();
    };
    img.src = roi.imageDataUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roi.imageDataUrl]);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roi, draft]);

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        dispatch(updateROI({ imageName: file.name, imageDataUrl: reader.result }));
      }
    };
    reader.readAsDataURL(file);
  }

  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp(Math.round(((e.clientX - r.left) / r.width) * EDGE), 0, EDGE),
      y: clamp(Math.round(((e.clientY - r.top) / r.height) * EDGE), 0, EDGE),
    };
  }

  function toDut(p: { x: number; y: number }) {
    const x = Math.round(lerp(roi.x_origin, roi.x_end, p.x / EDGE));
    const y = Math.round(lerp(roi.y_origin, roi.y_end, p.y / EDGE));
    return { x, y };
  }

  function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): ROIRequest {
    const p0 = toDut(a);
    const p1 = toDut(b);
    return {
      x_start: Math.min(p0.x, p1.x),
      x_end: Math.max(p0.x, p1.x),
      y_start: Math.min(p0.y, p1.y),
      y_end: Math.max(p0.y, p1.y),
    };
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, EDGE, EDGE);

    const img = imageRef.current;
    if (img) {
      ctx.drawImage(img, 0, 0, EDGE, EDGE);
    }

    ctx.save();
    ctx.strokeStyle = "rgba(95, 184, 255, 0.85)";
    ctx.fillStyle = "rgba(230, 238, 249, 0.92)";
    ctx.lineWidth = 1;
    ctx.font = "12px ui-monospace, monospace";
    drawScale(ctx, roi, unitLabel(roi.scale_unit));
    ctx.restore();

    const selected = draft ?? roi.selection;
    if (selected) drawSelection(ctx, selected);
  }

  function drawSelection(ctx: CanvasRenderingContext2D, selected: ROIRequest) {
    const x0 = dutToCanvas(selected.x_start, roi.x_origin, roi.x_end);
    const x1 = dutToCanvas(selected.x_end, roi.x_origin, roi.x_end);
    const y0 = dutToCanvas(selected.y_start, roi.y_origin, roi.y_end);
    const y1 = dutToCanvas(selected.y_end, roi.y_origin, roi.y_end);
    ctx.save();
    ctx.strokeStyle = "#ff2d2d";
    ctx.fillStyle = "#ff2d2d";
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    drawLabel(ctx, x0 + 4, y0 + 14, `S(${selected.x_start}, ${selected.y_start})`);
    drawLabel(ctx, x1 + 4, y1 - 6, `E(${selected.x_end}, ${selected.y_end})`);
    ctx.restore();
  }

  return (
    <div>
      {(variant === "controls" || variant === "all") && (
        <>
          <div className="button-row" style={{ marginBottom: 10 }}>
            <button className="btn" disabled={disabled} onClick={() => fileRef.current?.click()}>
              SELECT
            </button>
            <span className="muted" style={{ fontSize: 12 }}>{roi.imageName}</span>
            <input
              ref={fileRef}
              type="file"
              accept=".bmp,.png,.jpg,.jpeg,image/bmp,image/png,image/jpeg"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) loadFile(file);
              }}
            />
          </div>

          <div className="field-row">
            <Num label="X origin" value={roi.x_origin} disabled={disabled} onChange={(v) => dispatch(updateROI({ x_origin: v }))} />
            <Num label="X end" value={roi.x_end} disabled={disabled} onChange={(v) => dispatch(updateROI({ x_end: v }))} />
          </div>
          <div className="field-row">
            <Num label="Y origin" value={roi.y_origin} disabled={disabled} onChange={(v) => dispatch(updateROI({ y_origin: v }))} />
            <Num label="Y end" value={roi.y_end} disabled={disabled} onChange={(v) => dispatch(updateROI({ y_end: v }))} />
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={roi.show_grid}
              disabled={disabled}
              onChange={(e) => dispatch(updateROI({ show_grid: e.target.checked }))}
            />
            Display grid line
          </label>

          <div className="field-row">
            <Num
              label="X scale length"
              value={roi.x_scale_length}
              min={0}
              max={1_000_000}
              disabled={disabled}
              onChange={(v) => dispatch(updateROI({ x_scale_length: v, x_origin: 0, x_end: v }))}
            />
            <Num
              label="Y scale length"
              value={roi.y_scale_length}
              min={0}
              max={1_000_000}
              disabled={disabled}
              onChange={(v) => dispatch(updateROI({ y_scale_length: v, y_origin: 0, y_end: v }))}
            />
          </div>
          <div className="field">
            <label>Scale unit</label>
            <select
              className="select"
              value={roi.scale_unit}
              disabled={disabled}
              onChange={(e) => dispatch(updateROI({ scale_unit: e.target.value }))}
            >
              {UNITS.map((u) => (
                <option key={u.value} value={u.value}>{u.label}</option>
              ))}
            </select>
          </div>
        </>
      )}

      {(variant === "canvas" || variant === "all") && (
        <div className="roi-canvas-wrap">
          <canvas
            ref={canvasRef}
            width={EDGE}
            height={EDGE}
            onPointerDown={(e) => {
              if (disabled) return;
              const p = canvasPoint(e);
              dragStartRef.current = p;
              const d = toDut(p);
              setTip({ x: e.clientX, y: e.clientY, text: `(${d.x}, ${d.y})` });
            }}
            onPointerMove={(e) => {
              const p = canvasPoint(e);
              const d = toDut(p);
              if (dragStartRef.current) {
                const next = rectFromPoints(dragStartRef.current, p);
                setDraft(next);
                setTip({ x: e.clientX, y: e.clientY, text: `(${d.x}, ${d.y})` });
              }
            }}
            onPointerUp={(e) => {
              if (!dragStartRef.current) return;
              const next = rectFromPoints(dragStartRef.current, canvasPoint(e));
              dragStartRef.current = null;
              setDraft(null);
              dispatch(updateROI({ selection: next }));
              setTip(null);
            }}
            onPointerLeave={() => {
              dragStartRef.current = null;
              setDraft(null);
              setTip(null);
            }}
          />
          {tip && (
            <div className="roi-tooltip" style={{ left: tip.x + 10, top: tip.y + 10 }}>
              {tip.text}
            </div>
          )}
        </div>
      )}

      {(variant === "controls" || variant === "all") && roi.selection && (
          <div className="canvas-meta" style={{ marginTop: 8, flexWrap: "wrap" }}>
            <span>ROI X <b>{roi.selection.x_start}..{roi.selection.x_end}</b></span>
            <span>Y <b>{roi.selection.y_start}..{roi.selection.y_end}</b></span>
          </div>
        )}
    </div>
  );
}

function Num(props: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const min = props.min ?? 0;
  const max = props.max ?? 16383;
  const [text, setText] = useState(String(props.value));

  useEffect(() => {
    setText(String(props.value));
  }, [props.value]);

  return (
    <div className="field">
      <label>{props.label}</label>
      <input
        className="input"
        type="number"
        value={text}
        disabled={props.disabled}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (next === "") return;
          props.onChange(clamp(Number(next), min, max));
        }}
        onBlur={() => {
          if (text === "") setText(String(props.value));
        }}
      />
    </div>
  );
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function dutToCanvas(v: number, a: number, b: number) {
  if (a === b) return 0;
  return ((v - a) / (b - a)) * EDGE;
}

function unitLabel(value: string) {
  return UNITS.find((u) => u.value === value)?.label ?? value;
}

function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.save();
  ctx.font = "12px ui-monospace, monospace";
  const w = ctx.measureText(text).width + 8;
  const bx = Math.min(Math.max(0, x), EDGE - w);
  const by = Math.min(Math.max(14, y), EDGE - 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.52)";
  ctx.fillRect(bx - 2, by - 12, w, 16);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, bx + 2, by);
  ctx.restore();
}

function drawScale(
  ctx: CanvasRenderingContext2D,
  roi: ROIState,
  unit: string
) {
  const major = 4;
  const minorPerMajor = 5;
  const minorTicks = major * minorPerMajor;
  const axisPad = 28;

  ctx.save();
  ctx.strokeStyle = "rgba(95, 184, 255, 0.9)";
  ctx.fillStyle = "rgba(230, 238, 249, 0.95)";
  ctx.lineWidth = 1;
  ctx.font = "12px ui-monospace, monospace";

  ctx.beginPath();
  ctx.moveTo(0, axisPad);
  ctx.lineTo(EDGE, axisPad);
  ctx.moveTo(axisPad, 0);
  ctx.lineTo(axisPad, EDGE);
  ctx.stroke();

  for (let i = 0; i <= minorTicks; i++) {
    const isMajor = i % minorPerMajor === 0;
    const p = (i / minorTicks) * EDGE;
    const len = isMajor ? 10 : 5;
    ctx.beginPath();
    ctx.moveTo(p, axisPad);
    ctx.lineTo(p, axisPad + len);
    ctx.moveTo(axisPad, p);
    ctx.lineTo(axisPad + len, p);
    ctx.stroke();

    if (roi.show_grid && isMajor) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, EDGE);
      ctx.moveTo(0, p);
      ctx.lineTo(EDGE, p);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.strokeStyle = "rgba(95, 184, 255, 0.95)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    if (isMajor) {
      const t = i / minorTicks;
      const xLabel = `${roundScale(lerp(roi.x_origin, roi.x_end, t))}`;
      const yLabel = `${roundScale(lerp(roi.y_origin, roi.y_end, t))}`;
      ctx.fillText(xLabel, Math.min(p + 3, EDGE - 46), axisPad + 24);
      ctx.fillText(yLabel, axisPad + 14, Math.max(12, p - 3));
    }
  }

  drawLabel(ctx, EDGE - 150, axisPad + 42, `X ${roi.x_scale_length} ${unit}`);
  drawLabel(ctx, axisPad + 14, EDGE - 8, `Y ${roi.y_scale_length} ${unit}`);
  ctx.restore();
}

function roundScale(v: number) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, "");
}
