import { useWorkspaceActive } from "../store";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { TranslationApi } from "../i18n";
import type { ImageExtent } from "../lib/imageScale";

type Point = { x: number; y: number };
type Measurement = { start: Point; end: Point };

/** Measurements use normalized display coordinates, independent of canvas CSS size. */
export function TextureMeasurements({ frameRef, edge, extent, rotate90, enabled, t }: {
  frameRef: RefObject<HTMLDivElement>;
  t: TranslationApi["t"];
  edge: number;
  extent: ImageExtent | null;
  rotate90: boolean;
  enabled: boolean;
}) {
  const workspaceActive = useWorkspaceActive();
  const cancelGesture = useRef<(() => void) | null>(null);
  const [lines, setLines] = useState<Measurement[]>([]);
  const [draft, setDraft] = useState<Measurement | null>(null);
  useEffect(() => {
    if (!workspaceActive) return;
    const frame = frameRef.current;
    if (!frame || !enabled) return;
    let active: Measurement | null = null;
    let pointer: number | null = null;
    let suppressClick = false;
    cancelGesture.current = () => {
      active = null;
      const captured = pointer;
      pointer = null;
      setDraft(null);
      if (captured !== null && frame.hasPointerCapture(captured)) frame.releasePointerCapture(captured);
    };
    const point = (event: PointerEvent): Point => {
      const rect = frame.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      };
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.ctrlKey || !event.shiftKey ||
          (event.target as HTMLElement).closest("button, input, select, textarea")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const start = point(event);
      active = { start, end: start };
      pointer = event.pointerId;
      suppressClick = true;
      frame.setPointerCapture(pointer);
      setDraft(active);
    };
    const move = (event: PointerEvent) => {
      if (!active || pointer !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      active = { ...active, end: point(event) };
      setDraft(active);
    };
    const finish = (event: PointerEvent) => {
      if (!active || pointer !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const line = { ...active, end: point(event) };
      active = null;
      pointer = null;
      setDraft(null);
      if (event.type === "pointerup" && Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y) > 0) {
        setLines(current => [...current, line]);
      }
      if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    frame.addEventListener("pointerdown", down, true);
    frame.addEventListener("pointermove", move, true);
    frame.addEventListener("pointerup", finish, true);
    frame.addEventListener("pointercancel", finish, true);
    frame.addEventListener("lostpointercapture", finish, true);
    frame.addEventListener("click", click, true);
    return () => {
      cancelGesture.current = null;
      frame.removeEventListener("pointerdown", down, true);
      frame.removeEventListener("pointermove", move, true);
      frame.removeEventListener("pointerup", finish, true);
      frame.removeEventListener("pointercancel", finish, true);
      frame.removeEventListener("lostpointercapture", finish, true);
      frame.removeEventListener("click", click, true);
      if (pointer !== null && frame.hasPointerCapture(pointer)) frame.releasePointerCapture(pointer);
    };
  }, [frameRef, enabled, workspaceActive]);

  useEffect(() => {
    if (!workspaceActive) return;
    if (!enabled || (!lines.length && !draft)) return;
    const undo = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (draft) cancelGesture.current?.();
      else setLines(current => current.slice(0, -1));
    };
    window.addEventListener("keydown", undo, true);
    return () => window.removeEventListener("keydown", undo, true);
  }, [enabled, lines.length, draft, workspaceActive]);

  if (!enabled) return null;
  const visible = draft ? [...lines, draft] : lines;
  const latest = draft ?? lines[lines.length - 1];
  const spanX = extent ? (rotate90 ? extent.y : extent.x) : edge;
  const spanY = extent ? (rotate90 ? extent.x : extent.y) : edge;
  const unit = extent?.unit ?? "px";
  const dx = latest ? Math.abs(latest.end.x - latest.start.x) : 0;
  const dy = latest ? Math.abs(latest.end.y - latest.start.y) : 0;
  return <>
    <svg className="texture-measurements" width="100%" height="100%" aria-label={t("canvas.measurement.aria")}>
      {visible.map((line, index) => <g key={index}>
        <line
          x1={`${line.start.x * 100}%`} y1={`${line.start.y * 100}%`}
          x2={`${line.end.x * 100}%`} y2={`${line.end.y * 100}%`}
          stroke="lawngreen" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {index < lines.length && <text className="texture-measurement-length"
          x={`${(line.start.x + line.end.x) * 50}%`}
          y={`${(line.start.y + line.end.y) * 50}%`}
          dy="-7" textAnchor="middle">
          {Math.hypot((line.end.x - line.start.x) * spanX, (line.end.y - line.start.y) * spanY).toFixed(2)} {unit}
        </text>}
      </g>)}
    </svg>
    {draft && latest && <div className="texture-measurement-chip" role="status" aria-live="off" style={{
      left: `${Math.min(65, latest.end.x * 100)}%`,
      top: `${Math.min(75, latest.end.y * 100)}%`,
    }}>
      <span>{t("canvas.measurement.length", { length: Math.hypot(dx * spanX, dy * spanY).toFixed(2), unit })}</span>
      <span>{t("canvas.measurement.spans", { x: (dx * edge).toFixed(2), y: (dy * edge).toFixed(2) })}</span>
      {extent && <span>{t("canvas.measurement.pixelSize", { x: (spanX / edge).toFixed(2), y: (spanY / edge).toFixed(2), unit })}</span>}
    </div>}
  </>;
}
