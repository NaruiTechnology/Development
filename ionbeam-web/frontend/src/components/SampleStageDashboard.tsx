import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import sampleStageImage from "../assets/SampleStage-0.3.png";
import { useTranslation } from "../i18n";

type Props = {
  open: boolean;
  minimized: boolean;
  onMinimizedChange: (minimized: boolean) => void;
  onClose: () => void;
};

export function SampleStageDashboard({ open, minimized, onMinimizedChange, onClose }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [windowOffset, setWindowOffset] = useState({ x: 0, y: 0 });
  const [stagePosition, setStagePosition] = useState({ x: 0, y: 0 });
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
    if (!open) return;
    setWindowOffset({ x: 0, y: 0 });
  }, [open]);

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
    };
  }, [minimized, open, stagePosition]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  function startDragging(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
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
                  {index * 5 - 50}
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
                  {50 - index * 5}
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
              value={stagePosition.x}
              aria-label={t("sampleStage.axis.x")}
              onChange={(event) => setStagePosition((position) => ({ ...position, x: Number(event.target.value) }))}
            />
            <output className="sample-stage-dashboard__axis-value sample-stage-dashboard__axis-value--x" style={{ left: `${stagePosition.x + 50}%` }}>{stagePosition.x}</output>
            <input
              className="sample-stage-dashboard__axis-picker sample-stage-dashboard__axis-picker--y"
              type="range"
              min="-50"
              max="50"
              step="1"
              value={stagePosition.y}
              aria-label={t("sampleStage.axis.y")}
              onChange={(event) => setStagePosition((position) => ({ ...position, y: Number(event.target.value) }))}
            />
            <output className="sample-stage-dashboard__axis-value sample-stage-dashboard__axis-value--y" style={{ top: `${50 - stagePosition.y}%` }}>{stagePosition.y}</output>
            <output className="sample-stage-dashboard__position-readout">X&nbsp;{stagePosition.x} <span>·</span> Y&nbsp;{stagePosition.y}</output>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
