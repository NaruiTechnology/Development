import { useEffect, useRef, useState } from "react";

import { clearROIImage, clearROISelection, streamReset, updateROI, type ROIState } from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";
import type { ROIRequest } from "../types/api";
import { clearBitmapSelectionCache } from "../lib/bitmapVector";
import { grayScaleSelectionContains, type GrayScaleSelection } from "../lib/grayScaleSelection";
import { stopAllScanActions } from "../hooks/scanActionRegistry";
import {
  ROI_CANVAS_EDGE,
  ROI_VIEWPORT_MIN_SPAN,
  ROI_AXIS_FONT,
  canvasPointToWorld,
  clampCanvasPointToViewport,
  clampViewportCoordinate,
  viewportBounds,
  worldToCanvasX,
  worldToCanvasY,
} from "../lib/roiGeometry";
import { useTranslation, type TranslationApi, type TranslationKey } from "../i18n";
import { Icon } from "./Icon";

type CalibrationHandle = "x-start" | "x-end" | "y-start" | "y-end";

const UNITS = [
  { value: "um", label: "μm" },
  { value: "mm", label: "mm" },
  { value: "cm", label: "cm" },
  { value: "nm", label: "nm" },
];

const ROI_DRAG_THRESHOLD = 8;

export function ROIEditor({
  disabled,
  variant = "all",
  backgroundImageUrl = null,
  lastScanImageUrl = null,
  grayScaleSelection = null,
  grayScaleSkipped = null,
  allowClearRegionWhileDisabled = false,
  liveVectorPreview = false,
  onLoadLastScan,
}: {
  disabled: boolean;
  variant?: "controls" | "canvas" | "all";
  backgroundImageUrl?: string | null;
  lastScanImageUrl?: string | null;
  grayScaleSelection?: GrayScaleSelection;
  grayScaleSkipped?: boolean | null;
  allowClearRegionWhileDisabled?: boolean;
  liveVectorPreview?: boolean;
  onLoadLastScan?: () => void;
}) {
  const dispatch = useAppDispatch();
  const tr = useTranslation();
  const { t } = tr;
  const roi = useAppSelector((s) => s.scan.roi);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const promotedBackgroundRef = useRef<string | null>(null);
  const animatedVectorSamplesRef = useRef(0);
  const [draft, setDraft] = useState<ROIRequest | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [suppressedBackgroundUrl, setSuppressedBackgroundUrl] = useState<string | null>(null);
  const [activeHandle, setActiveHandle] = useState<CalibrationHandle | null>(null);
  const [animatedVectorSamples, setAnimatedVectorSamples] = useState(0);
  const [canvasResetToken, setCanvasResetToken] = useState(0);
  const vectorPhase = useAppSelector((s) => s.scan.phase);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const vectorPattern = useAppSelector((s) => s.image.vectorPattern);
  const vectorCustomPoints = useAppSelector((s) => s.image.vectorCustomPoints);
  const vectorCustomCount = useAppSelector((s) => s.image.vectorCustomCount);
  const bytesReceived = useAppSelector((s) => s.scan.bytesReceived);
  const chunksReceived = useAppSelector((s) => s.scan.chunksReceived);
  const targetLiveVectorSamples = vectorPattern === "custom" && vectorCustomCount > 0
    ? Math.min(vectorCursor, vectorCustomCount)
    : vectorCursor;
  const liveVectorSamples = animatedVectorSamples;
  const liveVectorProgressPct =
    liveVectorPreview && vectorPattern === "custom" && vectorCustomCount > 0
      ? Math.min(100, (liveVectorSamples / vectorCustomCount) * 100)
      : 0;
  const hasLoadedImage = Boolean(roi.imageDataUrl);
  const hasPartialRegion = Boolean(roi.selection);
  const activeSelection = draft ?? roi.selection;
  const roiModeLabel = roi.imageKind === "lastScan"
    ? t("roi.canvasMode.scanPreview")
    : roi.imageKind === "file"
    ? t("roi.canvasMode.loadedPreview")
    : t("roi.canvasMode.selection");
  const imageSourceLabel =
    roi.imageKind === "lastScan"
      ? t("roi.imageSource.lastScan")
      : roi.imageKind === "file"
      ? t("roi.imageSource.loaded")
      : null;
  const backgroundSource =
    backgroundImageUrl && backgroundImageUrl !== suppressedBackgroundUrl
      ? backgroundImageUrl
      : null;
  const imageSource =
    roi.imageKind === "lastScan"
      ? backgroundSource ?? roi.imageDataUrl
      : roi.imageDataUrl ?? backgroundSource;

  useEffect(() => {
    if (!imageSource) {
      imageRef.current = null;
      drawBaseCanvas();
      drawHighlightMask();
      drawAnnotationLayer();
      return;
    }
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      if (vectorPhase === "running") {
        drawBaseCanvas();
        drawHighlightMask();
        drawAnnotationLayer();
        return;
      }
      if (
        backgroundImageUrl &&
        imageSource === backgroundImageUrl &&
        promotedBackgroundRef.current !== backgroundImageUrl
      ) {
        const fillStyle = canvasRef.current
          ? getCssColor(canvasRef.current, "--c-bg-elev", "#11203a")
          : "#11203a";
        const dataUrl = imageToDataUrl(img, fillStyle);
        if (dataUrl) {
          promotedBackgroundRef.current = backgroundImageUrl;
          dispatch(
            updateROI({
              imageName: t("roi.imageName.lastScan"),
              imageDataUrl: dataUrl,
              imageKind: "lastScan",
            })
          );
        }
      }
      drawBaseCanvas();
      drawHighlightMask();
      drawAnnotationLayer();
    };
    img.onerror = () => {
      imageRef.current = null;
      drawBaseCanvas();
      drawHighlightMask();
      drawAnnotationLayer();
    };
    img.src = imageSource;
  }, [backgroundImageUrl, canvasResetToken, dispatch, imageSource, t, vectorPhase]);

  useEffect(() => {
    drawBaseCanvas();
    drawHighlightMask();
    drawLiveVectorOverlay();
    drawAnnotationLayer();
  }, [
    draft,
    grayScaleSelection,
    grayScaleSkipped,
    roi,
    tr.locale,
    liveVectorPreview,
    vectorPhase,
    vectorCursor,
    vectorPattern,
    vectorCustomPoints,
    vectorCustomCount,
    animatedVectorSamples,
    bytesReceived,
    chunksReceived,
  ]);

  useEffect(() => {
    animatedVectorSamplesRef.current = animatedVectorSamples;
  }, [animatedVectorSamples]);

  useEffect(() => {
    if (!liveVectorPreview || vectorPattern !== "custom" || vectorCustomCount <= 0) {
      setAnimatedVectorSamples(0);
      animatedVectorSamplesRef.current = 0;
      return;
    }

    const target = Math.max(0, Math.min(vectorCustomCount, targetLiveVectorSamples));
    const start = animatedVectorSamplesRef.current;
    if (start === target) return;

    let frame = 0;
    let cancelled = false;
    let last = performance.now();

    function tick(now: number) {
      if (cancelled) return;
      const current = animatedVectorSamplesRef.current;
      const elapsed = Math.max(16, now - last);
      last = now;
      const remaining = target - current;
      if (remaining <= 0) {
        if (current !== target) {
          animatedVectorSamplesRef.current = target;
          setAnimatedVectorSamples(target);
        }
        return;
      }

      const step = Math.max(1, Math.ceil((vectorCustomCount / 48) * (elapsed / 16)));
      const next = Math.min(target, current + Math.min(step, remaining));
      animatedVectorSamplesRef.current = next;
      setAnimatedVectorSamples(next);
      if (next < target) {
        frame = window.requestAnimationFrame(tick);
      }
    }

    frame = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [liveVectorPreview, vectorPattern, vectorCustomCount, targetLiveVectorSamples]);

  useEffect(() => {
    if (!dragStartRef.current) {
      setDraft(null);
    }
  }, [roi.selection]);

  useEffect(() => {
    if (!activeHandle) return;
    const handle = activeHandle;

    function onPointerMove(event: PointerEvent) {
      event.preventDefault();
      updateCalibrationViewport(handle, event.clientX, event.clientY);
    }

    function onPointerUp() {
      setActiveHandle(null);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [activeHandle, roi]);

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        clearBitmapSelectionCache();
        setDraft(null);
        setSuppressedBackgroundUrl(null);
        dispatch(clearROISelection());
        dispatch(updateROI({ imageName: file.name, imageDataUrl: reader.result, imageKind: "file" }));
      }
    };
    reader.readAsDataURL(file);
  }

  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const raw = {
      x: clampViewportCoordinate(((e.clientX - r.left) / r.width) * ROI_CANVAS_EDGE, 0, ROI_CANVAS_EDGE),
      y: clampViewportCoordinate(((e.clientY - r.top) / r.height) * ROI_CANVAS_EDGE, 0, ROI_CANVAS_EDGE),
    };
    return clampCanvasPointToViewport(raw, viewportBounds(roi));
  }

  function toDut(point: { x: number; y: number }) {
    return canvasPointToWorld(point, roi, viewportBounds(roi));
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

  function drawBaseCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);

    const img = imageRef.current;
    if (img) {
      ctx.drawImage(img, 0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
    } else {
      ctx.fillStyle = getCssColor(canvas, "--c-bg-elev", "#11203a");
      ctx.fillRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
    }

  }

  function drawHighlightMask() {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);

    const img = imageRef.current;
    const activeSelection = draft ?? roi.selection;
    if (!img || grayScaleSelection === null || !activeSelection || roi.calibration_enabled) {
      return;
    }

    const bounds = viewportBounds(roi);
    const x0 = worldToCanvasX(activeSelection.x_start, roi, bounds);
    const x1 = worldToCanvasX(activeSelection.x_end, roi, bounds);
    const y0 = worldToCanvasY(activeSelection.y_start, roi, bounds);
    const y1 = worldToCanvasY(activeSelection.y_end, roi, bounds);
    const left = Math.max(0, Math.min(x0, x1));
    const top = Math.max(0, Math.min(y0, y1));
    const width = Math.max(0, Math.abs(x1 - x0));
    const height = Math.max(0, Math.abs(y1 - y0));
    if (width <= 0 || height <= 0) return;

    ctx.drawImage(img, 0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
    const image = ctx.getImageData(left, top, width, height);
    const data = image.data;
    const spotMode = grayScaleSkipped === false;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) continue;
      const value = data[i];
      const selected = grayScaleSelectionContains(grayScaleSelection, value);
      if (!selected) {
        data[i + 3] = 0;
        continue;
      }

      const tinted = spotMode
        ? tintBeamHitPixel(data[i], data[i + 1], data[i + 2])
        : tintHighlighterPixel(data[i], data[i + 1], data[i + 2]);
      data[i] = tinted.r;
      data[i + 1] = tinted.g;
      data[i + 2] = tinted.b;
      data[i + 3] = tinted.a;
    }

    ctx.putImageData(image, left, top);
  }

  function drawLiveVectorOverlay() {
    const canvas = liveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
    if (
      !liveVectorPreview ||
      vectorPattern !== "custom" ||
      !vectorCustomPoints ||
      !roi.selection ||
      grayScaleSkipped === null ||
      grayScaleSelection === null
    ) {
      return;
    }

    const limit = Math.min(liveVectorSamples, vectorCustomPoints.length / 2, vectorCustomCount);
    if (limit <= 0) return;

    const pointBounds = pointArrayBounds(vectorCustomPoints);
    const selection = roi.selection;
    const worldXSpan = Math.max(1e-6, selection.x_end - selection.x_start);
    const worldYSpan = Math.max(1e-6, selection.y_end - selection.y_start);
    const pointXSpan = Math.max(1e-6, pointBounds.x1 - pointBounds.x0);
    const pointYSpan = Math.max(1e-6, pointBounds.y1 - pointBounds.y0);
    const sourceCanvas = canvasRef.current;
    const sourceCtx = sourceCanvas?.getContext("2d");
    if (!sourceCanvas || !sourceCtx) return;
    const sourceData = sourceCtx.getImageData(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE).data;
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < limit; i++) {
      const x = vectorCustomPoints[2 * i] | 0;
      const y = vectorCustomPoints[2 * i + 1] | 0;
      const worldX = selection.x_start + ((x - pointBounds.x0) / pointXSpan) * worldXSpan;
      const worldY = selection.y_start + ((y - pointBounds.y0) / pointYSpan) * worldYSpan;
      const canvasX = Math.round(worldToCanvasX(worldX, roi, viewportBounds(roi)));
      const canvasY = Math.round(worldToCanvasY(worldY, roi, viewportBounds(roi)));
      if (canvasX < 0 || canvasX >= ROI_CANVAS_EDGE || canvasY < 0 || canvasY >= ROI_CANVAS_EDGE) continue;
      const srcIdx = (canvasY * ROI_CANVAS_EDGE + canvasX) * 4;
      const value = sourceData[srcIdx] ?? 0;
      const selected = grayScaleSelectionContains(grayScaleSelection, value);
      const beamOn = grayScaleSkipped === false ? selected : !selected;
      if (!beamOn) continue;
      points.push({ x: canvasX, y: canvasY });
    }

    if (points.length === 0) return;

    const dotRadius = Math.max(1.4, Math.min(2.4, ROI_CANVAS_EDGE / 1024));
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(100, 0, 0, 0.5732)";
    ctx.strokeStyle = "rgba(246, 8, 8, 0.44)";
    ctx.lineWidth = 0.75;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      ctx.beginPath();
      ctx.arc(p.x + 0.5, p.y + 0.5, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x + 0.5, last.y + 0.5, dotRadius + 0.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawAnnotationLayer() {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);

    if (roi.calibration_enabled) {
      drawCalibrationViewport(ctx, roi);
    } else {
      ctx.save();
      ctx.strokeStyle = "rgba(95, 184, 255, 0.85)";
      ctx.fillStyle = "rgba(230, 238, 249, 0.92)";
      ctx.lineWidth = 1;
      ctx.font = ROI_AXIS_FONT;
      drawScale(ctx, roi, unitLabel(roi.scale_unit));
      ctx.restore();
    }

    const selected = roi.calibration_enabled ? null : draft ?? roi.selection;
    if (selected) drawSelection(ctx, selected, roi);
  }

  function drawSelection(ctx: CanvasRenderingContext2D, selected: ROIRequest, nextROI: ROIState) {
    const bounds = viewportBounds(nextROI);
    const x0 = worldToCanvasX(selected.x_start, nextROI, bounds);
    const x1 = worldToCanvasX(selected.x_end, nextROI, bounds);
    const y0 = worldToCanvasY(selected.y_start, nextROI, bounds);
    const y1 = worldToCanvasY(selected.y_end, nextROI, bounds);
    ctx.save();
    ctx.strokeStyle = "#ff2d2d";
    ctx.fillStyle = "#ff2d2d";
    ctx.lineWidth = 0.75;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }

  function drawCalibrationViewport(ctx: CanvasRenderingContext2D, nextROI: ROIState) {
    const bounds = viewportBounds(nextROI, "draft");
    ctx.save();
    ctx.fillStyle = "rgba(3, 7, 18, 0.6)";
    ctx.fillRect(0, 0, ROI_CANVAS_EDGE, bounds.top);
    ctx.fillRect(0, bounds.bottom, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE - bounds.bottom);
    ctx.fillRect(0, bounds.top, bounds.left, bounds.height);
    ctx.fillRect(bounds.right, bounds.top, ROI_CANVAS_EDGE - bounds.right, bounds.height);
    ctx.strokeStyle = "lawngreen";
    ctx.lineWidth = 0.2;
    ctx.strokeRect(bounds.left, bounds.top, bounds.width, bounds.height);
    ctx.restore();
  }

  function updateCalibrationViewport(handle: CalibrationHandle, clientX: number, clientY: number) {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const rawX = ((clientX - rect.left) / rect.width) * ROI_CANVAS_EDGE;
    const rawY = ((clientY - rect.top) / rect.height) * ROI_CANVAS_EDGE;

    if (handle === "x-start") {
      dispatch(
        updateROI({
          calibration_viewport_x_start: clampViewportCoordinate(
            rawX,
            0,
            roi.calibration_viewport_x_end - ROI_VIEWPORT_MIN_SPAN
          ),
        })
      );
      return;
    }
    if (handle === "x-end") {
      dispatch(
        updateROI({
          calibration_viewport_x_end: clampViewportCoordinate(
            rawX,
            roi.calibration_viewport_x_start + ROI_VIEWPORT_MIN_SPAN,
            ROI_CANVAS_EDGE
          ),
        })
      );
      return;
    }
    if (handle === "y-start") {
      dispatch(
        updateROI({
          calibration_viewport_y_start: clampViewportCoordinate(
            rawY,
            0,
            roi.calibration_viewport_y_end - ROI_VIEWPORT_MIN_SPAN
          ),
        })
      );
      return;
    }
    dispatch(
      updateROI({
        calibration_viewport_y_end: clampViewportCoordinate(
          rawY,
          roi.calibration_viewport_y_start + ROI_VIEWPORT_MIN_SPAN,
          ROI_CANVAS_EDGE
        ),
      })
    );
  }

  function clearLoadedImage() {
    clearBitmapSelectionCache();
    imageRef.current = null;
    promotedBackgroundRef.current = null;
    setSuppressedBackgroundUrl(backgroundImageUrl);
    if (fileRef.current) {
      fileRef.current.value = "";
    }
    setCanvasResetToken((n) => n + 1);
    dispatch(clearROIImage());
  }

  function clearPartialRegion() {
    clearBitmapSelectionCache();
    stopAllScanActions();
    setDraft(null);
    dispatch(clearROISelection());
    dispatch(streamReset());
  }

  const confirmedBounds = viewportBounds(roi);
  const draftBounds = viewportBounds(roi, "draft");

  return (
    <div>
      {(variant === "controls" || variant === "all") && (
        <>
          <div className="button-row" style={{ marginBottom: 10 }}>
            <button className="btn" disabled={disabled} onClick={() => fileRef.current?.click()}>
              <Icon name="upload" tone="accent" />
              {t("roi.select")}
            </button>
            {lastScanImageUrl && (
              <button
                className="btn btn--ghost"
                disabled={disabled || roi.imageKind === "lastScan"}
                onClick={() => {
                  if (fileRef.current) {
                    fileRef.current.value = "";
                  }
                  onLoadLastScan?.();
                }}
              >
                <Icon name="download" tone="accent" />
                {t("roi.loadLastScan")}
              </button>
            )}
            <button
              className="btn btn--ghost"
              disabled={disabled || !hasLoadedImage}
              onClick={clearLoadedImage}
            >
              <Icon name="trash" tone="danger" />
              {t("roi.clearImage")}
            </button>
            <button
              className="btn btn--ghost"
              disabled={(disabled && !allowClearRegionWhileDisabled) || roi.calibration_enabled || !hasPartialRegion}
              onClick={clearPartialRegion}
            >
              <Icon name="crop" tone="warn" />
              {t("roi.clearRegion")}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>{roi.imageName}</span>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.bmp,.png,.jpg,.jpeg,.svg,.webp"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) loadFile(file);
              }}
            />
          </div>

          <div className="field">
            <label>{t("roi.scaleUnit")}</label>
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

          {!roi.calibration_enabled ? (
            <>
              <div className="field-row">
                <Num
                  labelKey="roi.xOrigin"
                  value={roi.x_origin}
                  disabled={disabled}
                  validate={(value) =>
                    value < roi.x_end
                      ? null
                      : t("roi.error.xOriginBeforeEnd", { end: formatOneDecimal(roi.x_end) })
                  }
                  onChange={(value) => {
                    clearBitmapSelectionCache();
                    dispatch(updateROI({ x_origin: value, calibration_x_origin: value }));
                  }}
                />
                <Num
                  labelKey="roi.xEnd"
                  value={roi.x_end}
                  disabled={disabled}
                  validate={(value) =>
                    value > roi.x_origin
                      ? null
                      : t("roi.error.xEndAfterOrigin", { origin: formatOneDecimal(roi.x_origin) })
                  }
                  onChange={(value) => {
                    clearBitmapSelectionCache();
                    dispatch(updateROI({ x_end: value, calibration_x_end: value }));
                  }}
                />
              </div>
              <div className="field-row">
                <Num
                  labelKey="roi.yOrigin"
                  value={roi.y_origin}
                  disabled={disabled}
                  validate={(value) =>
                    value < roi.y_end
                      ? null
                      : t("roi.error.yOriginBeforeEnd", { end: formatOneDecimal(roi.y_end) })
                  }
                  onChange={(value) => {
                    clearBitmapSelectionCache();
                    dispatch(updateROI({ y_origin: value, calibration_y_origin: value }));
                  }}
                />
                <Num
                  labelKey="roi.yEnd"
                  value={roi.y_end}
                  disabled={disabled}
                  validate={(value) =>
                    value > roi.y_origin
                      ? null
                      : t("roi.error.yEndAfterOrigin", { origin: formatOneDecimal(roi.y_origin) })
                  }
                  onChange={(value) => {
                    clearBitmapSelectionCache();
                    dispatch(updateROI({ y_end: value, calibration_y_end: value }));
                  }}
                />
              </div>

              <div className="field-row">
                <CoordinateField
                  labelKey="roi.start"
                  value={selectionStart(roi)}
                  disabled={disabled}
                  validate={(p) => validateStartPoint(p, roi, tr)}
                  onChange={(p) => {
                    const end = selectionEnd(roi);
                    clearBitmapSelectionCache();
                    dispatch(
                      updateROI({
                        selection: {
                          x_start: p.x,
                          y_start: p.y,
                          x_end: end.x,
                          y_end: end.y,
                        },
                      })
                    );
                  }}
                />
                <CoordinateField
                  labelKey="roi.end"
                  value={selectionEnd(roi)}
                  disabled={disabled}
                  validate={(p) => validateEndPoint(p, roi, tr)}
                  onChange={(p) => {
                    const start = selectionStart(roi);
                    clearBitmapSelectionCache();
                    dispatch(
                      updateROI({
                        selection: {
                          x_start: start.x,
                          y_start: start.y,
                          x_end: p.x,
                          y_end: p.y,
                        },
                      })
                    );
                  }}
                />
              </div>

              {activeSelection && (
                <div className="muted roi-dac-readout">
                  {(() => {
                    const startX = Math.min(activeSelection.x_start, activeSelection.x_end);
                    const endX = Math.max(activeSelection.x_start, activeSelection.x_end);
                    const widthX = Math.abs(activeSelection.x_end - activeSelection.x_start);
                    const unit = unitLabel(roi.scale_unit);
                    return (
                      <>
                        {t("roi.selectionExtent")}&nbsp;
                        S({formatOneDecimal(startX)} {unit}) → E({formatOneDecimal(endX)} {unit})
                        &nbsp;<span style={{ opacity: 0.7 }}>
                          w : {formatOneDecimal(widthX)} {unit}
                        </span>
                      </>
                    );
                  })()}
                </div>
              )}
            </>
          ) : (
            <div className="roi-calibration-note">{t("roi.calibration.pending")}</div>
          )}
        </>
      )}

      {(variant === "canvas" || variant === "all") && (
        <div ref={canvasWrapRef} className={`roi-canvas-wrap${roi.calibration_enabled ? " roi-canvas-wrap--calibrating" : ""}`}>
          <div className="roi-canvas-mode" aria-live="polite">
            {!roi.calibration_enabled && <span className="roi-source-pill">{roiModeLabel}</span>}
          </div>
          {imageSourceLabel && (
            <div className="roi-canvas-source" aria-live="polite">
              <span className="roi-source-pill">{imageSourceLabel}</span>
            </div>
          )}
          <canvas
            ref={canvasRef}
            className={`roi-canvas-layer roi-canvas-layer--base${disabled ? " is-disabled" : ""}`}
            width={ROI_CANVAS_EDGE}
            height={ROI_CANVAS_EDGE}
            onPointerDown={(e) => {
              if (disabled || roi.calibration_enabled) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = canvasPoint(e);
              dragStartRef.current = p;
              setDraft(null);
              const d = toDut(p);
              setTip({ x: e.clientX, y: e.clientY, text: `(${d.x}, ${d.y})` });
            }}
            onPointerMove={(e) => {
              if (disabled || roi.calibration_enabled) return;
              e.preventDefault();
              const p = canvasPoint(e);
              const d = toDut(p);
              if (dragStartRef.current) {
                const dx = Math.abs(p.x - dragStartRef.current.x);
                const dy = Math.abs(p.y - dragStartRef.current.y);
                if (Math.max(dx, dy) >= ROI_DRAG_THRESHOLD / ROI_CANVAS_EDGE) {
                  const next = rectFromPoints(dragStartRef.current, p);
                  setDraft(next);
                }
                setTip({ x: e.clientX, y: e.clientY, text: `(${d.x}, ${d.y})` });
              }
            }}
            onPointerUp={(e) => {
              if (disabled || roi.calibration_enabled) return;
              e.preventDefault();
              const start = dragStartRef.current;
              if (!start) return;
              const nextPoint = canvasPoint(e);
              const dx = Math.abs(nextPoint.x - start.x);
              const dy = Math.abs(nextPoint.y - start.y);
              const didDrag = Math.max(dx, dy) >= ROI_DRAG_THRESHOLD / ROI_CANVAS_EDGE;
              dragStartRef.current = null;
              setDraft(null);
              if (!didDrag) {
                setTip(null);
                return;
              }
              const next = rectFromPoints(start, nextPoint);
              clearBitmapSelectionCache();
              dispatch(updateROI({ selection: next }));
              setTip(null);
            }}
            onPointerLeave={() => {
              dragStartRef.current = null;
              setDraft(null);
              setTip(null);
            }}
          />
          <canvas
            ref={maskCanvasRef}
            className="roi-canvas-layer roi-canvas-layer--mask"
            width={ROI_CANVAS_EDGE}
            height={ROI_CANVAS_EDGE}
            aria-hidden="true"
          />
          <canvas
            ref={liveCanvasRef}
            className="roi-canvas-layer roi-canvas-layer--live"
            width={ROI_CANVAS_EDGE}
            height={ROI_CANVAS_EDGE}
            aria-hidden="true"
          />
          <canvas
            ref={annotationCanvasRef}
            className="roi-canvas-layer roi-canvas-layer--annotation"
            width={ROI_CANVAS_EDGE}
            height={ROI_CANVAS_EDGE}
            aria-hidden="true"
          />
          {!roi.calibration_enabled && <ROIAxisOverlay roi={roi} />}
          {roi.calibration_enabled && (
            <ROICalibrationAxisOverlay roi={roi} showGrid={roi.show_grid} />
          )}
          {roi.calibration_enabled && (
            <>
              <div className="roi-calibration-ruler roi-calibration-ruler--top">
                <div
                  className="roi-calibration-ruler__track"
                  style={{ left: `${draftBounds.left / ROI_CANVAS_EDGE * 100}%`, width: `${draftBounds.width / ROI_CANVAS_EDGE * 100}%` }}
                />
                <button
                  className="roi-calibration-handle roi-calibration-handle--top"
                  style={{ left: `${draftBounds.left / ROI_CANVAS_EDGE * 100}%` }}
                  disabled={disabled}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    setActiveHandle("x-start");
                  }}
                  aria-label={t("roi.xOrigin")}
                />
                <span
                  className="roi-calibration-handle-value roi-calibration-handle-value--top-start"
                  style={{ left: `${draftBounds.left / ROI_CANVAS_EDGE * 100}%` }}
                >
                  {formatDimensionValue(calibrationXValueAt(roi, draftBounds.left), roi.scale_unit)}
                </span>
                <button
                  className="roi-calibration-handle roi-calibration-handle--top roi-calibration-handle--end"
                  style={{ left: `${draftBounds.right / ROI_CANVAS_EDGE * 100}%` }}
                  disabled={disabled}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    setActiveHandle("x-end");
                  }}
                  aria-label={t("roi.xEnd")}
                />
                <span
                  className="roi-calibration-handle-value roi-calibration-handle-value--top-end"
                  style={{ left: `${draftBounds.right / ROI_CANVAS_EDGE * 100}%` }}
                >
                  {formatDimensionValue(calibrationXValueAt(roi, draftBounds.right), roi.scale_unit)}
                </span>
              </div>
              <div className="roi-calibration-ruler roi-calibration-ruler--left">
                <div
                  className="roi-calibration-ruler__track roi-calibration-ruler__track--vertical"
                  style={{ top: `${draftBounds.top / ROI_CANVAS_EDGE * 100}%`, height: `${draftBounds.height / ROI_CANVAS_EDGE * 100}%` }}
                />
                <button
                  className="roi-calibration-handle roi-calibration-handle--left"
                  style={{ top: `${draftBounds.top / ROI_CANVAS_EDGE * 100}%` }}
                  disabled={disabled}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    setActiveHandle("y-start");
                  }}
                  aria-label={t("roi.yOrigin")}
                />
                <span
                  className="roi-calibration-handle-value roi-calibration-handle-value--left-start"
                  style={{ top: `${draftBounds.top / ROI_CANVAS_EDGE * 100}%` }}
                >
                  {formatDimensionValue(calibrationYValueAt(roi, draftBounds.top), roi.scale_unit)}
                </span>
                <button
                  className="roi-calibration-handle roi-calibration-handle--left roi-calibration-handle--end"
                  style={{ top: `${draftBounds.bottom / ROI_CANVAS_EDGE * 100}%` }}
                  disabled={disabled}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    setActiveHandle("y-end");
                  }}
                  aria-label={t("roi.yEnd")}
                />
                <span
                  className="roi-calibration-handle-value roi-calibration-handle-value--left-end"
                  style={{ top: `${draftBounds.bottom / ROI_CANVAS_EDGE * 100}%` }}
                >
                  {formatDimensionValue(calibrationYValueAt(roi, draftBounds.bottom), roi.scale_unit)}
                </span>
              </div>
              <span
                className="roi-calibration-span-value roi-calibration-span-value--top"
                style={{
                  left: `${(draftBounds.left + draftBounds.width / 2) / ROI_CANVAS_EDGE * 100}%`,
                  top: `${(draftBounds.top + 8) / ROI_CANVAS_EDGE * 100}%`,
                }}
              >
                {formatAxisSpanLabel(
                  "w",
                  Math.abs(calibrationXValueAt(roi, draftBounds.right) - calibrationXValueAt(roi, draftBounds.left)),
                  roi.scale_unit
                )}
              </span>
              <span
                className="roi-calibration-span-value roi-calibration-span-value--left"
                style={{
                  left: `${Math.max(0, draftBounds.left - 2) / ROI_CANVAS_EDGE * 100}%`,
                  top: `${(draftBounds.top + draftBounds.height / 2) / ROI_CANVAS_EDGE * 100}%`,
                }}
              >
                {formatAxisSpanLabel(
                  "h",
                  Math.abs(calibrationYValueAt(roi, draftBounds.bottom) - calibrationYValueAt(roi, draftBounds.top)),
                  roi.scale_unit
                )}
              </span>
            </>
          )}
          {!roi.calibration_enabled && confirmedBounds.width > 0 && confirmedBounds.height > 0 && (
            <div
              className="roi-canvas-viewport"
              style={{
                left: `${confirmedBounds.left / ROI_CANVAS_EDGE * 100}%`,
                top: `${confirmedBounds.top / ROI_CANVAS_EDGE * 100}%`,
                width: `${confirmedBounds.width / ROI_CANVAS_EDGE * 100}%`,
                height: `${confirmedBounds.height / ROI_CANVAS_EDGE * 100}%`,
              }}
            />
          )}
          {tip && (
            <div className="roi-tooltip" style={{ left: tip.x + 10, top: tip.y + 10 }}>
              {tip.text}
            </div>
          )}
          {liveVectorPreview && (
            <>
              <div className="progress roi-canvas-progress">
                <span
                  style={{
                    width: `${liveVectorProgressPct}%`,
                  }}
                />
              </div>
              <div className="canvas-meta roi-canvas-meta">
                <span>
                  {t("canvas.meta.phase")} <b>{t(`phase.${vectorPhase}` as TranslationKey)}</b>
                </span>
                <span>
                  {t("canvas.meta.chunks")} <b>{formatCount(chunksReceived)}</b>
                </span>
                <span>
                  {t("canvas.meta.bytes")} <b>{formatCount(bytesReceived)}</b>
                </span>
                <span>
                  {t("canvas.meta.samples")}{" "}
                  <b>
                    {formatCount(liveVectorSamples)}
                    {vectorPattern === "custom" && vectorCustomCount > 0 ? ` / ${formatCount(vectorCustomCount)}` : ""}
                  </b>
                </span>
                <span>
                  {t("canvas.meta.progress")} <b>{Math.round(liveVectorProgressPct)}%</b>
                </span>
              </div>
            </>
          )}
          {!roi.calibration_enabled && grayScaleSelection !== null && grayScaleSkipped === false && (
            <div className="roi-beam-legend" aria-live="polite">
              <span className="roi-beam-legend__swatch" />
              <span>Spot beam-on pixels</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function imageToDataUrl(img: HTMLImageElement, fillStyle = "#11203a"): string | null {
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (width <= 0 || height <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    ctx.fillStyle = fillStyle;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function getCssColor(el: Element, variable: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(variable).trim();
  return value || fallback;
}

function tintHighlighterPixel(
  r: number,
  g: number,
  b: number
): { r: number; g: number; b: number; a: number } {
  const opacity = 0.78;
  const hl = { r: 255, g: 255, b: 72 };
  return tintPixel(r, g, b, hl, opacity);
}

function tintBeamHitPixel(
  r: number,
  g: number,
  b: number
): { r: number; g: number; b: number; a: number } {
  const opacity = 0.96;
  const hl = { r: 255, g: 236, b: 96 };
  return tintPixel(r, g, b, hl, opacity);
}

function tintPixel(
  r: number,
  g: number,
  b: number,
  hl: { r: number; g: number; b: number },
  opacity: number
): { r: number; g: number; b: number; a: number } {
  return {
    r: Math.max(0, Math.min(255, Math.round(r * (1 - opacity) + hl.r * opacity))),
    g: Math.max(0, Math.min(255, Math.round(g * (1 - opacity) + hl.g * opacity))),
    b: Math.max(0, Math.min(255, Math.round(b * (1 - opacity) + hl.b * opacity))),
    a: Math.round(255 * opacity),
  };
}

function Num(props: {
  labelKey: TranslationKey;
  value: number;
  disabled: boolean;
  validate: (value: number) => string | null;
  onChange: (v: number) => void;
}) {
  const { t } = useTranslation();
  const label = t(props.labelKey);
  const [text, setText] = useState(formatOneDecimal(props.value));
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    setText(formatOneDecimal(props.value));
    setWarning(null);
  }, [props.value]);

  function commit(next: string) {
    setText(next);
    if (next === "") {
      setWarning(t("roi.error.pointValueRequired", { label }));
      return;
    }

    const parsed = Number(next);
    if (!Number.isFinite(parsed) || !hasAtMostOneDecimal(next)) {
      setWarning(t("roi.error.pointValueRequired", { label }));
      return;
    }

    const validation = props.validate(parsed);
    if (validation) {
      setWarning(validation);
      return;
    }

    setWarning(null);
    setText(formatOneDecimal(parsed));
    props.onChange(parsed);
  }

  return (
    <div className="field">
      <label>{label}</label>
      <input
        className={`input${warning ? " input--invalid" : ""}`}
        type="number"
        step={0.1}
        value={text}
        disabled={props.disabled}
        aria-invalid={warning ? "true" : "false"}
        onChange={(e) => commit(e.target.value)}
      />
      {warning && <div className="field-warning">{warning}</div>}
    </div>
  );
}

function CoordinateField(props: {
  labelKey: TranslationKey;
  value: { x: number; y: number };
  disabled: boolean;
  validate: (p: { x: number; y: number }) => string | null;
  onChange: (p: { x: number; y: number }) => void;
}) {
  const { t } = useTranslation();
  const label = t(props.labelKey);
  const [text, setText] = useState(formatPointText(props.value));
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    setText(formatPointText(props.value));
    setWarning(null);
  }, [props.value.x, props.value.y]);

  function commit(next: string) {
    setText(next);
    const parsed = parsePointText(next);
    if (!parsed) {
      setWarning(t("roi.error.pointFormat", { label }));
      return;
    }

    const validation = props.validate(parsed);
    if (validation) {
      setWarning(validation);
      return;
    }

    setWarning(null);
    props.onChange(parsed);
  }

  return (
    <div className="field">
      <label>{label}</label>
      <input
        className={`input${warning ? " input--invalid" : ""}`}
        value={text}
        disabled={props.disabled}
        aria-invalid={warning ? "true" : "false"}
        onChange={(e) => commit(e.target.value)}
      />
      {warning && <div className="field-warning">{warning}</div>}
    </div>
  );
}

function unitLabel(value: string) {
  return UNITS.find((u) => u.value === value)?.label ?? value;
}

function formatDimensionValue(value: number, unit: string) {
  return `${formatOneDecimal(value)} ${unitLabel(unit)}`;
}

function formatAxisSpanLabel(axis: "w" | "h", value: number, unit: string) {
  return `${axis.toUpperCase()} : ${formatDimensionValue(value, unit)}`;
}

function formatCount(value: number) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0";
}

function pointArrayBounds(points: Float32Array): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) {
    return { x0: 0, x1: 1, y0: 0, y1: 1 };
  }
  return { x0, x1, y0, y1 };
}

function calibrationXValueAt(roi: ROIState, canvasX: number) {
  return interpolateCanvasPosition(
    canvasX,
    roi.calibration_x_origin,
    roi.calibration_x_end
  );
}

function calibrationYValueAt(roi: ROIState, canvasY: number) {
  return interpolateCanvasPosition(
    canvasY,
    roi.calibration_y_origin,
    roi.calibration_y_end
  );
}

function interpolateCanvasPosition(position: number, start: number, end: number) {
  const t = Math.min(1, Math.max(0, position / ROI_CANVAS_EDGE));
  return start + (end - start) * t;
}

function drawScale(
  ctx: CanvasRenderingContext2D,
  roi: ROIState,
  unit: string,
) {
  const bounds = viewportBounds(roi);
  const major = 4;
  const minorPerMajor = 5;
  const minorTicks = major * minorPerMajor;

  ctx.save();
  ctx.strokeStyle = "rgba(95, 184, 255, 0.9)";
  ctx.lineWidth = 1;
  ctx.font = ROI_AXIS_FONT;

  ctx.beginPath();
  ctx.moveTo(bounds.left, bounds.top);
  ctx.lineTo(bounds.right, bounds.top);
  ctx.moveTo(bounds.left, bounds.top);
  ctx.lineTo(bounds.left, bounds.bottom);
  ctx.stroke();

  for (let i = 0; i <= minorTicks; i++) {
    const isMajor = i % minorPerMajor === 0;
    const t = i / minorTicks;
    const x = bounds.left + bounds.width * t;
    const y = bounds.top + bounds.height * t;
    const len = isMajor ? 10 : 5;
    ctx.beginPath();
    ctx.moveTo(x, bounds.top);
    ctx.lineTo(x, bounds.top + len);
    ctx.moveTo(bounds.left, y);
    ctx.lineTo(bounds.left + len, y);
    ctx.stroke();

    if (roi.show_grid && isMajor) {
      ctx.save();
      ctx.fillStyle = "rgba(95, 184, 255, 0.14)";
      ctx.fillRect(x - 0.5, bounds.top, 1, bounds.height);
      ctx.fillRect(bounds.left, y - 0.5, bounds.width, 1);
      ctx.restore();
    }
  }
  ctx.restore();
}

function ROIAxisOverlay({ roi }: { roi: ROIState }) {
  const { t } = useTranslation();
  const ticks = Array.from({ length: 21 }, (_, i) => {
    const ratio = i / 20;
    return {
      key: i,
      ratio,
      major: i % 5 === 0,
      xLabel: formatOneDecimal(roi.x_origin + (roi.x_end - roi.x_origin) * ratio),
      yLabel: formatOneDecimal(roi.y_origin + (roi.y_end - roi.y_origin) * ratio),
    };
  });

  return (
    <div className="canvas-axis-overlay" aria-hidden="true">
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`x-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--x"
          style={{ left: `${tick.ratio * 100}%` }}
        >
          {tick.xLabel}
        </span>
      ))}
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`y-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--y"
          style={{ top: `${tick.ratio * 100}%` }}
        >
          {tick.yLabel}
        </span>
      ))}
      <span className="canvas-axis-overlay__label canvas-axis-overlay__label--start">
        {t("roi.canvas.start", {
          point: `(${formatOneDecimal(roi.x_origin)}, ${formatOneDecimal(roi.y_origin)})`,
          unit: unitLabel(roi.scale_unit),
        })}
      </span>
      <span className="canvas-axis-overlay__label canvas-axis-overlay__label--end">
        {t("roi.canvas.end", {
          point: `(${formatOneDecimal(roi.x_end)}, ${formatOneDecimal(roi.y_end)})`,
          unit: unitLabel(roi.scale_unit),
        })}
      </span>
    </div>
  );
}

function ROICalibrationAxisOverlay({
  roi,
  showGrid,
}: {
  roi: ROIState;
  showGrid: boolean;
}) {
  const { t } = useTranslation();
  const draftBounds = viewportBounds(roi, "draft");
  const ticks = Array.from({ length: 21 }, (_, i) => {
    const ratio = i / 20;
    return {
      key: i,
      ratio,
      major: i % 5 === 0,
      xLabel: `${Math.round(ratio * 100)}%`,
      yLabel: `${Math.round(ratio * 100)}%`,
      x: `${ratio * 100}%`,
      y: `${ratio * 100}%`,
    };
  });

  return (
    <div className="canvas-axis-overlay" aria-hidden="true">
      {showGrid &&
        ticks.filter((tick) => tick.major).map((tick) => (
          <span
            key={`grid-x-${tick.key}`}
            className="canvas-axis-overlay__grid canvas-axis-overlay__grid--x"
            style={{
              left: tick.x,
              top: "0%",
              height: "100%",
            }}
          />
        ))}
      {showGrid &&
        ticks.filter((tick) => tick.major).map((tick) => (
          <span
            key={`grid-y-${tick.key}`}
            className="canvas-axis-overlay__grid canvas-axis-overlay__grid--y"
            style={{
              left: "0%",
              top: tick.y,
              width: "100%",
            }}
          />
        ))}
      <span
        className="canvas-axis-overlay__axis canvas-axis-overlay__axis--x"
        style={{ left: "0%", top: "0%", width: "100%" }}
      />
      <span
        className="canvas-axis-overlay__axis canvas-axis-overlay__axis--y"
        style={{ left: "0%", top: "0%", height: "100%" }}
      />
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`tick-x-${tick.key}`}
          className="canvas-axis-overlay__tick canvas-axis-overlay__tick--x canvas-axis-overlay__tick--major"
          style={{ left: tick.x, top: "0%" }}
        />
      ))}
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`tick-y-${tick.key}`}
          className="canvas-axis-overlay__tick canvas-axis-overlay__tick--y canvas-axis-overlay__tick--major"
          style={{ left: "0%", top: tick.y }}
        />
      ))}
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`x-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--x"
          style={{ left: tick.x, top: "16px" }}
        >
          {tick.xLabel}
        </span>
      ))}
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`y-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--y"
          style={{ left: "14px", top: tick.y }}
        >
          {tick.yLabel}
        </span>
      ))}
      <span
        className="canvas-axis-overlay__label canvas-axis-overlay__label--start"
        style={{
          left: "12px",
          top: "12px",
          right: "auto",
          bottom: "auto",
        }}
      >
        {t("roi.canvas.start", {
          point: `(${formatOneDecimal(roi.calibration_x_origin)}, ${formatOneDecimal(roi.calibration_y_origin)})`,
          unit: unitLabel(roi.scale_unit),
        })}
      </span>
      <span
        className="canvas-axis-overlay__label canvas-axis-overlay__label--end"
        style={{
          left: "12px",
          top: "34px",
          right: "auto",
          bottom: "auto",
          transform: "none",
        }}
      >
        {t("roi.canvas.end", {
          point: `(${formatOneDecimal(roi.calibration_x_end)}, ${formatOneDecimal(roi.calibration_y_end)})`,
          unit: unitLabel(roi.scale_unit),
        })}
      </span>
    </div>
  );
}

function selectionStart(roi: ROIState) {
  const r = roi.selection;
  return r ? { x: r.x_start, y: r.y_start } : { x: roi.x_origin, y: roi.y_origin };
}

function selectionEnd(roi: ROIState) {
  const r = roi.selection;
  return r ? { x: r.x_end, y: r.y_end } : { x: roi.x_end, y: roi.y_end };
}

function formatPointText(p: { x: number; y: number }) {
  return `(${formatOneDecimal(p.x)}, ${formatOneDecimal(p.y)})`;
}

function parsePointText(text: string): { x: number; y: number } | null {
  const cleaned = text.trim().replace(/[()]/g, "");
  const parts = cleaned.split(/[,\s]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!hasAtMostOneDecimal(parts[0]) || !hasAtMostOneDecimal(parts[1])) return null;
  return { x, y };
}

function validateStartPoint(
  p: { x: number; y: number },
  roi: ROIState,
  tr: TranslationApi,
): string | null {
  const { t } = tr;
  const end = selectionEnd(roi);
  const xLo = Math.min(roi.x_origin, roi.x_end);
  const xHi = Math.max(roi.x_origin, roi.x_end);
  const yLo = Math.min(roi.y_origin, roi.y_end);
  const yHi = Math.max(roi.y_origin, roi.y_end);
  if (p.x < xLo || p.x > xHi) {
    return t("roi.error.startXBounds", { origin: roi.x_origin, end: roi.x_end });
  }
  if (p.y < yLo || p.y > yHi) {
    return t("roi.error.startYBounds", { origin: roi.y_origin, end: roi.y_end });
  }
  if (p.x >= end.x) return t("roi.error.startXLessThanEnd", { end: end.x });
  if (p.y >= end.y) return t("roi.error.startYLessThanEnd", { end: end.y });
  return null;
}

function validateEndPoint(
  p: { x: number; y: number },
  roi: ROIState,
  tr: TranslationApi,
): string | null {
  const { t } = tr;
  const start = selectionStart(roi);
  const xLo = Math.min(roi.x_origin, roi.x_end);
  const xHi = Math.max(roi.x_origin, roi.x_end);
  const yLo = Math.min(roi.y_origin, roi.y_end);
  const yHi = Math.max(roi.y_origin, roi.y_end);
  if (p.x < xLo || p.x > xHi) {
    return t("roi.error.endXBounds", { origin: roi.x_origin, end: roi.x_end });
  }
  if (p.y < yLo || p.y > yHi) {
    return t("roi.error.endYBounds", { origin: roi.y_origin, end: roi.y_end });
  }
  if (p.x <= start.x) return t("roi.error.endXGreaterThanStart", { start: start.x });
  if (p.y <= start.y) return t("roi.error.endYGreaterThanStart", { start: start.y });
  return null;
}

function roundScale(v: number) {
  return formatOneDecimal(v);
}

function fmtRange(a: number, b: number): string {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `${formatOneDecimal(lo)}..${formatOneDecimal(hi)}`;
}

function formatOneDecimal(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : "0.0";
}

function hasAtMostOneDecimal(text: string): boolean {
  return /^-?\d+(?:\.\d)?$/.test(text.trim());
}
