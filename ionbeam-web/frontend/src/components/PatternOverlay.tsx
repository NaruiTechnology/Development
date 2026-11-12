/**
 * Drawing layer of the Processing tab, mounted inside the ROI canvas (ROIEditor `renderCanvasOverlay`).
 *
 * It takes over the canvas pointer while the Processing tab is open: the operator draws the ROI of the selected
 * pattern, and every pattern's ROI is painted over the image.
 *
 *   rect     drag a rectangle
 *   circle   drag from the centre to the radius; release to finish
 *   ring     drag from the centre to the outer circle; drag the inner-radius handle to adjust the hole
 *            (both circles share the centre; Esc / right-click cancels)
 *   LineModel: drag endpoints; PolygonModel: four clicks; FreeHandModel: press-drag-release
 *
 * Shapes are stored in world coordinates (like the ROI selection), radii as world lengths, so a ring stays a true
 * circle whatever the image aspect and survives zoom.
 */
import { useDeferredValue, memo, useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ExposureLatticeGeometry } from "./ExposureLatticeOverlay";
import { createPortal } from "react-dom";

import { MODEL_REGISTRY, lineRoi, patternBounds, cleaningLines, stairRects, type CircleRoi, type PatternParameters, type PatternRoi, type PatternSpec, type PolygonRoi, type RectRoi, type RingRoi } from "../lib/processingPatterns";
import { ROI_CANVAS_EDGE, imageWorldBounds, viewportBounds, worldToCanvasX, worldToCanvasY } from "../lib/roiGeometry";
import { useAppDispatch, useAppSelector, useWorkspaceActive } from "../store";
import { useTranslation } from "../i18n";
import { undoPatternRoi, commitPatternRoiEdit, clearPatternRoi, selectPattern, setPatternEnabled, setPatternRoi } from "../store/processingSlice";

const DRAG_THRESHOLD = 8;           // canvas px, same as the rectangle ROI tool
const ACTIVE_COLOR = "#ffd400";
const OTHER_COLOR = "#4cc9f0";

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

type Pt = { x: number; y: number };

export interface CanvasOverlayApi {
  /** Pointer position in canvas pixels (0..640), orientation-corrected and clamped to the viewport. */
  pointFromClient(clientX: number, clientY: number): Pt;
  /** Canvas pixels to world coordinates. */
  toWorld(point: Pt): Pt;
  /** Raw gray value and canvas pixel under a client point. */
  sampleGrayAtClient(clientX: number, clientY: number): { value: number; x: number; y: number } | null;
}

type Draft =
  | { kind: "rect"; start: Pt; rect: RectRoi | null }
  | { kind: "circle" | "ring"; center: Pt; centerCanvas: Pt; outer: number; inner: number; dragging: boolean }
  | { kind: "polygon"; points: Pt[] }
  | { kind: "line"; start: Pt; end: Pt }
  | { kind: "vertices"; points: Pt[]; hover: Pt; pressed: Pt | null };

export function PatternOverlay({ disabled, api }: { disabled: boolean; api: CanvasOverlayApi }) {
  const dispatch = useAppDispatch();
  const workspaceActive = useWorkspaceActive();
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [grayTooltip, setGrayTooltip] = useState<{ x: number; y: number; value: number } | null>(null);
  const roi = useAppSelector((s) => s.scan.roi);
  const { specs, instances, activeKey } = useAppSelector((s) => s.processing);
  const materials = useAppSelector((s) => s.processing.materials);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const draft = useRef<Draft | null>(null);
  const edit = useRef<{ key: string; start: Pt; original: PatternRoi; corner: Corner | null; inner: boolean } | null>(null);
  const active = specs.find((s) => s.key === activeKey) ?? null;
  const rangedMaterials = materials.filter(material => material.grayValueRange);
  const grayMaterialMatches = grayTooltip ? rangedMaterials.filter(material => {
    const range = material.grayValueRange;
    return range !== undefined && range !== null && grayTooltip.value >= range[0] && grayTooltip.value <= range[1];
  }) : [];
  const materialRangeDistance = (material: typeof materials[number]) => {
    const range = material.grayValueRange;
    if (!grayTooltip || !range) return Number.POSITIVE_INFINITY;
    return grayTooltip.value < range[0] ? range[0] - grayTooltip.value
      : grayTooltip.value > range[1] ? grayTooltip.value - range[1] : 0;
  };
  const nearestDistance = grayTooltip && !grayMaterialMatches.length && rangedMaterials.length
    ? Math.min(...rangedMaterials.map(materialRangeDistance)) : Number.POSITIVE_INFINITY;
  const nearestMaterials = grayTooltip && !grayMaterialMatches.length && rangedMaterials.length
    ? rangedMaterials.filter(material => materialRangeDistance(material) === nearestDistance) : [];
  const grayMaterialText = grayTooltip && grayMaterialMatches.length
    ? t("roi.materialLookup.tooltip", { materials: grayMaterialMatches.map(material => material.caption ?? material.name).join(", ") })
    : grayTooltip && nearestMaterials.length
      ? t("roi.materialLookup.nearest", { materials: nearestMaterials.map(material => material.caption ?? material.name).join(", ") })
      : null;

  const bounds = imageWorldBounds(roi);
  const view = viewportBounds(roi);
  const cx = (x: number) => worldToCanvasX(x, bounds, view);
  const cy = (y: number) => worldToCanvasY(y, bounds, view);
  const sx = Math.abs(cx(1) - cx(0));          // canvas px per world unit
  const sy = Math.abs(cy(1) - cy(0));

  function cancel() {
    if (edit.current) {
      dispatch(setPatternRoi({ key: edit.current.key, roi: edit.current.original, preview: true }));
      edit.current = null;
    }
    setMenu(null);
    if (draft.current) {
      draft.current = null;
      repaint();
    }
  }

  useEffect(() => {
    if (disabled || (edit.current && edit.current.key !== activeKey)) cancel();
    if (draft.current) { draft.current = null; repaint(); }
  }, [activeKey, disabled]);              // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!workspaceActive) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      if (e.key === "Escape") cancel();
      if (!disabled && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation?.();
        if (edit.current || draft.current) cancel();
        else { setMenu(null); dispatch(undoPatternRoi()); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, dispatch, workspaceActive]);

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
    if (e.button !== 0 || disabled) return;
    if ((e.target as Element | undefined)?.closest("[data-pattern-menu]")) return;
    e.stopPropagation?.();
    setMenu(null);
    e.preventDefault();
    const p = api.pointFromClient(e.clientX, e.clientY);
    if (draft.current?.kind === "vertices") {
      draft.current.pressed = p;
      return;
    }
    const target = (e.target as Element | undefined)?.closest("[data-pattern-key]");
    const key = target?.getAttribute("data-pattern-key");
    const original = key ? instances[key]?.roi : null;
    if (!draft.current && key && original) {
      const box = patternBounds(original);
      let corner = (e.target as Element | undefined)?.getAttribute("data-pattern-resize") as Corner | null;
      if (!corner && e.ctrlKey) {
        corner = CORNERS.find(c => Math.hypot(p.x - cx(c.endsWith("w") ? box.x_start : box.x_end),
          p.y - cy(c.startsWith("n") ? box.y_start : box.y_end)) <= 16) ?? null;
      }
      edit.current = { key, start: api.toWorld(p), original, corner,
        inner: (e.target as Element | undefined)?.getAttribute("data-pattern-inner") === "true" };
      if (key !== activeKey) dispatch(selectPattern(key));
      if (!instances[key]?.enabled) dispatch(setPatternEnabled({ key, enabled: true }));
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      return;
    }
    if (!active) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events have no active pointer
    }
    if (active.model === "LineModel") draft.current = { kind: "line", start: p, end: p };
    else if (active.model === "PolygonModel") draft.current = { kind: "vertices", points: [], hover: p, pressed: p };
    else if (active.roi === "rect") draft.current = { kind: "rect", start: p, rect: null };
    else if (active.roi === "circle" || active.roi === "ring") draft.current = { kind: active.roi, center: api.toWorld(p), centerCanvas: p, outer: 0, inner: 0, dragging: true };
    else draft.current = { kind: "polygon", points: [p] };
    repaint();
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.pointerType === "touch") {
      setGrayTooltip(null);
    } else {
      const sample = api.sampleGrayAtClient(e.clientX, e.clientY);
      setGrayTooltip(sample ? { x: e.clientX, y: e.clientY, value: sample.value } : null);
    }
    const editing = edit.current;
    if (editing && !disabled) {
      const p = api.toWorld(api.pointFromClient(e.clientX, e.clientY));
      if (editing.inner && "r_inner" in editing.original) {
        const original = editing.original;
        const radius = worldDistance(p, { x: original.cx, y: original.cy });
        dispatch(setPatternRoi({ key: editing.key, roi: { ...original,
          r_inner: Math.max(original.r_outer * 0.05, Math.min(radius, original.r_outer * 0.95)) }, preview: true }));
        return;
      }
      const box = patternBounds(editing.original);
      const corner = editing.corner;
      const xMin = Math.min(bounds.x_origin, bounds.x_end), xMax = Math.max(bounds.x_origin, bounds.x_end);
      const yMin = Math.min(bounds.y_origin, bounds.y_end), yMax = Math.max(bounds.y_origin, bounds.y_end);
      const dx = Math.max(xMin - box.x_start, Math.min(xMax - box.x_end, p.x - editing.start.x));
      const dy = Math.max(yMin - box.y_start, Math.min(yMax - box.y_end, p.y - editing.start.y));
      const anchor = { x: corner?.endsWith("w") ? box.x_end : box.x_start,
        y: corner?.startsWith("n") ? box.y_end : box.y_start };
      const width = box.x_end - box.x_start, height = box.y_end - box.y_start;
      const minX = 6 / sx, minY = 6 / sy;
      let scaleX = corner ? Math.max(minX, Math.abs(p.x - anchor.x)) / width : 1;
      let scaleY = corner ? Math.max(minY, Math.abs(p.y - anchor.y)) / height : 1;
      // Circular shapes retain their aspect ratio and stay inside the image.
      if ("cx" in editing.original && corner) {
        const availableX = corner.endsWith("w") ? anchor.x - xMin : xMax - anchor.x;
        const availableY = corner.startsWith("n") ? anchor.y - yMin : yMax - anchor.y;
        scaleX = scaleY = Math.min(Math.max(scaleX, scaleY), availableX / width, availableY / height);
      }
      const scale = scaleX;
      const destination = { x: corner?.endsWith("w") ? anchor.x - width * scaleX : anchor.x,
        y: corner?.startsWith("n") ? anchor.y - height * scaleY : anchor.y };
      const point = (x: number, y: number): [number, number] => corner
        ? [destination.x + (x - box.x_start) * scaleX, destination.y + (y - box.y_start) * scaleY]
        : [x + dx, y + dy];
      const original = editing.original;
      let next: PatternRoi;
      if ("points" in original) next = { points: original.points.map(([x, y]) => point(x, y)) };
      else if ("cx" in original) {
        const [cx, cy] = point(original.cx, original.cy);
        next = "radius" in original ? { cx, cy, radius: original.radius * scale }
          : { cx, cy, r_inner: original.r_inner * scale, r_outer: original.r_outer * scale };
      } else {
        const [x_start, y_start] = point(original.x_start, original.y_start);
        const [x_end, y_end] = point(original.x_end, original.y_end);
        next = { x_start, y_start, x_end, y_end };
      }
      dispatch(setPatternRoi({ key: editing.key, roi: next, preview: true }));
      return;
    }
    const d = draft.current;
    if (!d || !active || disabled) return;
    const p = api.pointFromClient(e.clientX, e.clientY);
    if (d.kind === "line") {
      d.end = p;
    } else if (d.kind === "vertices") {
      d.hover = p;
    } else if (d.kind === "rect") {
      if (Math.max(Math.abs(p.x - d.start.x), Math.abs(p.y - d.start.y)) >= DRAG_THRESHOLD) {
        const a = api.toWorld(d.start);
        const b = api.toWorld(p);
        d.rect = { x_start: Math.min(a.x, b.x), x_end: Math.max(a.x, b.x), y_start: Math.min(a.y, b.y), y_end: Math.max(a.y, b.y) };
      }
    } else if (d.kind === "circle" || d.kind === "ring") {
      const dist = worldDistance(api.toWorld(p), d.center);
      if (d.dragging) d.outer = dist;
      else {
        const gap = Math.min(d.outer / 4, 2 / Math.max(sx, sy));
        d.inner = Math.max(gap, Math.min(dist, d.outer - gap));
      }
    } else if (d.kind === "polygon") {
      const last = d.points[d.points.length - 1];
      const spacing = Number(instances[active.key]?.parameters.smoothing ?? 2);
      if (Math.hypot(p.x - last.x, p.y - last.y) >= Math.max(spacing, 0.5)) d.points.push(p);
    }
    repaint();
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    if (edit.current) {
      onPointerMove(e);
      dispatch(commitPatternRoiEdit({ key: edit.current.key, original: edit.current.original }));
      edit.current = null;
      return;
    }
    const d = draft.current;
    if (!d || !active || e.button !== 0) return;
    const p = api.pointFromClient(e.clientX, e.clientY);
    if (d.kind === "line") {
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) >= DRAG_THRESHOLD) {
        const a = api.toWorld(d.start), b = api.toWorld(p);
        commit(lineRoi([a.x, a.y], [b.x, b.y], Number(instances[active.key]?.parameters.lineWidth ?? 0.5)));
      }
      draft.current = null;
    } else if (d.kind === "vertices") {
      if (d.pressed && Math.hypot(p.x - d.pressed.x, p.y - d.pressed.y) < DRAG_THRESHOLD) {
        const last = d.points[d.points.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 1) d.points.push(p);
        if (d.points.length === 4) {
          commit({ points: d.points.map(q => { const w = api.toWorld(q); return [w.x, w.y]; }) });
          draft.current = null;
        }
      }
      d.pressed = null;
    } else if (d.kind === "rect") {
      if (d.rect) commit(d.rect);
      draft.current = null;
    } else if (d.kind === "circle" || d.kind === "ring") {
      const moved = Math.hypot(p.x - d.centerCanvas.x, p.y - d.centerCanvas.y);
      if (d.dragging) d.outer = worldDistance(api.toWorld(p), d.center);
      if (moved >= DRAG_THRESHOLD && d.outer > 0) {
        if (d.kind === "circle") {
          commit({ cx: d.center.x, cy: d.center.y, radius: d.outer });
          draft.current = null;
        } else {
          commit({ cx: d.center.x, cy: d.center.y, r_inner: d.outer * 0.5, r_outer: d.outer });
          draft.current = null;
        }
      } else {
        draft.current = null;
      }
    } else if (d.kind === "polygon") {
      if (d.points.length >= 3) commit({ points: d.points.map((q): [number, number] => { const w = api.toWorld(q); return [w.x, w.y]; }) });
      draft.current = null;
    }
    repaint();
  }

  function onPointerLeave() {
    setGrayTooltip(null);
    if (draft.current && draft.current.kind !== "vertices") cancel();
  }

  const d = draft.current;
  return (
    <>
    <svg
      className={`roi-canvas-layer roi-pattern-overlay${active ? "" : " roi-pattern-overlay--idle"}`}
      viewBox={`0 0 ${ROI_CANVAS_EDGE} ${ROI_CANVAS_EDGE}`}
      preserveAspectRatio="none"
      data-testid="pattern-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation?.();
        if (disabled) return;
        if (draft.current || edit.current) { cancel(); return; }
        const key = (e.target as Element | undefined)?.closest("[data-pattern-key]")?.getAttribute("data-pattern-key");
        if (key) {
          dispatch(selectPattern(key));
          if (!instances[key]?.enabled) dispatch(setPatternEnabled({ key, enabled: true }));
          const p = api.pointFromClient(e.clientX, e.clientY);
          setMenu({ ...p, key });
        }
      }}
    >
      {specs.map((spec) => {
        const inst = instances[spec.key];
        return inst?.roi ? (
          <g key={spec.key} data-pattern-key={spec.key} style={{ cursor: disabled ? "default" : "grab" }}>
            <Shape spec={spec} params={inst.parameters} roi={inst.roi} active={spec.key === activeKey} cx={cx} cy={cy} sx={sx} sy={sy} />
            {spec.key === activeKey && (() => {
              const box = patternBounds(inst.roi);
              const x = Math.min(cx(box.x_start), cx(box.x_end));
              const y = Math.max(cy(box.y_start), cy(box.y_end));
              const unit = roi.scale_unit === "um" ? "µm" : roi.scale_unit;
              return <g>
                {!disabled && CORNERS.map(corner => <rect key={corner} data-pattern-resize={corner}
                  x={cx(corner.endsWith("w") ? box.x_start : box.x_end) - 6}
                  y={cy(corner.startsWith("n") ? box.y_start : box.y_end) - 6}
                  width={12} height={12} fill="transparent" stroke="none"
                  style={{ cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize" }}>
                  <title>Drag to resize</title>
                </rect>)}
                {!disabled && CORNERS.map(corner => <rect key={`marker-${corner}`}
                  x={cx(corner.endsWith("w") ? box.x_start : box.x_end) - 1}
                  y={cy(corner.startsWith("n") ? box.y_start : box.y_end) - 1}
                  width={2} height={2} fill={ACTIVE_COLOR} stroke="#fff" strokeWidth={0.5} pointerEvents="none" />)}
                {!disabled && "r_inner" in inst.roi && <g>
                  <circle data-pattern-inner="true" cx={cx(inst.roi.cx + inst.roi.r_inner)} cy={cy(inst.roi.cy)}
                    r={6} fill="transparent" style={{ cursor: "ew-resize" }}><title>Drag to adjust inner radius</title></circle>
                  <circle cx={cx(inst.roi.cx + inst.roi.r_inner)} cy={cy(inst.roi.cy)} r={1.5}
                    fill={ACTIVE_COLOR} stroke="#fff" strokeWidth={0.5} pointerEvents="none" />
                </g>}
                <foreignObject x={x - 80 + Math.abs(cx(box.x_end) - cx(box.x_start)) / 2} y={y + 5} width={160} height={65} pointerEvents="none">
                <PatternMessageChip text={`W: ${Math.abs(box.x_end - box.x_start).toFixed(2)} ${unit}\nH: ${Math.abs(box.y_end - box.y_start).toFixed(2)} ${unit}\nAvgGray: ${inst.AvgGray == null ? "—" : inst.AvgGray.toFixed(2)}`} />
              </foreignObject></g>;
            })()}
          </g>
        ) : null;
      })}
      <ExposureLatticeGeometry project={(x,y) => ({x:cx(x),y:cy(y)})} />
      {active && d?.kind === "rect" && d.rect && (
        <Shape spec={active} params={instances[active.key]?.parameters ?? {}} roi={d.rect} active draft cx={cx} cy={cy} sx={sx} sy={sy} />
      )}
      {active && d?.kind === "ring" && d.outer > 0 && (
        <Shape spec={active} params={{}} roi={{ cx: d.center.x, cy: d.center.y, r_inner: d.dragging ? d.outer * 0.5 : d.inner, r_outer: d.outer }} active draft cx={cx} cy={cy} sx={sx} sy={sy} />
      )}
      {active && d?.kind === "circle" && d.outer > 0 && (
        <Shape spec={active} params={{}} roi={{ cx: d.center.x, cy: d.center.y, radius: d.outer }} active draft cx={cx} cy={cy} sx={sx} sy={sy} />
      )}
      {active && d?.kind === "line" && Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) > 0 && (() => {
        const a = api.toWorld(d.start), b = api.toWorld(d.end);
        return <Shape spec={active} params={{}} roi={lineRoi([a.x, a.y], [b.x, b.y], Number(instances[active.key]?.parameters.lineWidth ?? 0.5))}
          active draft cx={cx} cy={cy} sx={sx} sy={sy} />;
      })()}
      {d?.kind === "vertices" && d.points.length > 0 && <g pointerEvents="none">
        <polyline points={[...d.points, d.hover, d.points[0]].map(q => `${q.x},${q.y}`).join(" ")}
          fill="none" stroke={ACTIVE_COLOR} strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
        {d.points.map((q, i) => <circle key={i} cx={q.x} cy={q.y} r={3} fill={ACTIVE_COLOR} />)}
      </g>}
      {d?.kind === "polygon" && d.points.length > 1 && (
        <polyline
          points={d.points.map((q) => `${q.x},${q.y}`).join(" ")}
          fill="none" stroke={ACTIVE_COLOR} strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
    {workspaceActive && grayTooltip && createPortal(
      <div className="roi-gray-tooltip" style={{ left: grayTooltip.x, top: grayTooltip.y }} role="tooltip">
        <div className="roi-gray-tooltip__line">
          <span className="roi-gray-tooltip__swatch" style={{ background: `rgb(${grayTooltip.value}, ${grayTooltip.value}, ${grayTooltip.value})` }} />
          {t("roi.targetGray.tooltip", { value: grayTooltip.value })}
        </div>
        {grayMaterialText && <div className="roi-gray-tooltip__line">{grayMaterialText}</div>}
      </div>,
      document.body,
    )}
    {menu && <div className="canvas-editor__menu scan-roi-layer__menu pattern-roi-menu" data-pattern-menu="true"
      style={{ left: `clamp(0px, ${menu.x / ROI_CANVAS_EDGE * 100}%, calc(100% - 190px))`,
        top: `clamp(0px, ${menu.y / ROI_CANVAS_EDGE * 100}%, calc(100% - 60px))` }}>
      <button type="button" className="canvas-editor__menu-item scan-roi-layer__menu-item" onClick={(e) => {
        e.stopPropagation(); dispatch(clearPatternRoi(menu.key)); setMenu(null);
      }}>{t("scan.roi.remove")}</button>
    </div>}
    </>
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
    pointerEvents: "all" as const,
    stroke: color,
    strokeWidth: active ? 1.6 : 1.1,
    strokeDasharray: draft ? "5 4" : undefined,
    vectorEffect: "non-scaling-stroke" as const,
  };
  const fill = { fill: color, fillOpacity: active ? 0.22 : 0.14 };
  const rectBox = (r: RectRoi) => ({ x: Math.min(cx(r.x_start), cx(r.x_end)), y: Math.min(cy(r.y_start), cy(r.y_end)), width: Math.abs(cx(r.x_end) - cx(r.x_start)), height: Math.abs(cy(r.y_end) - cy(r.y_start)) });

  if (spec.roi === "circle") {
    const r = roi as CircleRoi;
    return <ellipse cx={cx(r.cx)} cy={cy(r.cy)} rx={r.radius * sx} ry={r.radius * sy} fill="none" {...common} />;
  }
  if (spec.roi === "ring") {
    const r = roi as RingRoi;
    const x = cx(r.cx);
    const y = cy(r.cy);
    return <g>
      <path d={ellipsePath(x, y, r.r_outer * sx, r.r_outer * sy) + ellipsePath(x, y, r.r_inner * sx, r.r_inner * sy)} fillRule="evenodd" {...fill} stroke="none" />
      <ellipse data-ring-boundary="outer" cx={x} cy={y} rx={r.r_outer * sx} ry={r.r_outer * sy} fill="none" {...common} />
      <ellipse data-ring-boundary="inner" cx={x} cy={y} rx={r.r_inner * sx} ry={r.r_inner * sy} fill="none" {...common} />
    </g>;
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
          <rect key={i} {...rectBox(s)} fill={`rgb(${225 - Math.round(170*(i+1)/steps.length)},${225 - Math.round(170*(i+1)/steps.length)},${225 - Math.round(170*(i+1)/steps.length)})`} fillOpacity={0.7} {...common} />
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

/** Let pointer-driven geometry render before the readout text. */
const PatternMessageChip = memo(function PatternMessageChip({ text }: { text: string }) {
  const deferredText = useDeferredValue(text);
  return <div className="scan-roi-layer__dimensions pattern-roi-chip">{deferredText}</div>;
});
