import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clearROIImage,
  clearROIScanImage,
  clearROISelection,
  streamReset,
  updateROI,
  type ROIState,
} from "../store/scanSlice";
import { useAppDispatch, useAppSelector } from "../store";
import type { ROIRequest } from "../types/api";
import { clearBitmapSelectionCache } from "../lib/bitmapVector";
import { grayScaleSelectionContains, type GrayScaleSelection } from "../lib/grayScaleSelection";
import { vectorScanSampleCount, vectorScanSamplePixel } from "../lib/vectorScanPath";
import { stopAllScanActions } from "../hooks/scanActionRegistry";
import {
  ROI_CANVAS_EDGE,
  ROI_VIEWPORT_MIN_SPAN,
  ROI_AXIS_FONT,
  canvasPointToWorld,
  imageWorldBounds,
  clampCanvasPointToViewport,
  clampViewportCoordinate,
  viewportBounds,
  worldToCanvasX,
  worldToCanvasY,
} from "../lib/roiGeometry";
import { useTranslation, type TranslationApi, type TranslationKey } from "../i18n";
import { Icon } from "./Icon";
import { LevelWedge } from "./LevelWedge";
import { NumberStepperInput } from "./NumberStepperField";
import { useLevelSetting } from "../hooks/useLevelSetting";
import {
  AUTO_LEVELS,
  ROI_GRAY_FULL_SCALE,
  ROI_GRAY_SAMPLE_SCALE,
  grayLevelLut,
  type LevelHistogram,
  type ResolvedLevels,
} from "../lib/displayLevels";
import {
  ROI_LEVEL_KEY,
  applyLevelsToCanvas,
  measureGrayImage,
  resolveRoiLevels,
} from "../lib/grayImageLevels";

type CalibrationHandle = "x-start" | "x-end" | "y-start" | "y-end";
type ROISelectionCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type CalibrationLine = {
  start: { x: number; y: number };
  end: { x: number; y: number };
};

const UNITS = [
  { value: "um", label: "μm" },
  { value: "mm", label: "mm" },
  { value: "cm", label: "cm" },
  { value: "nm", label: "nm" },
];

const ROI_DRAG_THRESHOLD = 8;
const ROI_CORNER_DRAG_THRESHOLD = 18;

export function ROIEditor({
  disabled,
  variant = "all",
  backgroundImageUrl = null,
  lastScanImageUrl = null,
  grayScaleSelection = null,
  grayScaleSkipped = null,
  allowClearRegionWhileDisabled = false,
  liveVectorPreview = false,
  hideSelectionOverlay = false,
  graySelectionResetToken = 0,
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
  hideSelectionOverlay?: boolean;
  graySelectionResetToken?: number;
  onLoadLastScan?: () => void;
}) {
  const dispatch = useAppDispatch();
  const tr = useTranslation();
  const { t } = tr;
  const roi = useAppSelector((s) => s.scan.roi);
  const streamTransforms = useAppSelector((s) => s.scan.streamTransforms);
  const canvasOrientation = [
    streamTransforms.xflip ? "scaleX(-1)" : "",
    streamTransforms.yflip ? "scaleY(-1)" : "",
    streamTransforms.rotate90 ? "rotate(90deg)" : "",
  ].filter(Boolean).join(" ");
  const sx = streamTransforms.xflip ? -1 : 1;
  const sy = streamTransforms.yflip ? -1 : 1;
  const axisTextCounterTransform = streamTransforms.rotate90
    ? `matrix(0, ${-sx}, ${sy}, 0, 0, 0)`
    : `matrix(${sx}, 0, 0, ${sy}, 0, 0)`;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanPathCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  // Untouched copy of the image at canvas size. The base canvas shows it
  // stretched by the wedge levels, but gray-level selection, the live beam
  // overlay and the captured scan image always work on these raw gray values.
  const rawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rawImageRef = useRef<HTMLImageElement | null>(null);
  const [grayHist, setGrayHist] = useState<LevelHistogram | null>(null);
  const [levelSetting, setLevelSetting] = useLevelSetting(ROI_LEVEL_KEY);
  const levels = useMemo(() => resolveRoiLevels(grayHist, levelSetting), [grayHist, levelSetting]);
  const lut = useMemo(() => grayLevelLut(levels), [levels]);
  // Repaint at most once per animation frame while a wedge handle is dragged.
  const pendingLevelRef = useRef<ResolvedLevels | null>(null);
  const levelFrameRef = useRef<number | null>(null);
  const handleWedgeChange = useCallback(
    (next: ResolvedLevels) => {
      pendingLevelRef.current = next;
      if (levelFrameRef.current !== null) return;
      levelFrameRef.current = window.requestAnimationFrame(() => {
        levelFrameRef.current = null;
        const pending = pendingLevelRef.current;
        pendingLevelRef.current = null;
        if (pending) setLevelSetting({ mode: "manual", low: pending.low, high: pending.high });
      });
    },
    [setLevelSetting],
  );
  const handleWedgeAuto = useCallback(() => setLevelSetting(AUTO_LEVELS), [setLevelSetting]);
  useEffect(
    () => () => {
      if (levelFrameRef.current !== null) window.cancelAnimationFrame(levelFrameRef.current);
    },
    [],
  );
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const resizeCornerRef = useRef<ROISelectionCorner | null>(null);
  const resizeSelectionRef = useRef<ROIRequest | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const promotedBackgroundRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<ROIRequest | null>(null);
  const [resizeTrace, setResizeTrace] = useState<{
    corner: ROISelectionCorner;
    point: { x: number; y: number };
  } | null>(null);
  const [calibrationLine, setCalibrationLine] = useState<CalibrationLine | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [calibrationCorrection, setCalibrationCorrection] = useState<{
    x1: string;
    x2: string;
    y1: string;
    y2: string;
  } | null>(null);
  const [calibrationCorrectionBasis, setCalibrationCorrectionBasis] = useState<{
    original: { x1: number; x2: number; y1: number; y2: number };
    measured: { x1: number; x2: number; y1: number; y2: number };
  } | null>(null);
  const [calibrationCorrectionError, setCalibrationCorrectionError] = useState<string | null>(null);
  const [ctrlCursor, setCtrlCursor] = useState<{ x: number; y: number; captured: boolean } | null>(null);
  const [suppressedBackgroundUrl, setSuppressedBackgroundUrl] = useState<string | null>(null);
  const [activeHandle, setActiveHandle] = useState<CalibrationHandle | null>(null);
  const [canvasResetToken, setCanvasResetToken] = useState(0);
  const capturedLiveVectorKeyRef = useRef<string | null>(null);
  const capturedCompletedVectorRef = useRef<string | null>(null);
  const vectorPhase = useAppSelector((s) => s.scan.phase);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const vectorRevision = useAppSelector((s) => s.image.revision);
  const vectorPattern = useAppSelector((s) => s.image.vectorPattern);
  const vectorEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorScanPath = useAppSelector((s) => s.image.vectorScanPath);
  const vectorCustomPoints = useAppSelector((s) => s.image.vectorCustomPoints);
  const vectorCustomCount = useAppSelector((s) => s.image.vectorCustomCount);
  const retainVectorFeedbackOnComplete = useAppSelector(
    (s) => s.image.retainVectorFeedbackOnComplete
  );
  const bytesReceived = useAppSelector((s) => s.scan.bytesReceived);
  const chunksReceived = useAppSelector((s) => s.scan.chunksReceived);
  const targetLiveVectorSamples = vectorPattern === "custom" && vectorCustomCount > 0
    ? Math.min(vectorCursor, vectorCustomCount)
    : vectorCursor;
  const liveVectorSamples = targetLiveVectorSamples;
  const liveVectorProgressPct =
    liveVectorPreview
      ? Math.min(
          100,
          (liveVectorSamples /
            Math.max(
              1,
              vectorPattern === "custom"
                ? vectorCustomCount
                : vectorScanSampleCount(vectorEdge, vectorScanPath)
            )) *
            100
        )
      : 0;
  const hasLoadedImage = Boolean(roi.imageDataUrl);
  const hasPartialRegion = Boolean(roi.selection);
  const roiSelectionKey = roi.selection
    ? `${roi.selection.x_start}:${roi.selection.x_end}:${roi.selection.y_start}:${roi.selection.y_end}`
    : "";
  const activeSelection = draft ?? roi.selection;
  const roiModeLabel =
    roi.scanImageDataUrl !== null
      ? t("roi.canvasMode.scanPreview")
      : roi.imageKind === "lastScan"
      ? t("roi.canvasMode.scanPreview")
      : roi.imageKind === "file"
      ? t("roi.canvasMode.loadedPreview")
      : t("roi.canvasMode.selection");
  const imageSourceLabel =
    roi.scanImageDataUrl !== null
      ? t("roi.imageSource.lastScan")
      : roi.imageKind === "lastScan"
      ? t("roi.imageSource.lastScan")
      : roi.imageKind === "file"
      ? t("roi.imageSource.loaded")
      : null;
  const backgroundSource =
    backgroundImageUrl && backgroundImageUrl !== suppressedBackgroundUrl
      ? backgroundImageUrl
      : null;
  const imageSource =
    roi.scanImageDataUrl ?? (roi.imageKind === "lastScan"
      ? backgroundSource ?? roi.imageDataUrl
      : roi.imageDataUrl ?? backgroundSource);

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
        roi.scanImageDataUrl === null &&
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
    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== "Control") return;
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
      setResizeTrace(null);
      setCtrlCursor(null);
      if (!resizeCornerRef.current) {
        resizeSelectionRef.current = null;
      }
    }

    window.addEventListener("keyup", onKeyUp);
    return () => window.removeEventListener("keyup", onKeyUp);
  }, []);

  useEffect(() => {
    drawBaseCanvas();
    drawHighlightMask();
    drawLiveVectorOverlay();
    drawLiveScanPathOverlay();
    drawAnnotationLayer();
  }, [
    draft,
    grayScaleSelection,
    grayScaleSkipped,
    roi,
    tr.locale,
    liveVectorPreview,
    hideSelectionOverlay,
    vectorPhase,
    vectorCursor,
    vectorPattern,
    vectorEdge,
    vectorScanPath,
    vectorCustomPoints,
    vectorCustomCount,
    bytesReceived,
    chunksReceived,
    resizeTrace,
    calibrationLine,
    lut,
  ]);

  useEffect(() => {
    if (graySelectionResetToken <= 0) return;
    capturedLiveVectorKeyRef.current = null;
    imageRef.current = null;
    setCanvasResetToken((n) => n + 1);

    const live = liveCanvasRef.current;
    const liveCtx = live?.getContext("2d");
    if (live && liveCtx) {
      liveCtx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
    }
    drawBaseCanvas();
    drawHighlightMask();
    drawAnnotationLayer();
  }, [graySelectionResetToken]);

  useEffect(() => {
    if (
      !liveVectorPreview ||
      vectorPhase !== "completed" ||
      vectorPattern !== "custom" ||
      vectorCustomCount <= 0 ||
      !retainVectorFeedbackOnComplete ||
      grayScaleSelection === null ||
      grayScaleSkipped === null
    ) {
      if (vectorPhase !== "completed") {
        capturedCompletedVectorRef.current = null;
      }
      return;
    }

  const captureKey = [
      vectorCustomCount,
      grayScaleSelection[0],
      grayScaleSelection[1],
      String(grayScaleSkipped),
    ].join(":");
    if (capturedCompletedVectorRef.current === captureKey) return;

    const frame = window.requestAnimationFrame(() => {
      // Capture the raw image, not the wedge-stretched display, so the stored
      // scan image is never stretched twice.
      const base = imageRef.current && rawCanvasRef.current ? rawCanvasRef.current : canvasRef.current;
      const mask = maskCanvasRef.current;
      const live = liveCanvasRef.current;
      if (!base || !mask || !live) return;

      const composed = document.createElement("canvas");
      composed.width = ROI_CANVAS_EDGE;
      composed.height = ROI_CANVAS_EDGE;
      const ctx = composed.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(base, 0, 0);
      ctx.drawImage(mask, 0, 0);
      ctx.drawImage(live, 0, 0);

      capturedCompletedVectorRef.current = captureKey;
      dispatch(updateROI({ scanImageDataUrl: composed.toDataURL("image/png") }));
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    liveVectorPreview,
    vectorPhase,
    vectorPattern,
    vectorCustomCount,
    retainVectorFeedbackOnComplete,
    grayScaleSelection,
    grayScaleSkipped,
    dispatch,
  ]);

  useEffect(() => {
    if (!liveVectorPreview || vectorPattern !== "custom" || vectorCustomCount <= 0) {
      capturedLiveVectorKeyRef.current = null;
      capturedCompletedVectorRef.current = null;
    }
  }, [liveVectorPreview, vectorPattern, vectorCustomCount]);

  useEffect(() => {
    if (!dragStartRef.current) {
      setDraft((current) => current === null ? current : null);
    }
  }, [roiSelectionKey]);

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
        dispatch(
          updateROI({
            imageName: file.name,
            imageDataUrl: reader.result,
            imageKind: "file",
            imageBounds: null,
          })
        );
      }
    };
    reader.readAsDataURL(file);
  }

  function canvasPointFromClient(clientX: number, clientY: number, clampToSelection = true) {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const raw = {
      x: clampViewportCoordinate(((clientX - r.left) / r.width) * ROI_CANVAS_EDGE, 0, ROI_CANVAS_EDGE),
      y: clampViewportCoordinate(((clientY - r.top) / r.height) * ROI_CANVAS_EDGE, 0, ROI_CANVAS_EDGE),
    };
    // Pointer coordinates arrive in the oriented display space. Convert them
    // back to the image's source space before mapping to ROI/world coordinates.
    if (streamTransforms.xflip) raw.x = ROI_CANVAS_EDGE - raw.x;
    if (streamTransforms.yflip) raw.y = ROI_CANVAS_EDGE - raw.y;
    if (streamTransforms.rotate90) {
      [raw.x, raw.y] = [raw.y, ROI_CANVAS_EDGE - raw.x];
    }
    return clampToSelection ? clampCanvasPointToViewport(raw, viewportBounds(roi)) : raw;
  }

  function canvasPoint(e: React.PointerEvent<HTMLElement>) {
    return canvasPointFromClient(e.clientX, e.clientY, true);
  }

  function rawCanvasPoint(e: React.PointerEvent<HTMLElement>) {
    return canvasPointFromClient(e.clientX, e.clientY, false);
  }

  function toDut(point: { x: number; y: number }) {
    return canvasPointToWorld(point, imageWorldBounds(roi), viewportBounds(roi));
  }

  function calibrationWorldPoint(point: { x: number; y: number }) {
    return canvasPointToWorld(point, imageWorldBounds(roi), viewportBounds(roi, "draft"));
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

  function selectionCornerAt(point: { x: number; y: number }): ROISelectionCorner | null {
    const selected = roi.selection;
    if (!selected) return null;
    const bounds = viewportBounds(roi);
    const imageBounds = imageWorldBounds(roi);
    const x0 = worldToCanvasX(selected.x_start, imageBounds, bounds);
    const x1 = worldToCanvasX(selected.x_end, imageBounds, bounds);
    const y0 = worldToCanvasY(selected.y_start, imageBounds, bounds);
    const y1 = worldToCanvasY(selected.y_end, imageBounds, bounds);
    const corners: Array<{ corner: ROISelectionCorner; x: number; y: number }> = [
      { corner: "top-left", x: x0, y: y0 },
      { corner: "top-right", x: x1, y: y0 },
      { corner: "bottom-left", x: x0, y: y1 },
      { corner: "bottom-right", x: x1, y: y1 },
    ];
    let nearest: ROISelectionCorner | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const item of corners) {
      const distance = Math.hypot(point.x - item.x, point.y - item.y);
      if (distance < nearestDistance) {
        nearest = item.corner;
        nearestDistance = distance;
      }
    }
    return nearestDistance <= ROI_CORNER_DRAG_THRESHOLD ? nearest : null;
  }

  function cornerCanvasPoint(corner: ROISelectionCorner): { x: number; y: number } | null {
    const selected = resizeSelectionRef.current ?? roi.selection;
    if (!selected) return null;
    const bounds = viewportBounds(roi);
    const imageBounds = imageWorldBounds(roi);
    const trace = resizeTrace?.corner === corner ? resizeTrace.point : null;
    switch (corner) {
      case "top-left":
        return {
          x: trace ? trace.x : worldToCanvasX(selected.x_start, imageBounds, bounds),
          y: trace ? trace.y : worldToCanvasY(selected.y_start, imageBounds, bounds),
        };
      case "top-right":
        return {
          x: trace ? trace.x : worldToCanvasX(selected.x_end, imageBounds, bounds),
          y: trace ? trace.y : worldToCanvasY(selected.y_start, imageBounds, bounds),
        };
      case "bottom-left":
        return {
          x: trace ? trace.x : worldToCanvasX(selected.x_start, imageBounds, bounds),
          y: trace ? trace.y : worldToCanvasY(selected.y_end, imageBounds, bounds),
        };
      case "bottom-right":
        return {
          x: trace ? trace.x : worldToCanvasX(selected.x_end, imageBounds, bounds),
          y: trace ? trace.y : worldToCanvasY(selected.y_end, imageBounds, bounds),
        };
    }
  }

  function rectFromCornerDrag(corner: ROISelectionCorner, point: { x: number; y: number }): ROIRequest | null {
    const selected = resizeSelectionRef.current ?? roi.selection;
    if (!selected) return null;
    const moving = toDut(point);
    const fixed = {
      "top-left": { x: selected.x_end, y: selected.y_end },
      "top-right": { x: selected.x_start, y: selected.y_end },
      "bottom-left": { x: selected.x_end, y: selected.y_start },
      "bottom-right": { x: selected.x_start, y: selected.y_start },
    } satisfies Record<ROISelectionCorner, { x: number; y: number }>;
    return {
      x_start: Math.min(fixed[corner].x, moving.x),
      x_end: Math.max(fixed[corner].x, moving.x),
      y_start: Math.min(fixed[corner].y, moving.y),
      y_end: Math.max(fixed[corner].y, moving.y),
    };
  }

  function beginCornerResize(
    corner: ROISelectionCorner,
    event: React.PointerEvent<HTMLElement>
  ) {
    if (disabled || roi.calibration_enabled) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
    resizeCornerRef.current = corner;
    resizeSelectionRef.current = roi.selection;
    dragStartRef.current = null;
    const p = canvasPoint(event);
    setResizeTrace({ corner, point: p });
    setCtrlCursor({ x: p.x, y: p.y, captured: true });
    const d = toDut(p);
    setTip({ x: event.clientX, y: event.clientY, text: formatPointText(d) });
    const onMove = (moveEvent: PointerEvent) => {
      if (resizeCornerRef.current !== corner) return;
      moveEvent.preventDefault();
      const p = canvasPointFromClient(moveEvent.clientX, moveEvent.clientY, false);
      setResizeTrace({ corner, point: p });
      setCtrlCursor({ x: p.x, y: p.y, captured: true });
      const dMove = toDut(p);
      setTip({ x: moveEvent.clientX, y: moveEvent.clientY, text: formatPointText(dMove) });
    };

    const onUp = (upEvent: PointerEvent) => {
      if (resizeCornerRef.current !== corner) return;
      upEvent.preventDefault();
      const p = canvasPointFromClient(upEvent.clientX, upEvent.clientY, false);
      const next = rectFromCornerDrag(corner, p);
      resizeCornerRef.current = null;
      resizeSelectionRef.current = null;
      dragStartRef.current = null;
      setResizeTrace(null);
      setDraft(null);
      setCtrlCursor(null);
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
      if (next) {
        clearBitmapSelectionCache();
        dispatch(updateROI({ selection: next }));
      }
      setTip(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    resizeCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }

  function drawBaseCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);

    const img = imageRef.current;
    syncRawImage(img);
    if (img) {
      ctx.drawImage(img, 0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
      applyLevelsToCanvas(canvas, levels);
    } else {
      ctx.fillStyle = getCssColor(canvas, "--c-bg-elev", "#11203a");
      ctx.fillRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
    }

  }

  /** Keep the raw copy and the wedge histogram in step with the current image. */
  function syncRawImage(img: HTMLImageElement | null) {
    if (rawImageRef.current === img) return;
    rawImageRef.current = img;
    if (!img) {
      setGrayHist(null);
      return;
    }
    const raw = rawCanvasRef.current ?? document.createElement("canvas");
    rawCanvasRef.current = raw;
    const measured = measureGrayImage(img, raw);
    setGrayHist(measured ? measured.histogram : null);
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
    const imageBounds = imageWorldBounds(roi);
    const x0 = worldToCanvasX(activeSelection.x_start, imageBounds, bounds);
    const x1 = worldToCanvasX(activeSelection.x_end, imageBounds, bounds);
    const y0 = worldToCanvasY(activeSelection.y_start, imageBounds, bounds);
    const y1 = worldToCanvasY(activeSelection.y_end, imageBounds, bounds);
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

      // Selection above used the raw gray value; the tint is computed from the
      // gray the operator sees (wedge-stretched) so it blends with the display.
      const isGray = data[i] === data[i + 1] && data[i] === data[i + 2];
      const shown = isGray ? lut[value] : value;
      const sr = isGray ? shown : data[i];
      const sg = isGray ? shown : data[i + 1];
      const sb = isGray ? shown : data[i + 2];
      const tinted = spotMode ? tintBeamHitPixel(sr, sg, sb) : tintHighlighterPixel(sr, sg, sb);
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
    const keepCompletedOverlay = roi.scanImageDataUrl !== null && vectorPhase === "completed";
    if (!keepCompletedOverlay) {
      ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
    }
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
    // Beam-on decisions use the raw gray values, not the wedge-stretched display.
    const sourceCanvas = imageRef.current && rawCanvasRef.current ? rawCanvasRef.current : canvasRef.current;
    const sourceCtx = sourceCanvas?.getContext("2d");
    if (!sourceCanvas || !sourceCtx) return;
    const sourceData = sourceCtx.getImageData(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE).data;
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < limit; i++) {
      const x = vectorCustomPoints[2 * i] | 0;
      const y = vectorCustomPoints[2 * i + 1] | 0;
      const worldX = selection.x_start + ((x - pointBounds.x0) / pointXSpan) * worldXSpan;
      const worldY = selection.y_start + ((y - pointBounds.y0) / pointYSpan) * worldYSpan;
      const imageBounds = imageWorldBounds(roi);
      const canvasX = Math.round(worldToCanvasX(worldX, imageBounds, viewportBounds(roi)));
      const canvasY = Math.round(worldToCanvasY(worldY, imageBounds, viewportBounds(roi)));
      if (canvasX < 0 || canvasX >= ROI_CANVAS_EDGE || canvasY < 0 || canvasY >= ROI_CANVAS_EDGE) continue;
      const srcIdx = (canvasY * ROI_CANVAS_EDGE + canvasX) * 4;
      const value = sourceData[srcIdx] ?? 0;
      const selected = grayScaleSelectionContains(grayScaleSelection, value);
      const beamOn = grayScaleSkipped === false ? selected : !selected;
      if (!beamOn) continue;
      points.push({ x: canvasX, y: canvasY });
    }

    if (points.length === 0) {
      if (!keepCompletedOverlay) ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
      return;
    }

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

  function drawLiveScanPathOverlay() {
    const canvas = scanPathCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, ROI_CANVAS_EDGE, ROI_CANVAS_EDGE);
    if (
      !liveVectorPreview ||
      !roi.vector_show_scan_path ||
      !roi.selection ||
      liveVectorSamples <= 0
    ) {
      return;
    }

    const selection = roi.selection;
    const bounds = viewportBounds(roi);
    const imageBounds = imageWorldBounds(roi);
    const customBounds = vectorCustomPoints ? pointArrayBounds(vectorCustomPoints) : null;
    const customXSpan = customBounds ? Math.max(1e-6, customBounds.x1 - customBounds.x0) : 1;
    const customYSpan = customBounds ? Math.max(1e-6, customBounds.y1 - customBounds.y0) : 1;
    const worldXSpan = Math.max(1e-6, selection.x_end - selection.x_start);
    const worldYSpan = Math.max(1e-6, selection.y_end - selection.y_start);

    const pointAt = (index: number): { x: number; y: number } | null => {
      let worldX: number;
      let worldY: number;
      if (vectorPattern === "custom") {
        if (!vectorCustomPoints || !customBounds || index >= vectorCustomCount) return null;
        const x = vectorCustomPoints[2 * index];
        const y = vectorCustomPoints[2 * index + 1];
        worldX = selection.x_start + ((x - customBounds.x0) / customXSpan) * worldXSpan;
        worldY = selection.y_start + ((y - customBounds.y0) / customYSpan) * worldYSpan;
      } else {
        const point = vectorScanSamplePixel(index, vectorEdge, vectorScanPath);
        if (!point) return null;
        worldX = selection.x_start + (point.x / Math.max(1, vectorEdge - 1)) * worldXSpan;
        worldY = selection.y_start + (point.y / Math.max(1, vectorEdge - 1)) * worldYSpan;
      }
      return {
        x: worldToCanvasX(worldX, imageBounds, bounds),
        y: worldToCanvasY(worldY, imageBounds, bounds),
      };
    };

    const limit = vectorPattern === "custom"
      ? Math.min(liveVectorSamples, vectorCustomCount)
      : Math.min(liveVectorSamples, vectorScanSampleCount(vectorEdge, vectorScanPath));
    const first = Math.max(0, limit - Math.min(160, Math.max(24, vectorEdge >> 2)));
    ctx.save();
    ctx.strokeStyle = "rgba(111, 190, 211, 0.18)";
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    let started = false;
    for (let index = first; index < limit; index++) {
      const point = pointAt(index);
      if (!point) continue;
      if (!started) {
        ctx.moveTo(point.x, point.y);
        started = true;
      } else {
        ctx.lineTo(point.x, point.y);
      }
    }
    ctx.stroke();

    const current = pointAt(limit - 1);
    if (current) {
      ctx.fillStyle = "rgba(151, 210, 224, 0.48)";
      ctx.beginPath();
      ctx.arc(current.x, current.y, 1.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(151, 210, 224, 0.42)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.arc(current.x, current.y, 1.3, 0, Math.PI * 2);
      ctx.moveTo(current.x - 2.3, current.y);
      ctx.lineTo(current.x + 2.3, current.y);
      ctx.moveTo(current.x, current.y - 2.3);
      ctx.lineTo(current.x, current.y + 2.3);
      ctx.stroke();
    }
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

    const selected = roi.calibration_enabled || hideSelectionOverlay ? null : roi.selection;
    if (selected) {
      if (resizeTrace && resizeSelectionRef.current) {
        drawSelectionTrace(ctx, resizeSelectionRef.current, resizeTrace, roi);
      } else if (draft) {
        drawSelection(ctx, draft, roi);
      } else {
        drawSelection(ctx, selected, roi);
      }
    }
  }

  function drawSelection(ctx: CanvasRenderingContext2D, selected: ROIRequest, nextROI: ROIState) {
    const bounds = viewportBounds(nextROI);
    const imageBounds = imageWorldBounds(nextROI);
    const x0 = worldToCanvasX(selected.x_start, imageBounds, bounds);
    const x1 = worldToCanvasX(selected.x_end, imageBounds, bounds);
    const y0 = worldToCanvasY(selected.y_start, imageBounds, bounds);
    const y1 = worldToCanvasY(selected.y_end, imageBounds, bounds);
    ctx.save();
    ctx.strokeStyle = "#ff2d2d";
    ctx.fillStyle = "#ff2d2d";
    ctx.lineWidth = 0.75;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }

  function drawSelectionTrace(
    ctx: CanvasRenderingContext2D,
    selected: ROIRequest,
    trace: { corner: ROISelectionCorner; point: { x: number; y: number } },
    nextROI: ROIState
  ) {
    const bounds = viewportBounds(nextROI);
    const imageBounds = imageWorldBounds(nextROI);
    const corners = {
      "top-left": {
        moved: { x: selected.x_start, y: selected.y_start },
        adjacent: [
          { x: selected.x_end, y: selected.y_start },
          { x: selected.x_start, y: selected.y_end },
        ],
      },
      "top-right": {
        moved: { x: selected.x_end, y: selected.y_start },
        adjacent: [
          { x: selected.x_start, y: selected.y_start },
          { x: selected.x_end, y: selected.y_end },
        ],
      },
      "bottom-left": {
        moved: { x: selected.x_start, y: selected.y_end },
        adjacent: [
          { x: selected.x_start, y: selected.y_start },
          { x: selected.x_end, y: selected.y_end },
        ],
      },
      "bottom-right": {
        moved: { x: selected.x_end, y: selected.y_end },
        adjacent: [
          { x: selected.x_end, y: selected.y_start },
          { x: selected.x_start, y: selected.y_end },
        ],
      },
    }[trace.corner];

    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(124, 255, 107, 0.95)";
    ctx.fillStyle = "rgba(124, 255, 107, 0.95)";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(worldToCanvasX(corners.moved.x, imageBounds, bounds), worldToCanvasY(corners.moved.y, imageBounds, bounds));
    ctx.lineTo(trace.point.x, trace.point.y);
    ctx.moveTo(trace.point.x, trace.point.y);
    ctx.lineTo(worldToCanvasX(corners.adjacent[0].x, imageBounds, bounds), worldToCanvasY(corners.adjacent[0].y, imageBounds, bounds));
    ctx.moveTo(trace.point.x, trace.point.y);
    ctx.lineTo(worldToCanvasX(corners.adjacent[1].x, imageBounds, bounds), worldToCanvasY(corners.adjacent[1].y, imageBounds, bounds));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(trace.point.x, trace.point.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function selectionHintPosition(selected: ROIRequest) {
    const bounds = viewportBounds(roi);
    const imageBounds = imageWorldBounds(roi);
    const x0 = worldToCanvasX(selected.x_start, imageBounds, bounds);
    const x1 = worldToCanvasX(selected.x_end, imageBounds, bounds);
    const y0 = worldToCanvasY(selected.y_start, imageBounds, bounds);
    return {
      left: ((Math.min(x0, x1) + Math.max(x0, x1)) / 2 / ROI_CANVAS_EDGE) * 100,
      top: (Math.max(0, Math.min(y0, worldToCanvasY(selected.y_end, imageBounds, bounds)) - 16) / ROI_CANVAS_EDGE) * 100,
    };
  }

  function selectionHintText(selected: ROIRequest) {
    return (
      <>
        <span>Press ctrl to drag a corner</span>
        <span>
          {formatPointText({ x: selected.x_start, y: selected.y_start })} -{" "}
          {formatPointText({ x: selected.x_end, y: selected.y_end })}
        </span>
      </>
    );
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
    if (calibrationLine) {
      ctx.strokeStyle = "#ff0000";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(calibrationLine.start.x, calibrationLine.start.y);
      ctx.lineTo(calibrationLine.end.x, calibrationLine.end.y);
      ctx.stroke();
    }
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
    stopAllScanActions();
    setDraft(null);
    imageRef.current = null;
    promotedBackgroundRef.current = null;
    setSuppressedBackgroundUrl(backgroundImageUrl);
    if (fileRef.current) {
      fileRef.current.value = "";
    }
    setCanvasResetToken((n) => n + 1);
    dispatch(clearROIImage());
    dispatch(clearROIScanImage());
    dispatch(clearROISelection());
    dispatch(streamReset());
  }

  function clearPartialRegion() {
    clearBitmapSelectionCache();
    stopAllScanActions();
    setDraft(null);
    dispatch(clearROIImage());
    dispatch(clearROIScanImage());
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
                  readOnly
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
                  readOnly
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
                  readOnly
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
                  readOnly
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
                  disabled
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
                  disabled
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
        <div className="canvas-stage roi-canvas-stage">
        <div
          ref={canvasWrapRef}
          className={`roi-canvas-wrap${roi.calibration_enabled ? " roi-canvas-wrap--calibrating" : ""}`}
          style={canvasOrientation ? { transform: canvasOrientation, transformOrigin: "center" } : undefined}
        >
          <div className="roi-canvas-mode" aria-live="polite">
            {!roi.calibration_enabled && <span className="roi-source-pill">{roiModeLabel}</span>}
          </div>
          {imageSourceLabel && (
            <div className="roi-canvas-source" aria-live="polite">
              <span className="roi-source-pill">{imageSourceLabel}</span>
            </div>
          )}
          <div
            className={`roi-canvas-layer roi-canvas-layer--base${disabled ? " is-disabled" : ""}${ctrlCursor ? " roi-canvas-layer--ctrl-cursor" : ""}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (disabled) return;
              if (roi.calibration_enabled) {
                if (e.target instanceof Element && e.target.closest("button")) return;
                e.preventDefault();
                const point = rawCanvasPoint(e);
                e.currentTarget.setPointerCapture(e.pointerId);
                setCalibrationLine({ start: point, end: point });
                return;
              }
              e.preventDefault();
              const p = canvasPoint(e);
              setDraft(null);
              if (e.ctrlKey) {
                resizeCornerRef.current = null;
                resizeSelectionRef.current = null;
                dragStartRef.current = null;
                setCtrlCursor({ x: p.x, y: p.y, captured: false });
                const d = toDut(p);
                setTip({ x: e.clientX, y: e.clientY, text: formatPointText(d) });
                return;
              }
              e.currentTarget.setPointerCapture(e.pointerId);
              resizeCornerRef.current = null;
              resizeSelectionRef.current = null;
              dragStartRef.current = p;
              setCtrlCursor(null);
              const d = toDut(p);
              setTip({ x: e.clientX, y: e.clientY, text: formatPointText(d) });
            }}
            onPointerMove={(e) => {
              if (resizeCornerRef.current) return;
              if (disabled) return;
              if (roi.calibration_enabled) {
                if (!calibrationLine) return;
                e.preventDefault();
                setCalibrationLine((current) =>
                  current ? { ...current, end: rawCanvasPoint(e) } : current
                );
                return;
              }
              e.preventDefault();
              const p = canvasPoint(e);
              const d = toDut(p);
              const hoverCorner = e.ctrlKey ? selectionCornerAt(p) : null;
              if (e.ctrlKey) {
                const snapped = hoverCorner ? cornerCanvasPoint(hoverCorner) ?? p : p;
                setCtrlCursor({ x: snapped.x, y: snapped.y, captured: Boolean(hoverCorner) });
              } else {
                setCtrlCursor(null);
              }
              if (dragStartRef.current) {
                const dx = Math.abs(p.x - dragStartRef.current.x);
                const dy = Math.abs(p.y - dragStartRef.current.y);
                if (Math.max(dx, dy) >= ROI_DRAG_THRESHOLD) {
                  const next = rectFromPoints(dragStartRef.current, p);
                  setDraft(next);
                }
                setTip({ x: e.clientX, y: e.clientY, text: formatPointText(d) });
              }
            }}
            onPointerUp={(e) => {
              if (resizeCornerRef.current) return;
              if (disabled) return;
              if (roi.calibration_enabled) {
                const line = calibrationLine;
                if (!line) return;
                e.preventDefault();
                const end = rawCanvasPoint(e);
                const startWorld = calibrationWorldPoint(line.start);
                const endWorld = calibrationWorldPoint(end);
                const deltaX = Math.abs(endWorld.x - startWorld.x);
                const deltaY = Math.abs(endWorld.y - startWorld.y);
                setCalibrationCorrection({
                  x1: formatOneDecimal(startWorld.x),
                  x2: formatOneDecimal(startWorld.x + deltaX),
                  y1: formatOneDecimal(startWorld.y),
                  y2: formatOneDecimal(startWorld.y + deltaY),
                });
                setCalibrationCorrectionBasis({
                  original: {
                    x1: roi.calibration_x_origin,
                    x2: roi.calibration_x_end,
                    y1: roi.calibration_y_origin,
                    y2: roi.calibration_y_end,
                  },
                  measured: {
                    x1: startWorld.x,
                    x2: startWorld.x + deltaX,
                    y1: startWorld.y,
                    y2: startWorld.y + deltaY,
                  },
                });
                setCalibrationCorrectionError(null);
                setCalibrationLine(null);
                return;
              }
              e.preventDefault();
              const nextPoint = canvasPoint(e);
              const start = dragStartRef.current;
              if (!start) {
                setCtrlCursor(e.ctrlKey ? { x: nextPoint.x, y: nextPoint.y, captured: false } : null);
                setTip(null);
                return;
              }
              const dx = Math.abs(nextPoint.x - start.x);
              const dy = Math.abs(nextPoint.y - start.y);
              const didDrag = Math.max(dx, dy) >= ROI_DRAG_THRESHOLD;
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
              if (resizeCornerRef.current) return;
              dragStartRef.current = null;
              resizeCornerRef.current = null;
              resizeSelectionRef.current = null;
              resizeCleanupRef.current?.();
              resizeCleanupRef.current = null;
              setResizeTrace(null);
              setDraft(null);
              setTip(null);
              setCtrlCursor(null);
            }}
          >
            <canvas
              ref={canvasRef}
              className="roi-canvas-layer roi-canvas-layer--base-canvas"
              width={ROI_CANVAS_EDGE}
              height={ROI_CANVAS_EDGE}
              onDragStart={(event) => event.preventDefault()}
            />
            {activeSelection && !roi.calibration_enabled && (
                <>
                  <span
                    className="roi-selection-hint"
                    style={{
                      left: `${selectionHintPosition(activeSelection).left}%`,
                      top: `${selectionHintPosition(activeSelection).top}%`,
                      transform: "translate(-50%, -100%)",
                      pointerEvents: "none",
                    }}
                    aria-hidden="true"
                  >
                    {selectionHintText(activeSelection)}
                  </span>
                  {(["top-left", "top-right", "bottom-left", "bottom-right"] as ROISelectionCorner[]).map(
                    (corner) => {
                      const pos = cornerCanvasPoint(corner);
                      if (!pos) return null;
                      return (
                        <button
                          key={corner}
                          type="button"
                          className="roi-corner-handle"
                          data-corner={corner}
                          data-captured={resizeCornerRef.current === corner ? "true" : "false"}
                          style={{
                            left: `${(pos.x / ROI_CANVAS_EDGE) * 100}%`,
                            top: `${(pos.y / ROI_CANVAS_EDGE) * 100}%`,
                          }}
                          onPointerDown={(event) => {
                            beginCornerResize(corner, event);
                          }}
                        />
                      );
                    }
                  )}
                </>
              )}
          </div>
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
            ref={scanPathCanvasRef}
            className="roi-canvas-layer roi-canvas-layer--scan-path"
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
          {ctrlCursor && !roi.calibration_enabled && (
              <span
              className="roi-corner-cursor"
              data-captured={ctrlCursor.captured ? "true" : "false"}
              style={{
                left: `${(ctrlCursor.x / ROI_CANVAS_EDGE) * 100}%`,
                top: `${(ctrlCursor.y / ROI_CANVAS_EDGE) * 100}%`,
              }}
              aria-hidden="true"
            />
          )}
          {!roi.calibration_enabled && <ROIAxisOverlay roi={roi} textCounterTransform={axisTextCounterTransform} />}
          {roi.calibration_enabled && (
            <ROICalibrationAxisOverlay roi={roi} showGrid={roi.show_grid} textCounterTransform={axisTextCounterTransform} />
          )}
          {roi.calibration_enabled && calibrationLine && (() => {
            const startWorld = calibrationWorldPoint(calibrationLine.start);
            const endWorld = calibrationWorldPoint(calibrationLine.end);
            const x1 = startWorld.x;
            const y1 = startWorld.y;
            const xLength = Math.abs(endWorld.x - startWorld.x);
            const yLength = Math.abs(endWorld.y - startWorld.y);
            const x2 = x1 + xLength;
            const y2 = y1 + yLength;
            const left = ((calibrationLine.start.x + calibrationLine.end.x) / 2 / ROI_CANVAS_EDGE) * 100;
            const top = ((calibrationLine.start.y + calibrationLine.end.y) / 2 / ROI_CANVAS_EDGE) * 100;
            return (
              <div
                className="calibration-line-readout"
                style={{ left: `${left}%`, top: `${top}%` }}
                aria-live="polite"
              >
                <span>X1: {formatDimensionValue(x1, roi.scale_unit)} | Y1: {formatDimensionValue(y1, roi.scale_unit)}</span>
                <span>X2: {formatDimensionValue(x2, roi.scale_unit)} | Y2: {formatDimensionValue(y2, roi.scale_unit)}</span>
              </div>
            );
          })()}
          {roi.calibration_enabled && (
            <>
              <div className="roi-calibration-ruler roi-calibration-ruler--top">
                <div
                  className="roi-calibration-ruler__track"
                  style={{ left: `${draftBounds.left / ROI_CANVAS_EDGE * 100}%`, width: `${draftBounds.width / ROI_CANVAS_EDGE * 100}%` }}
                />
                <button
                  className="roi-calibration-handle roi-calibration-handle--top roi-calibration-handle--blink"
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
                  className="roi-calibration-handle roi-calibration-handle--top roi-calibration-handle--end roi-calibration-handle--blink"
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
                  className="roi-calibration-handle roi-calibration-handle--left roi-calibration-handle--blink"
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
                  className="roi-calibration-handle roi-calibration-handle--left roi-calibration-handle--end roi-calibration-handle--blink"
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
        <LevelWedge
          histogram={grayHist}
          levels={levels}
          auto={levelSetting.mode === "auto"}
          onChange={handleWedgeChange}
          onAuto={handleWedgeAuto}
          disabled={!grayHist || grayHist.total <= 0 || roi.calibration_enabled}
          fullScale={ROI_GRAY_FULL_SCALE}
          codeDivisor={ROI_GRAY_SAMPLE_SCALE}
        />
        </div>
      )}
      {calibrationCorrection && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="calibration-correction-title">
            <div className="modal__header">
              <h3 id="calibration-correction-title">Correct calibration values</h3>
            </div>
            <div className="modal__body">
              <p className="muted">Review the delta-derived coordinates before applying them.</p>
              <div className="field-row">
                <label className="field">
                  <span>X1 ({unitLabel(roi.scale_unit)})</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={calibrationCorrection.x1}
                    onChange={(event) =>
                      setCalibrationCorrection({ ...calibrationCorrection, x1: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>X2 ({unitLabel(roi.scale_unit)})</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={calibrationCorrection.x2}
                    onChange={(event) =>
                      setCalibrationCorrection({ ...calibrationCorrection, x2: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>Y1 ({unitLabel(roi.scale_unit)})</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={calibrationCorrection.y1}
                    onChange={(event) =>
                      setCalibrationCorrection({ ...calibrationCorrection, y1: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Y2 ({unitLabel(roi.scale_unit)})</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={calibrationCorrection.y2}
                    onChange={(event) =>
                      setCalibrationCorrection({ ...calibrationCorrection, y2: event.target.value })
                    }
                  />
                </label>
              </div>
              {calibrationCorrectionError && <div className="field-warning">{calibrationCorrectionError}</div>}
            </div>
            <div className="modal__footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn btn--ghost" onClick={() => {
                setCalibrationCorrection(null);
                setCalibrationCorrectionBasis(null);
              }}>
                <Icon name="x" tone="danger" />
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  const x1 = Number(calibrationCorrection.x1);
                  const x2 = Number(calibrationCorrection.x2);
                  const y1 = Number(calibrationCorrection.y1);
                  const y2 = Number(calibrationCorrection.y2);
                  if (![x1, x2, y1, y2].every(Number.isFinite)) {
                    setCalibrationCorrectionError("Enter valid numeric X1, X2, Y1, and Y2 values.");
                    return;
                  }
                  if (x2 <= x1 || y2 <= y1) {
                    setCalibrationCorrectionError("X2 must be greater than X1 and Y2 must be greater than Y1.");
                    return;
                  }
                  const basis = calibrationCorrectionBasis;
                  if (!basis) return;
                  dispatch(updateROI({
                    calibration_x_origin: basis.original.x1 + (x1 - basis.measured.x1),
                    calibration_x_end: basis.original.x2 + (x2 - basis.measured.x2),
                    calibration_y_origin: basis.original.y1 + (y1 - basis.measured.y1),
                    calibration_y_end: basis.original.y2 + (y2 - basis.measured.y2),
                  }));
                  setCalibrationCorrection(null);
                  setCalibrationCorrectionBasis(null);
                }}
              >
                <Icon name="check" tone="success" />
                Apply
              </button>
            </div>
          </div>
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
  readOnly?: boolean;
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
      <NumberStepperInput
        value={text}
        step={0.1}
        disabled={props.disabled || props.readOnly === true}
        readOnly={props.readOnly}
        invalid={Boolean(warning)}
        inputMode="decimal"
        onValueChange={commit}
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

function ROIAxisOverlay({ roi, textCounterTransform }: { roi: ROIState; textCounterTransform: string }) {
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
          style={{
            left: `${tick.ratio * 100}%`,
            transform: `translateX(${tick.ratio === 0 ? "0" : tick.ratio === 1 ? "-100%" : "-50%"}) ${textCounterTransform}`,
          }}
        >
          {tick.xLabel}
        </span>
      ))}
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`y-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--y"
          style={{
            top: `${tick.ratio * 100}%`,
            transform: `translateY(${tick.ratio === 0 ? "0" : tick.ratio === 1 ? "-100%" : "-50%"}) ${textCounterTransform}`,
          }}
        >
          {tick.yLabel}
        </span>
      ))}
      <span className="canvas-axis-overlay__label canvas-axis-overlay__label--start" style={{ transform: textCounterTransform }}>
        {t("roi.canvas.start", {
          point: `(${formatOneDecimal(roi.x_origin)}, ${formatOneDecimal(roi.y_origin)})`,
          unit: unitLabel(roi.scale_unit),
        })}
      </span>
      <span className="canvas-axis-overlay__label canvas-axis-overlay__label--end" style={{ transform: textCounterTransform }}>
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
  textCounterTransform,
}: {
  roi: ROIState;
  showGrid: boolean;
  textCounterTransform: string;
}) {
  const { t } = useTranslation();
  const draftBounds = viewportBounds(roi, "draft");
  const ticks = Array.from({ length: 21 }, (_, i) => {
    const ratio = i / 20;
    return {
      key: i,
      ratio,
      major: i % 5 === 0,
      xLabel: `${formatOneDecimal(
        roi.calibration_x_origin +
          (roi.calibration_x_end - roi.calibration_x_origin) * ratio
      )} ${unitLabel(roi.scale_unit)}`,
      yLabel: `${formatOneDecimal(
        roi.calibration_y_origin +
          (roi.calibration_y_end - roi.calibration_y_origin) * ratio
      )} ${unitLabel(roi.scale_unit)}`,
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
          style={{
            left: tick.x,
            top: "16px",
            transform: `translateX(${tick.ratio === 0 ? "0" : tick.ratio === 1 ? "-100%" : "-50%"}) ${textCounterTransform}`,
          }}
        >
          {tick.xLabel}
        </span>
      ))}
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`y-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--y"
          style={{
            left: "14px",
            top: tick.y,
            transform: `translateY(${tick.ratio === 0 ? "0" : tick.ratio === 1 ? "-100%" : "-50%"}) ${textCounterTransform}`,
          }}
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
          transform: textCounterTransform,
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
          transform: textCounterTransform,
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
