/**
 * Drawing layer of the Processing tab, mounted inside the ROI canvas (ROIEditor `renderCanvasOverlay`).
 *
 * It takes over the canvas pointer while the Processing tab is open: the operator draws the ROI of the selected
 * pattern, and every pattern's ROI is painted over the image.
 *
 *   rect     drag a rectangle
 *   ring     drag from the centre to the outer circle, then click for the inner circle; both circles share the
 *            centre and the pattern is the area between them (Esc / right-click cancels)
 *   polygon  press, drag, release: a free-hand outline
 *
 * Shapes are stored in world coordinates (like the ROI selection), radii as world lengths, so a ring stays a true
 * circle whatever the image aspect and survives zoom.
 */
import { useEffect, useReducer, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { cleaningLines, stairRects, type PatternParameters, type PatternRoi, type PatternSpec, type PolygonRoi, type RectRoi, type RingRoi } from "../lib/processingPatterns";
import { ROI_CANVAS_EDGE, imageWorldBounds, viewportBounds, worldToCanvasX, worldToCanvasY } from "../lib/roiGeometry";
import { useAppDispatch, useAppSelector } from "../store";
import { setPatternRoi } from "../store/processingSlice";

const DRAG_THRESHOLD = 8;           // canvas px, same as the rectangle ROI tool
const ACTIVE_COLOR = "#ffd400";
const OTHER_COLOR = "#4cc9f0";

type Pt = { x: number; y: number };

export interface CanvasOverlayApi {
  /** Pointer position in canvas pixels (0..640), orientation-corrected and clamped to the viewport. */
  pointFromClient(clientX: number, clientY: number): Pt;
  /** Canvas pixels to world coordinates. */
  toWorld(point: Pt): Pt;
}

type Draft =
  | { kind: "rect"; start: Pt; rect: RectRoi | null }
  | { kind: "ring"; center: Pt; centerCanvas: Pt; outer: number; inner: number; dragging: boolean }
  | { kind: "polygon"; points: Pt[] };

export function PatternOverlay({ disabled, api }: { disabled: boolean; api: CanvasOverlayApi }) {
  const dispatch = useAppDispatch();
  const roi = useAppSelector((s) => s.scan.roi);
  const { specs, instances, activeKey } = useAppSelector((s) => s.processing);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const draft = useRef<Draft | null>(null);
  const active = specs.find((s) => s.key === activeKey) ?? null;

  const bounds = imageWorldBounds(roi);
  const view = viewportBounds(roi);
  const cx = (x: number) => worldToCanvasX(x, bounds, view);
  const cy = (y: number) => worldToCanvasY(y, bounds, view);
  const sx = Math.abs(cx(1) - cx(0));          // canvas px per world unit
  const sy = Math.abs(cy(1) - cy(0));

  function cancel() {
    if (draft.current) {
      draft.current = null;
      repaint();
    }
  }

  useEffect(cancel, [activeKey]);              // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function commit(roiValue: PatternRoi) {
    if (active) dispatch(setPatternRoi({ key: active.key, roi: roiValue }));
  }

  function worldDistance(a: Pt, b: Pt) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.button === 2) {
      cancel();
      return;
    }
    if (e.button !== 0 || disabled || !active) return;
    e.preventDefault();
    const p = api.pointFromClient(e.clientX, e.clientY);
    const d = draft.current;
    if (active.roi === "ring" && d?.kind === "ring" && !d.dragging) {
      // second step: this click places the inner circle
      const dist = worldDistance(api.toWorld(p), d.center);
      commit({ cx: d.center.x, cy: d.center.y, r_inner: Math.min(dist, d.outer * 0.999), r_outer: d.outer });
      draft.current = null;
      repaint();
      return;
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events have no active pointer
    }
    if (active.roi === "rect") draft.current = { kind: "rect", start: p, rect: null };
    else if (active.roi === "ring") draft.current = { kind: "ring", center: api.toWorld(p), centerCanvas: p, outer: 0, inner: 0, dragging: true };
    else draft.current = { kind: "polygon", points: [p] };
    repaint();
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const d = draft.current;
    if (!d || !active || disabled) return;
    const p = api.pointFromClient(e.clientX, e.clientY);
    if (d.kind === "rect") {
      if (Math.max(Math.abs(p.x - d.start.x), Math.abs(p.y - d.start.y)) >= DRAG_THRESHOLD) {
        const a = api.toWorld(d.start);
        const b = api.toWorld(p);
        d.rect = { x_start: Math.min(a.x, b.x), x_end: Math.max(a.x, b.x), y_start: Math.min(a.y, b.y), y_end: Math.max(a.y, b.y) };
      }
    } else if (d.kind === "ring") {
      const dist = worldDistance(api.toWorld(p), d.center);
      if (d.dragging) d.outer = dist;
      else d.inner = Math.min(dist, d.outer * 0.999);
    } else {
      const last = d.points[d.points.length - 1];
      const spacing = Number(instances[active.key]?.parameters.smoothing ?? 2);
      if (Math.hypot(p.x - last.x, p.y - last.y) >= Math.max(spacing, 0.5)) d.points.push(p);
    }
    repaint();
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    const d = draft.current;
    if (!d || !active || e.button !== 0) return;
    const p = api.pointFromClient(e.clientX, e.clientY);
    if (d.kind === "rect") {
      if (d.rect) commit(d.rect);
      draft.current = null;
    } else if (d.kind === "ring") {
      const moved = Math.hypot(p.x - d.centerCanvas.x, p.y - d.centerCanvas.y);
      if (moved >= DRAG_THRESHOLD && d.outer > 0) {
        d.dragging = false;                     // wait for the inner-circle click
        d.inner = d.outer * 0.5;
      } else {
        draft.current = null;
      }
    } else {
      if (d.points.length >= 3) commit({ points: d.points.map((q): [number, number] => { const w = api.toWorld(q); return [w.x, w.y]; }) });
      draft.current = null;
    }
    repaint();
  }

  function onPointerLeave() {
    const d = draft.current;
    if (d && !(d.kind === "ring" && !d.dragging)) cancel();   // a pending inner-circle click survives the cursor leaving
  }

  const d = draft.current;
  return (
    <svg
      className={`roi-canvas-layer roi-pattern-overlay${active ? "" : " roi-pattern-overlay--idle"}`}
      viewBox={`0 0 ${ROI_CANVAS_EDGE} ${ROI_CANVAS_EDGE}`}
      preserveAspectRatio="none"
      data-testid="pattern-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onContextMenu={(e) => e.preventDefault()}
    >
      {specs.map((spec) => {
        const inst = instances[spec.key];
        return inst?.roi ? (
          <Shape key={spec.key} spec={spec} params={inst.parameters} roi={inst.roi} active={spec.key === activeKey} cx={cx} cy={cy} sx={sx} sy={sy} />
        ) : null;
      })}
      {active && d?.kind === "rect" && d.rect && (
        <Shape spec={active} params={instances[active.key]?.parameters ?? {}} roi={d.rect} active draft cx={cx} cy={cy} sx={sx} sy={sy} />
      )}
      {active && d?.kind === "ring" && d.outer > 0 && (
        <Shape spec={active} params={{}} roi={{ cx: d.center.x, cy: d.center.y, r_inner: d.dragging ? 0 : d.inner, r_outer: d.outer }} active draft cx={cx} cy={cy} sx={sx} sy={sy} />
      )}
      {d?.kind === "polygon" && d.points.length > 1 && (
        <polyline
          points={d.points.map((q) => `${q.x},${q.y}`).join(" ")}
          fill="none" stroke={ACTIVE_COLOR} strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

interface ShapeProps {
  spec: PatternSpec;
  params: PatternParameters;
  roi: PatternRoi;
  active: boolean;
  draft?: boolean;
  cx: (x: number) => number;
  cy: (y: number) => number;
  sx: number;
  sy: number;
}

function ellipsePath(x: number, y: number, rx: number, ry: number) {
  return `M${x - rx} ${y}A${rx} ${ry} 0 1 0 ${x + rx} ${y}A${rx} ${ry} 0 1 0 ${x - rx} ${y}Z`;
}

function Shape({ spec, params, roi, active, draft = false, cx, cy, sx, sy }: ShapeProps) {
  const color = active ? ACTIVE_COLOR : OTHER_COLOR;
  const common = {
    stroke: color,
    strokeWidth: active ? 1.6 : 1.1,
    strokeDasharray: draft ? "5 4" : undefined,
    vectorEffect: "non-scaling-stroke" as const,
  };
  const fill = { fill: color, fillOpacity: active ? 0.22 : 0.14 };
  const rectBox = (r: RectRoi) => ({ x: Math.min(cx(r.x_start), cx(r.x_end)), y: Math.min(cy(r.y_start), cy(r.y_end)), width: Math.abs(cx(r.x_end) - cx(r.x_start)), height: Math.abs(cy(r.y_end) - cy(r.y_start)) });

  if (spec.roi === "ring") {
    const r = roi as RingRoi;
    const x = cx(r.cx);
    const y = cy(r.cy);
    return <path d={ellipsePath(x, y, r.r_outer * sx, r.r_outer * sy) + ellipsePath(x, y, r.r_inner * sx, r.r_inner * sy)} fillRule="evenodd" {...fill} {...common} />;
  }
  if (spec.roi === "polygon") {
    const pts = (roi as PolygonRoi).points.map(([x, y]) => `${cx(x)},${cy(y)}`).join(" ");
    return <polygon points={pts} {...fill} {...common} />;
  }
  const r = roi as RectRoi;
  const box = rectBox(r);
  if (spec.model === "OpenBoxModel") {
    const w = Number(params.lineWidth ?? 0);
    const iw = box.width - 2 * w * sx;
    const ih = box.height - 2 * w * sy;
    const inner = iw > 0 && ih > 0 ? `M${box.x + w * sx} ${box.y + w * sy}h${iw}v${ih}h${-iw}Z` : "";
    return <path d={`M${box.x} ${box.y}h${box.width}v${box.height}h${-box.width}Z${inner}`} fillRule="evenodd" {...fill} {...common} />;
  }
  if (spec.model === "StairCutModel") {
    const steps = stairRects(r, params);
    return (
      <g>
        {steps.map((s, i) => (
          <rect key={i} {...rectBox(s)} fill={color} fillOpacity={0.1 + (0.35 * (i + 1)) / steps.length} {...common} />
        ))}
      </g>
    );
  }
  if (spec.model === "CleaningLineModel") {
    return (
      <g>
        <rect {...box} fill="none" {...common} />
        {cleaningLines(r, params).map(([a, b], i) => (
          <line key={i} x1={cx(a[0])} y1={cy(a[1])} x2={cx(b[0])} y2={cy(b[1])} stroke={color} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    );
  }
  return <rect {...box} {...fill} {...common} />;
}
