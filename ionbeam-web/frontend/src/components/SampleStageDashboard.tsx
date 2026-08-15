import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import sampleStageImage from "../assets/SampleStage-0.3.png";
import { useTranslation } from "../i18n";
import { apiUrl } from "../lib/backendUrl";
import { NumberStepperInput } from "./NumberStepperField";

type StagePosition = { x: number; y: number; z: number; t: number; r: number };
type AxisLimit = { minimum: number; maximum: number };

type StageStatus = {
  connected: boolean;
  simulation: boolean;
  position: StagePosition;
  limits: Record<keyof StagePosition, AxisLimit>;
  axes?: Partial<Record<keyof StagePosition, {
    unit?: string;
    continuous?: boolean;
    resolution?: number;
    resolution_micrometers?: number | null;
  }>>;
  moving: boolean;
  last_error: string | null;
};

type StageStatusResponse = Omit<StageStatus, "position" | "limits"> & {
  position: Partial<StagePosition>;
  limits: Partial<Record<keyof StagePosition, AxisLimit>>;
};

const ZERO_POSITION: StagePosition = { x: 0, y: 0, z: 0, t: 0, r: 0 };

function normalizeStageStatus(status: StageStatusResponse, fallback: StagePosition = ZERO_POSITION): StageStatus {
  return {
    ...status,
    position: {
      x: status.position.x ?? fallback.x,
      y: status.position.y ?? fallback.y,
      z: status.position.z ?? fallback.z,
      t: status.position.t ?? fallback.t,
      r: status.position.r ?? fallback.r,
    },
    limits: {
      x: status.limits.x ?? { minimum: -75000, maximum: 75000 },
      y: status.limits.y ?? { minimum: -75000, maximum: 75000 },
      z: status.limits.z ?? { minimum: 0, maximum: 10000 },
      t: status.limits.t ?? { minimum: -10, maximum: 60 },
      r: status.limits.r ?? { minimum: -180, maximum: 180 },
    },
  };
}

function displayMicrometers(micrometers: number): number {
  return Number(micrometers.toFixed(4));
}

function canonicalMicrometers(value: number): number {
  return value;
}

function micrometerStep(status: StageStatus | null, axis: "x" | "y" | "z"): number {
  return status?.axes?.[axis]?.resolution_micrometers ?? 1;
}

function axisPercent(value: number, limit: AxisLimit, invert = false): number {
  const percent = Math.max(0, Math.min(100, ((value - limit.minimum) / (limit.maximum - limit.minimum)) * 100));
  return invert ? 100 - percent : percent;
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
  const stageImageRef = useRef<HTMLImageElement | null>(null);
  const [windowOffset, setWindowOffset] = useState({ x: 0, y: 0 });
  const [stagePosition, setStagePosition] = useState<StagePosition>({ x: 0, y: 0, z: 0, t: 0, r: 0 });
  const [targetPosition, setTargetPosition] = useState<StagePosition>({ x: 0, y: 0, z: 0, t: 0, r: 0 });
  const [stageStatus, setStageStatus] = useState<StageStatus | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [movePending, setMovePending] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const positionEditedRef = useRef(false);
  const animationRef = useRef<number | null>(null);
  const stagePositionRef = useRef<StagePosition>(ZERO_POSITION);
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
        const status = normalizeStageStatus(await response.json() as StageStatusResponse, stagePositionRef.current);
        if (!cancelled) {
          setStageStatus(status);
          if (animationRef.current === null) {
            stagePositionRef.current = status.position;
            setStagePosition(status.position);
          }
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
    const requestedPosition = { ...targetPosition };
    const previousPosition = { ...stagePositionRef.current };
    animateStage(requestedPosition);
    try {
      const response = await fetch(apiUrl("/api/stage/move"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestedPosition),
      });
      const body = await response.json() as StageStatusResponse | { detail?: string };
      if (!response.ok) {
        throw new Error("detail" in body ? body.detail || `HTTP ${response.status}` : `HTTP ${response.status}`);
      }
      const status = normalizeStageStatus(body as StageStatusResponse, requestedPosition);
      setStageStatus(status);
      if (Object.values(status.position).some((value, index) => value !== Object.values(requestedPosition)[index])) {
        animateStage(status.position);
      }
      setTargetPosition(status.position);
      positionEditedRef.current = false;
    } catch (error) {
      animateStage(previousPosition);
      setStageError(error instanceof Error ? error.message : String(error));
    } finally {
      setMovePending(false);
    }
  }

  function animateStage(target: StagePosition) {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    const start = { ...stagePositionRef.current };
    const startedAt = performance.now();
    const duration = 500;
    function frame(now: number) {
      const elapsed = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - elapsed, 3);
      const nextPosition = {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        z: start.z + (target.z - start.z) * eased,
        t: start.t + (target.t - start.t) * eased,
        r: start.r + (target.r - start.r) * eased,
      };
      stagePositionRef.current = nextPosition;
      setStagePosition(nextPosition);
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
    const image = stageImageRef.current ?? new Image();
    stageImageRef.current = image;
    const draw = () => {
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
      const xLimits = stageStatus?.limits.x ?? { minimum: -75000, maximum: 75000 };
      const yLimits = stageStatus?.limits.y ?? { minimum: -75000, maximum: 75000 };
      const xMidpoint = (xLimits.minimum + xLimits.maximum) / 2;
      const yMidpoint = (yLimits.minimum + yLimits.maximum) / 2;
      const x = (bounds.width - width) / 2 + ((stagePosition.x - xMidpoint) / ((xLimits.maximum - xLimits.minimum) / 2)) * xTravel;
      const y = (bounds.height - height) / 2 - ((stagePosition.y - yMidpoint) / ((yLimits.maximum - yLimits.minimum) / 2)) * yTravel;
      const zLimits = stageStatus?.limits.z ?? { minimum: 0, maximum: 10000 };
      const zProgress = axisPercent(stagePosition.z, zLimits) / 100;
      const imageScale = 1 + zProgress * 0.12;
      const tiltRadians = stagePosition.t * Math.PI / 180;
      const rotationRadians = stagePosition.r * Math.PI / 180;
      const projectedHeight = Math.max(0.42, Math.cos(tiltRadians));
      const tiltShear = Math.sin(tiltRadians) * 0.16;

      // Transform the stage image itself while leaving the XY grid and origin
      // guides fixed. Every requestAnimationFrame redraw therefore presents
      // visible Z lift, T pitch, and continuous R rotation.
      context.save();
      context.translate(x + width / 2, y + height / 2 - zProgress * 64);
      context.rotate(rotationRadians);
      context.scale(imageScale, imageScale);
      context.transform(1, tiltShear, 0, projectedHeight, 0, 0);
      context.drawImage(image, -width / 2, -height / 2, width, height);
      context.restore();

      // Draw the positive Cartesian axes after the image so browser stacking
      // contexts cannot hide the origin guides behind the canvas.
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
    if (!image.src) image.src = sampleStageImage;
    if (image.complete && image.naturalWidth > 0) draw();
    else {
      image.onload = draw;
    }
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

  const zLimit = stageStatus?.limits.z ?? { minimum: 0, maximum: 10000 };
  const tiltLimit = stageStatus?.limits.t ?? { minimum: -10, maximum: 60 };
  const xLimit = stageStatus?.limits.x ?? { minimum: -75000, maximum: 75000 };
  const yLimit = stageStatus?.limits.y ?? { minimum: -75000, maximum: 75000 };
  const rotationContinuous = stageStatus?.axes?.r?.continuous ?? true;
  const zProgress = axisPercent(stagePosition.z, zLimit) / 100;
  return (
    <div className="modal-backdrop sample-stage-dashboard__backdrop" role="presentation">
      {!minimized && (
        <section className="modal sample-stage-dashboard" role="dialog" aria-labelledby="sample-stage-title" style={{ transform: `translate3d(${windowOffset.x}px, ${windowOffset.y}px, 0)` }}>
          <div className="modal__header sample-stage-dashboard__drag-handle" onPointerDown={startDragging} onPointerMove={moveDragging} onPointerUp={stopDragging} onPointerCancel={stopDragging}>
            <div id="sample-stage-title" className="modal__title">{t("sampleStage.title")}</div>
            <div className="sample-stage-dashboard__header-controls">
              <label><span>X µm</span><NumberStepperInput value={displayMicrometers(targetPosition.x)} step={micrometerStep(stageStatus, "x")} min={displayMicrometers(xLimit.minimum)} max={displayMicrometers(xLimit.maximum)} onValueChange={(value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return;
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, x: canonicalMicrometers(parsed) }));
              }} ariaLabel="X target" /></label>
              <label><span>Y µm</span><NumberStepperInput value={displayMicrometers(targetPosition.y)} step={micrometerStep(stageStatus, "y")} min={displayMicrometers(yLimit.minimum)} max={displayMicrometers(yLimit.maximum)} onValueChange={(value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return;
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, y: canonicalMicrometers(parsed) }));
              }} ariaLabel="Y target" /></label>
              <label><span>Z µm</span><NumberStepperInput value={displayMicrometers(targetPosition.z)} step={micrometerStep(stageStatus, "z")} min={displayMicrometers(zLimit.minimum)} max={displayMicrometers(zLimit.maximum)} onValueChange={(value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return;
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, z: canonicalMicrometers(parsed) }));
              }} ariaLabel="Z target" /></label>
              <label><span>T°</span><NumberStepperInput value={targetPosition.t} step={stageStatus?.axes?.t?.resolution ?? 0.1} min={tiltLimit.minimum} max={tiltLimit.maximum} onValueChange={(value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return;
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, t: parsed }));
              }} ariaLabel="Tilt target" /></label>
              <label><span>R°</span><NumberStepperInput value={targetPosition.r} step={stageStatus?.axes?.r?.resolution ?? 0.1} min={rotationContinuous ? undefined : stageStatus?.limits.r.minimum} max={rotationContinuous ? undefined : stageStatus?.limits.r.maximum} onValueChange={(value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return;
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, r: parsed }));
              }} ariaLabel="Rotation target" /></label>
              <button type="button" className="btn btn--primary sample-stage-dashboard__move-button" onClick={() => void moveStage()} disabled={!stageStatus?.connected || stageStatus.moving}>
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
                  {displayMicrometers((stageStatus?.limits.x.minimum ?? -75000) + index * ((stageStatus?.limits.x.maximum ?? 75000) - (stageStatus?.limits.x.minimum ?? -75000)) / 20)}
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
                  {displayMicrometers((stageStatus?.limits.y.maximum ?? 75000) - index * ((stageStatus?.limits.y.maximum ?? 75000) - (stageStatus?.limits.y.minimum ?? -75000)) / 20)}
                </span>
              ))}
            </div>
            <div className="sample-stage-dashboard__content">
              <div className="canvas-frame sample-stage-dashboard__canvas-frame">
                <canvas ref={canvasRef} className="sample-stage-dashboard__canvas" aria-label={t("sampleStage.canvas.aria")} />
              </div>
            </div>
            <div className="sample-stage-dashboard__motion-presentation" aria-label="Sample stage five-axis motion presentation">
              <strong>Sample stage · 5 AXIS</strong>
              <span>X {displayMicrometers(xLimit.minimum)}…{displayMicrometers(xLimit.maximum)} µm · {micrometerStep(stageStatus, "x")} µm</span>
              <span>Y {displayMicrometers(yLimit.minimum)}…{displayMicrometers(yLimit.maximum)} µm · {micrometerStep(stageStatus, "y")} µm</span>
              <span>Z {displayMicrometers(zLimit.minimum)}…{displayMicrometers(zLimit.maximum)} µm</span>
              <span>T {tiltLimit.minimum}°…{tiltLimit.maximum}°</span>
              <span>R {rotationContinuous ? "continuous" : `${stageStatus?.limits.r.minimum}°…${stageStatus?.limits.r.maximum}°`}</span>
              <div className="sample-stage-dashboard__motion-bars" aria-hidden="true">
                <i style={{ "--motion": `${axisPercent(stagePosition.z, zLimit)}%` } as CSSProperties}>Z</i>
                <i style={{ "--motion": `${axisPercent(stagePosition.t, tiltLimit)}%` } as CSSProperties}>T</i>
                <i style={{ "--motion": `${((stagePosition.r % 360) + 360) % 360 / 3.6}%` } as CSSProperties}>R</i>
              </div>
            </div>
            <div className="sample-stage-dashboard__position-line sample-stage-dashboard__position-line--x" style={{ left: `${axisPercent(stagePosition.x, stageStatus?.limits.x ?? { minimum: -75000, maximum: 75000 })}%` }} />
            <div className="sample-stage-dashboard__position-line sample-stage-dashboard__position-line--y" style={{ top: `${axisPercent(stagePosition.y, stageStatus?.limits.y ?? { minimum: -75000, maximum: 75000 }, true)}%` }} />
            <input
              className="sample-stage-dashboard__axis-picker sample-stage-dashboard__axis-picker--x"
              type="range"
              min={stageStatus?.limits.x.minimum ?? -75000}
              max={stageStatus?.limits.x.maximum ?? 75000}
              step="1"
              value={targetPosition.x}
              aria-label={t("sampleStage.axis.x")}
              onChange={(event) => {
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, x: Number(event.target.value) }));
              }}
            />
            <output className="sample-stage-dashboard__axis-value sample-stage-dashboard__axis-value--x" style={{ left: `${axisPercent(targetPosition.x, stageStatus?.limits.x ?? { minimum: -75000, maximum: 75000 })}%` }}>{displayMicrometers(targetPosition.x)} µm</output>
            <input
              className="sample-stage-dashboard__axis-picker sample-stage-dashboard__axis-picker--y"
              type="range"
              min={stageStatus?.limits.y.minimum ?? -75000}
              max={stageStatus?.limits.y.maximum ?? 75000}
              step="1"
              value={targetPosition.y}
              aria-label={t("sampleStage.axis.y")}
              onChange={(event) => {
                positionEditedRef.current = true;
                setTargetPosition((position) => ({ ...position, y: Number(event.target.value) }));
              }}
            />
            <output className="sample-stage-dashboard__axis-value sample-stage-dashboard__axis-value--y" style={{ top: `${axisPercent(targetPosition.y, stageStatus?.limits.y ?? { minimum: -75000, maximum: 75000 }, true)}%` }}>{displayMicrometers(targetPosition.y)} µm</output>
            <div className="sample-stage-dashboard__motion-cluster">
              <svg className="sample-stage-dashboard__kinematic" viewBox="0 0 178 142" role="img" aria-label={`Z ${displayMicrometers(stagePosition.z)} micrometers, tilt ${stagePosition.t.toFixed(2)} degrees, rotation ${stagePosition.r.toFixed(2)} degrees`}>
                <defs>
                  <linearGradient id="stage-pedestal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#558aa3" />
                    <stop offset="1" stopColor="#0a1e2c" />
                  </linearGradient>
                  <radialGradient id="stage-platter">
                    <stop offset="0" stopColor="#66c9e7" />
                    <stop offset="0.7" stopColor="#17475e" />
                    <stop offset="1" stopColor="#071824" />
                  </radialGradient>
                </defs>

                <g className="sample-stage-dashboard__svg-z-scale">
                  <text x="8" y="13">Z</text>
                  <line x1="14" y1="22" x2="14" y2="111" />
                  {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
                    <line key={fraction} x1="10" y1={111 - fraction * 89} x2="20" y2={111 - fraction * 89} />
                  ))}
                  <line className="sample-stage-dashboard__svg-z-marker" x1="8" y1={88 - zProgress * 64} x2="62" y2={88 - zProgress * 64} />
                  <text x="21" y={83 - zProgress * 64}>{displayMicrometers(stagePosition.z)} µm</text>
                </g>

                <path className="sample-stage-dashboard__svg-pedestal" d="M62 111 H151 L143 135 H70 Z" />
                <g transform={`translate(0 ${-zProgress * 64})`}>
                  <rect className="sample-stage-dashboard__svg-column" x="94" y="87" width="25" height="31" rx="3" />
                  <g transform={`rotate(${-stagePosition.t * 0.65} 107 88)`}>
                    <path className="sample-stage-dashboard__svg-gimbal" d="M48 83 Q48 55 68 48 M166 83 Q166 55 146 48" />
                    <ellipse className="sample-stage-dashboard__svg-platter-edge" cx="107" cy="78" rx="58" ry="27" />
                    <ellipse className="sample-stage-dashboard__svg-platter" cx="107" cy="72" rx="58" ry="27" />
                    <g transform={`translate(107 72) rotate(${stagePosition.r}) scale(1 0.465)`}>
                      <circle className="sample-stage-dashboard__svg-rim" r="49" />
                      <line className="sample-stage-dashboard__svg-crosshair" x1="-45" y1="0" x2="45" y2="0" />
                      <line className="sample-stage-dashboard__svg-crosshair" x1="0" y1="-23" x2="0" y2="23" />
                      <path className="sample-stage-dashboard__svg-r-arrow" d="M0 -24 L-5 -15 H5 Z" />
                    </g>
                  </g>
                </g>
                <text className="sample-stage-dashboard__svg-axis-label" x="145" y="20">T {stagePosition.t.toFixed(1)}°</text>
                <text className="sample-stage-dashboard__svg-axis-label" x="145" y="32">R {stagePosition.r.toFixed(1)}°</text>
              </svg>
              <output className="sample-stage-dashboard__position-readout">X&nbsp;{displayMicrometers(stagePosition.x)} µm <span>·</span> Y&nbsp;{displayMicrometers(stagePosition.y)} µm <span>·</span> Z&nbsp;{displayMicrometers(stagePosition.z)} µm <span>·</span> T&nbsp;{stagePosition.t.toFixed(2)}° <span>·</span> R&nbsp;{stagePosition.r.toFixed(2)}°</output>
            </div>
            {stageError && <span className="sample-stage-dashboard__error">{stageError}</span>}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
