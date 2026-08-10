import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import sampleStageImage from "../assets/SampleStage-0.3.png";
import { useTranslation } from "../i18n";
import { apiUrl } from "../lib/backendUrl";
import { NumberStepperInput } from "./NumberStepperField";

type StageStatus = {
  connected: boolean;
  simulation: boolean;
  position: { x: number; y: number };
  limits: {
    x: { minimum: number; maximum: number };
    y: { minimum: number; maximum: number };
  };
  moving: boolean;
  last_error: string | null;
};

type StageUnit = "um" | "mm" | "cmm";
const MM_PER_UNIT: Record<StageUnit, number> = { um: 0.001, mm: 1, cmm: 0.01 };

function displayValue(mm: number, unit: StageUnit): number {
  return Number((mm / MM_PER_UNIT[unit]).toFixed(4));
}

function canonicalValue(value: number, unit: StageUnit): number {
  return value * MM_PER_UNIT[unit];
}

function unitLabel(unit: StageUnit): string {
  return unit === "um" ? "µm" : unit;
}

type Props = {
  open: boolean;
  minimized: boolean;
  onMinimizedChange: (minimized: boolean) => void;
  onActivityChange: (active: boolean) => void;
  onClose: () => void;
};

export function SampleStageDashboard({ open, minimized, onMinimizedChange, onActivityChange, onClose }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [windowOffset, setWindowOffset] = useState({ x: 0, y: 0 });
  const [stagePosition, setStagePosition] = useState({ x: 0, y: 0 });
  const [targetPosition, setTargetPosition] = useState({ x: 0, y: 0 });
  const [unit, setUnit] = useState<StageUnit>("um");
  const [stageStatus, setStageStatus] = useState<StageStatus | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [movePending, setMovePending] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const positionEditedRef = useRef(false);
  const animationRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null>(null);

  useEffect(() => {
    onActivityChange(open && (initializing || movePending || stageStatus?.moving === true));
  }, [initializing, movePending, onActivityChange, open, stageStatus?.moving]);

  useEffect(() => () => onActivityChange(false), [onActivityChange]);

  useEffect(() => {
    if (!open) return;
    setWindowOffset({ x: 0, y: 0 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInitializing(true);
    async function refresh() {
      try {
        const response = await fetch(apiUrl("/api/stage"));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json() as StageStatus;
        if (!cancelled) {
          setStageStatus(status);
          if (animationRef.current === null) setStagePosition(status.position);
          if (!positionEditedRef.current) setTargetPosition(status.position);
          setStageError(status.last_error);
          setInitializing(false);
        }
      } catch (error) {
        if (!cancelled) {
          setStageError(error instanceof Error ? error.message : String(error));
          setInitializing(false);
        }
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open]);

  async function moveStage() {
    setStageError(null);
    setMovePending(true);
    try {
      const response = await fetch(apiUrl("/api/stage/move"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetPosition),
      });
      const body = await response.json() as StageStatus | { detail?: string };
      if (!response.ok) {
        throw new Error("detail" in body ? body.detail || `HTTP ${response.status}` : `HTTP ${response.status}`);
      }
      setStageStatus(body as StageStatus);
      animateStage((body as StageStatus).position);
      setTargetPosition((body as StageStatus).position);
      positionEditedRef.current = false;
    } catch (error) {
      setStageError(error instanceof Error ? error.message : String(error));
    } finally {
      setMovePending(false);
    }
  }

  function animateStage(target: { x: number; y: number }) {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    const start = { ...stagePosition };
    const startedAt = performance.now();
    const duration = 500;
    function frame(now: number) {
      const elapsed = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - elapsed, 3);
      setStagePosition({
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      });
      if (elapsed < 1) animationRef.current = requestAnimationFrame(frame);
      else animationRef.current = null;
    }
    animationRef.current = requestAnimationFrame(frame);
  }

  useEffect(() => () => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
  }, []);

  useEffect(() => {
    if (!open || minimized) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const image = new Image();
    image.src = sampleStageImage;
    image.onload = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const pixelRatio = window.devicePixelRatio || 1;
      const bounds = canvas.getBoundingClientRect();
      canvas.width = Math.round(bounds.width * pixelRatio);
      canvas.height = Math.round(bounds.height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);
      const scale = Math.min(bounds.width / image.width, bounds.height / image.height) * 0.72;
      const width = image.width * scale;
      const height = image.height * scale;
      const xTravel = (bounds.width - width) / 2;
      const yTravel = (bounds.height - height) / 2;
      const x = (bounds.width - width) / 2 + (stagePosition.x / 50) * xTravel;
      const y = (bounds.height - height) / 2 - (stagePosition.y / 50) * yTravel;
      context.drawImage(image, x, y, width, height);

      // Draw the positive Cartesian axes after the image so browser stacking
      // contexts cannot hide the origin guides behind the canvas.
      const xLimits = stageStatus?.limits.x ?? { minimum: -50, maximum: 50 };
      const yLimits = stageStatus?.limits.y ?? { minimum: -50, maximum: 50 };
      const originX = ((0 - xLimits.minimum) / (xLimits.maximum - xLimits.minimum)) * bounds.width;
      const originY = ((yLimits.maximum - 0) / (yLimits.maximum - yLimits.minimum)) * bounds.height;
      context.save();
      context.beginPath();
      // X=0 starts at the zero tick on the top X axis and runs downward.
      context.moveTo(originX, 0);
      context.lineTo(originX, bounds.height);
      // Y=0 starts at the zero tick on the left Y axis and runs rightward.
      context.moveTo(0, originY);
      context.lineTo(bounds.width, originY);
      context.strokeStyle = "rgba(255, 0, 0, 1)";
      context.lineWidth = 0.5;
      context.stroke();
      context.restore();
    };
  }, [minimized, open, stagePosition, stageStatus?.limits]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  function startDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, select")) return;
    const dialog = event.currentTarget.closest<HTMLElement>(".sample-stage-dashboard");
    if (!dialog) return;
    const bounds = dialog.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: windowOffset.x,
      originY: windowOffset.y,
      minX: windowOffset.x + 8 - bounds.left,
      maxX: windowOffset.x + window.innerWidth - 8 - bounds.right,
      minY: windowOffset.y + 8 - bounds.top,
      maxY: windowOffset.y + window.innerHeight - 8 - bounds.bottom,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDragging(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setWindowOffset({
      x: Math.min(drag.maxX, Math.max(drag.minX, drag.originX + event.clientX - drag.startX)),
      y: Math.min(drag.maxY, Math.max(drag.minY, drag.originY + event.clientY - drag.startY)),
    });
  }

  function stopDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop sample-stage-dashboard__backdrop" role="presentation">
      {!minimized && (
        <section className="modal sample-stage-dashboard" role="dialog" aria-labelledby="sample-stage-title" style={{ transform: `translate3d(${windowOffset.x}px, ${windowOffset.y}px, 0)` }}>
          <div className="modal__header sample-stage-dashboard__drag-handle" onPointerDown={startDragging} onPointerMove={moveDragging} onPointerUp={stopDragging} onPointerCancel={stopDragging}>
            <div id="sample-stage-title" className="modal__title">{t("sampleStage.title")}</div>
            <div className="sample-stage-dashboard__header-controls">
              <select className="select" value={unit} onChange={(event) => setUnit(event.target.value as StageUnit)} aria-label={t("sampleStage.unit")}>
                <option value="um">µm</option>
                <option value="mm">mm</option>
                <option value="cmm">cmm</option>
              </select>
              <label><span>X</span><NumberStepperInput value={displayValue(targetPosition.x, unit)} min={displayValue(-50, unit)} max={displayValue(50, unit)} onValueChange={(value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return;
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, x: canonicalValue(parsed, unit) }));
              }} ariaLabel="X target" /></label>
              <label><span>Y</span><NumberStepperInput value={displayValue(targetPosition.y, unit)} min={displayValue(-50, unit)} max={displayValue(50, unit)} onValueChange={(value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return;
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, y: canonicalValue(parsed, unit) }));
              }} ariaLabel="Y target" /></label>
              <button type="button" className="btn btn--primary" onClick={() => void moveStage()} disabled={!stageStatus?.connected || stageStatus.moving}>
                {stageStatus?.moving ? t("sampleStage.moving") : t("sampleStage.move")}
              </button>
            </div>
            <div className="sample-stage-dashboard__window-actions">
              <button type="button" className="modal__close" onClick={() => onMinimizedChange(true)} aria-label={t("sampleStage.minimize")} title={t("sampleStage.minimize")}><span aria-hidden>−</span></button>
            </div>
          </div>
          <div className="modal__body sample-stage-dashboard__body">
            <div className="sample-stage-dashboard__surface">
            <div className="canvas-axis-overlay sample-stage-dashboard__background-grid" aria-hidden="true">
              {[0, 25, 50, 75, 100].map((position) => (
                <div key={`stage-grid-x-${position}`} className="canvas-axis-overlay__grid canvas-axis-overlay__grid--x" style={{ left: `${position}%` }} />
              ))}
              {[0, 25, 50, 75, 100].map((position) => (
                <div key={`stage-grid-y-${position}`} className="canvas-axis-overlay__grid canvas-axis-overlay__grid--y" style={{ top: `${position}%` }} />
              ))}
              <div className="canvas-axis-overlay__axis canvas-axis-overlay__axis--x" />
              <div className="canvas-axis-overlay__axis canvas-axis-overlay__axis--y" />
              {Array.from({ length: 21 }, (_, index) => (
                <div
                  key={`stage-tick-x-${index}`}
                  className={`canvas-axis-overlay__tick canvas-axis-overlay__tick--x${index % 5 === 0 ? " canvas-axis-overlay__tick--major" : ""}`}
                  style={{ left: `${index * 5}%` }}
                />
              ))}
              {Array.from({ length: 21 }, (_, index) => (
                <div
                  key={`stage-tick-y-${index}`}
                  className={`canvas-axis-overlay__tick canvas-axis-overlay__tick--y${index % 5 === 0 ? " canvas-axis-overlay__tick--major" : ""}`}
                  style={{ top: `${index * 5}%` }}
                />
              ))}
              {Array.from({ length: 21 }, (_, index) => (
                <span
                  key={`stage-label-x-${index}`}
                  className={`canvas-axis-overlay__value canvas-axis-overlay__value--x sample-stage-dashboard__tick-value${index % 5 === 0 ? " sample-stage-dashboard__tick-value--major" : ""}`}
                  style={{
                    left: `${index * 5}%`,
                    transform: index === 0 ? "translateX(3px)" : index === 20 ? "translateX(calc(-100% - 3px))" : "translateX(-50%)",
                  }}
                >
                  {displayValue(index * 5 - 50, unit)}
                </span>
              ))}
              {Array.from({ length: 21 }, (_, index) => (
                <span
                  key={`stage-label-y-${index}`}
                  className={`canvas-axis-overlay__value canvas-axis-overlay__value--y sample-stage-dashboard__tick-value${index % 5 === 0 ? " sample-stage-dashboard__tick-value--major" : ""}`}
                  style={{
                    top: `${index * 5}%`,
                    transform: index === 0 ? "translateY(3px)" : index === 20 ? "translateY(calc(-100% - 3px))" : "translateY(-50%)",
                  }}
                >
                  {displayValue(50 - index * 5, unit)}
                </span>
              ))}
            </div>
            <div className="sample-stage-dashboard__content">
              <div className="canvas-frame sample-stage-dashboard__canvas-frame">
                <canvas ref={canvasRef} className="sample-stage-dashboard__canvas" aria-label={t("sampleStage.canvas.aria")} />
              </div>
            </div>
            <div className="sample-stage-dashboard__position-line sample-stage-dashboard__position-line--x" style={{ left: `${stagePosition.x + 50}%` }} />
            <div className="sample-stage-dashboard__position-line sample-stage-dashboard__position-line--y" style={{ top: `${50 - stagePosition.y}%` }} />
            <input
              className="sample-stage-dashboard__axis-picker sample-stage-dashboard__axis-picker--x"
              type="range"
              min="-50"
              max="50"
              step="1"
              value={targetPosition.x}
              aria-label={t("sampleStage.axis.x")}
              onChange={(event) => {
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, x: Number(event.target.value) }));
              }}
            />
            <output className="sample-stage-dashboard__axis-value sample-stage-dashboard__axis-value--x" style={{ left: `${targetPosition.x + 50}%` }}>{displayValue(targetPosition.x, unit)} {unitLabel(unit)}</output>
            <input
              className="sample-stage-dashboard__axis-picker sample-stage-dashboard__axis-picker--y"
              type="range"
              min="-50"
              max="50"
              step="1"
              value={targetPosition.y}
              aria-label={t("sampleStage.axis.y")}
              onChange={(event) => {
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, y: Number(event.target.value) }));
              }}
            />
            <output className="sample-stage-dashboard__axis-value sample-stage-dashboard__axis-value--y" style={{ top: `${50 - targetPosition.y}%` }}>{displayValue(targetPosition.y, unit)} {unitLabel(unit)}</output>
            <output className="sample-stage-dashboard__position-readout">X&nbsp;{displayValue(stagePosition.x, unit)} {unitLabel(unit)} <span>·</span> Y&nbsp;{displayValue(stagePosition.y, unit)} {unitLabel(unit)}</output>
            {stageError && <span className="sample-stage-dashboard__error">{stageError}</span>}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
