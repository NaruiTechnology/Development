/**
 * Renders the raster grayscale frame or vector ADC image onto a canvas.
 *
 * Raster and vector scans are stored as flat Uint16Array buffers and
 * rendered as auto-scaled grayscale. The hardware returns 16-bit ADC
 * samples, and real signals can live mostly below the high byte; a fixed
 * `sample >> 8` display can look blank even while data is arriving.
 *
 * For raster the buffer is populated row-major as the FPGA emits samples.
 * For vector default, samples arrive x-major/y-inner and are painted back
 * to their actual populated cells. For vector custom, only requested
 * point coordinates are painted; unpopulated cells stay transparent.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAppDispatch, useAppSelector } from "../store";
import {
  setVectorRenderMode,
  updateROI,
  type ScanKind,
  type ROIState,
  type VectorRenderMode,
} from "../store/scanSlice";
import type { ROIRequest, VectorScanPath } from "../types/api";
import { useTranslation, type TranslationKey } from "../i18n";
import { scanAuthHeaders } from "../lib/authIdentity";
import { apiUrl } from "../lib/backendUrl";
import { grayScaleSelectionContains, type GrayScaleSelection } from "../lib/grayScaleSelection";
import { Icon } from "./Icon";
import { CanvasViewHelp } from "./CanvasViewHelp";
import { vectorScanSampleCount, vectorScanSamplePixel } from "../lib/vectorScanPath";

const DAC_RANGE = 2048;
const ROI_ACTION_BLANK_COLOR = { r: 97, g: 0, b: 0 };
const ROI_ACTION_HIGHLIGHT_COLOR = { r: 253, g: 224, b: 71 };

interface PaintStats {
  min: number;
  max: number;
  populated: number;
}

type AnnotationTool = "highlight" | "comment" | "rectangle" | "circle";
type LineStyle = "solid" | "dashed" | "dotted";

interface CanvasAnnotation {
  id: string;
  kind: AnnotationTool;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  strokeColor: string;
  lineStyle: LineStyle;
  lineWidth: number;
  text?: string;
}

interface CommentDraft {
  x: number;
  y: number;
  text: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  annotationId: string | null;
}

interface DraftShape {
  kind: Extract<AnnotationTool, "rectangle" | "circle">;
  x: number;
  y: number;
  x2: number;
  y2: number;
  strokeColor: string;
  lineStyle: LineStyle;
  lineWidth: number;
}

// Phase values from the scan slice are stable wire-format strings. Map
// each to a translation key here so the meta row can show them in the
// operator's language while the slice stays language-agnostic.
const PHASE_KEYS: Record<string, TranslationKey> = {
  idle: "phase.idle",
  running: "phase.running",
  stopping: "phase.stopping",
  completed: "phase.completed",
  error: "phase.error",
};

// Same for the kind label in the server-figure alt attribute.
const KIND_KEYS: Record<string, TranslationKey> = {
  raster: "tabs.raster",
  vector: "tabs.vector",
  roi: "tabs.roi",
};

export function ImageCanvas({
  kind,
  onRenderedImageChange,
  onMergedFigureChange,
  vectorGrayScaleSelection = null,
  vectorGrayScaleSkipped = null,
}: {
  kind: ScanKind;
  onRenderedImageChange?: (kind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null) => void;
  onMergedFigureChange?: (kind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null) => void;
  vectorGrayScaleSelection?: [number, number] | null;
  vectorGrayScaleSkipped?: boolean | null;
}) {
  const dispatch = useAppDispatch();
  const { t, fmt } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanPathCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const annotationSeqRef = useRef(0);
  const [stats, setStats] = useState<PaintStats>({ min: 0, max: 0, populated: 0 });
  const [serverFigureUrl, setServerFigureUrl] = useState<string | null>(null);
  const [serverFigureBusy, setServerFigureBusy] = useState(false);
  const [serverFigureError, setServerFigureError] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<AnnotationTool>("highlight");
  const [strokeColor, setStrokeColor] = useState("lawngreen");
  const [lineStyle, setLineStyle] = useState<LineStyle>("solid");
  const [lineWidth, setLineWidth] = useState(0.5);
  const [annotations, setAnnotations] = useState<CanvasAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [draftShape, setDraftShape] = useState<DraftShape | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [mergedFigureUrl, setMergedFigureUrl] = useState<string | null>(null);
  const [mergedFigureFilename, setMergedFigureFilename] = useState<string | null>(null);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  const lastRenderedImageEmitRef = useRef<{
    kind: Extract<ScanKind, "raster" | "vector">;
    imageUrl: string | null;
  } | null>(null);
  const onRenderedImageChangeRef = useRef(onRenderedImageChange);
  const onMergedFigureChangeRef = useRef(onMergedFigureChange);
  onRenderedImageChangeRef.current = onRenderedImageChange;
  onMergedFigureChangeRef.current = onMergedFigureChange;

  const revision = useAppSelector((s) => s.image.revision);

  // Raster fields
  const resolution = useAppSelector((s) => s.image.resolution);
  const frame = useAppSelector((s) => s.image.frame);
  const cursor = useAppSelector((s) => s.image.cursor);

  // Vector fields
  const vectorEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorImage = useAppSelector((s) => s.image.vectorImage);
  const vectorCustomPoints = useAppSelector((s) => s.image.vectorCustomPoints);
  const vectorCustomRenderPoints = useAppSelector((s) => s.image.vectorCustomRenderPoints);
  const vectorCustomBlankMask = useAppSelector((s) => s.image.vectorCustomBlankMask);
  const vectorCustomSpotMask = useAppSelector((s) => s.image.vectorCustomSpotMask);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const vectorPattern = useAppSelector((s) => s.image.vectorPattern);
  const vectorScanPath = useAppSelector((s) => s.image.vectorScanPath);
  const vectorSource = useAppSelector((s) => s.image.vectorSource);
  const vectorCustomCount = useAppSelector((s) => s.image.vectorCustomCount);
  const configuredVectorResolution = useAppSelector(
    (s) => s.scan.vector.vector_resolution
  );
  const renderMode = useAppSelector((s) => s.scan.vectorRenderMode);
  const roi = useAppSelector((s) => s.scan.roi);
  const theme = useAppSelector((s) => s.theme.theme);

  const phase = useAppSelector((s) => s.scan.phase);
  const lastResult = useAppSelector((s) => s.scan.lastResult);
  const lastOutput = useAppSelector((s) => s.scan.lastOutput);
  const bytesReceived = useAppSelector((s) => s.scan.bytesReceived);
  const chunksReceived = useAppSelector((s) => s.scan.chunksReceived);
  const hasPaintedCanvasImage = stats.populated > 0;
  const showServerFigure = phase === "completed" && (kind !== "vector" || vectorSource === "vector");
  const hasLiveCanvasData =
    kind === "raster" ? cursor > 0 : kind === "vector" ? vectorSource === "vector" && vectorCursor > 0 : false;
  const visibleVectorCursor = kind === "vector" && vectorSource !== "vector" ? 0 : vectorCursor;
  const hasRenderedCanvasImage =
    hasPaintedCanvasImage || Boolean(serverFigureUrl) || Boolean(mergedFigureUrl);
  const editorEnabled = phase === "completed" && hasRenderedCanvasImage;
  const toolbarVisible = phase === "completed";
  const editorToolbarVisible = toolbarVisible && hasRenderedCanvasImage;
  const showCalibratedAxes = kind !== "roi";
  const showGrid =
    kind === "raster"
      ? roi.raster_show_grid
      : kind === "vector"
        ? roi.vector_show_grid
        : roi.show_grid;
  const showScanPath =
    kind === "vector" && vectorPattern === "default" && roi.vector_show_scan_path;

  const showModeToggle = kind === "vector" && vectorPattern === "default";
  const vectorGraySpotSelection =
    kind === "vector" && vectorGrayScaleSelection !== null
      ? vectorGrayScaleSelection
      : null;
  const vectorGraySpotSkipped =
    kind === "vector" && vectorGrayScaleSelection !== null
      ? vectorGrayScaleSkipped
      : null;
  const vectorGraySpotColor =
    kind === "vector" && vectorGrayScaleSelection !== null
      ? ROI_ACTION_BLANK_COLOR
      : vectorGraySpotSkipped === false
      ? ROI_ACTION_HIGHLIGHT_COLOR
      : ROI_ACTION_BLANK_COLOR;

  const viewVectorEdge =
    kind === "vector" && vectorPattern === "default"
      ? configuredVectorResolution
      : vectorEdge;
  const stride =
    kind === "vector" && vectorPattern === "default" && viewVectorEdge > 0
      ? Math.max(1, Math.floor(DAC_RANGE / viewVectorEdge))
      : 1;
  const hasExactNativeStride =
    kind === "vector" && vectorPattern === "default" && viewVectorEdge > 0
      ? DAC_RANGE % viewVectorEdge === 0
      : true;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (kind === "raster") {
      const s = paintGrayscale(canvas, frame, resolution, cursor);
      setStats(s);
    } else if (kind === "vector" && vectorSource !== "vector") {
      clearCanvas(canvas);
      setStats({ min: 0, max: 0, populated: 0 });
    } else if (kind === "vector" && vectorPattern === "default" && renderMode === "native" && vectorEdge < DAC_RANGE) {
      const s = paintVectorDefaultBlockFill(
        canvas,
        vectorImage,
        vectorEdge,
        vectorCursor,
        vectorScanPath,
        vectorGraySpotSelection,
        vectorGraySpotColor,
      );
      setStats(s);
    } else if (kind === "vector" && vectorPattern === "default") {
      const s = paintVectorDefault(
        canvas,
        vectorImage,
        vectorEdge,
        vectorCursor,
        vectorScanPath,
        vectorGraySpotSelection,
        vectorGraySpotColor,
      );
      setStats(s);
    } else if (kind === "vector" && vectorCustomRenderPoints) {
      const s = paintVectorCustom(
        canvas,
        vectorImage,
        vectorEdge,
        vectorCustomRenderPoints,
        vectorCursor,
        vectorCustomBlankMask,
        vectorCustomSpotMask,
        vectorGraySpotColor,
      );
      setStats(s);
    } else {
      const s = paintGrayscale(canvas, vectorImage, vectorEdge, vectorCursor);
      setStats(s);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, kind, renderMode, theme]);

  useEffect(() => {
    if (!onRenderedImageChangeRef.current || (kind !== "raster" && kind !== "vector")) return;

    const emit = (imageUrl: string | null) => {
      const previous = lastRenderedImageEmitRef.current;
      if (previous?.kind === kind && previous.imageUrl === imageUrl) return;
      lastRenderedImageEmitRef.current = { kind, imageUrl };
      onRenderedImageChangeRef.current?.(kind, imageUrl);
    };

    if (!hasLiveCanvasData) {
      emit(null);
      return;
    }
    if (phase !== "completed") return;

    const handle = window.requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;
      try {
        emit(canvas.toDataURL("image/png"));
      } catch {
        emit(null);
      }
    });

    return () => window.cancelAnimationFrame(handle);
  }, [kind, phase, revision, renderMode, cursor, vectorCursor, hasLiveCanvasData]);

  useEffect(() => {
    const filename =
      lastOutput?.kind === kind && typeof lastOutput.image_filename === "string"
        ? lastOutput.image_filename.trim()
        : lastResult?.kind === kind && typeof lastResult.image_filename === "string"
          ? lastResult.image_filename.trim()
          : "";
    setMergedFigureFilename(filename || null);
  }, [kind, lastOutput, lastResult]);

  const clearEditorState = useCallback(
    (notifyMerged = true) => {
      annotationSeqRef.current = 0;
      setAnnotations([]);
      setSelectedAnnotationId(null);
      setDraftShape(null);
      setCommentDraft(null);
      setContextMenu(null);
      setMergedFigureUrl(null);
      setMergeConfirmOpen(false);
      setMergeBusy(false);
      setEditorError(null);
      if (notifyMerged && (kind === "raster" || kind === "vector")) {
        onMergedFigureChangeRef.current?.(kind, null);
      }
    },
    [kind]
  );

  const invalidateMergedFigure = useCallback(() => {
    setMergedFigureUrl(null);
    if (kind === "raster" || kind === "vector") {
      onMergedFigureChangeRef.current?.(kind, null);
    }
  }, [kind]);

  useEffect(() => {
    setStats({ min: 0, max: 0, populated: 0 });
    clearEditorState(true);
  }, [kind, clearEditorState]);

  useEffect(() => {
    if (phase === "idle" || phase === "running" || phase === "error") {
      clearEditorState(true);
    }
  }, [phase, clearEditorState]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    setToolbarHost(document.getElementById("image-panel-toolbar-slot"));
  }, []);

  useEffect(() => {
    if (!editorEnabled) return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTypingField =
        tag === "input" || tag === "textarea" || target?.isContentEditable === true;
      if (isTypingField) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      undoLastAnnotation();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editorEnabled, annotations.length]);

  useEffect(() => {
    if (!showServerFigure) {
      setServerFigureUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setServerFigureBusy(false);
      setServerFigureError(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setServerFigureBusy(true);
    setServerFigureError(null);

    const url =
      kind === "vector"
        ? apiUrl(`/api/scan/last/figure?render=${encodeURIComponent(renderMode)}&view=texture`)
        : apiUrl("/api/scan/last/figure?view=texture");

    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setServerFigureUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });
      })
      .catch((e: any) => {
        if (!cancelled) {
          setServerFigureUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return null;
          });
          setServerFigureError(e?.message ?? String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setServerFigureBusy(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [showServerFigure, kind, renderMode, chunksReceived]);

  const totalRasterPx = resolution * resolution;
  const totalVectorSamples =
    kind === "vector" && vectorSource !== "vector"
      ? 0
      : vectorPattern === "default"
      ? vectorScanSampleCount(vectorEdge, vectorScanPath)
      : vectorCustomCount;
  const activeRegion = activeROIRegion(roi);
  const current = currentBeamPosition({
    kind,
    roi,
    region: activeRegion,
    rasterFrame: frame,
    rasterResolution: resolution,
    rasterCursor: cursor,
    vectorImage,
    vectorEdge,
    vectorCursor: visibleVectorCursor,
    vectorPattern,
    vectorScanPath,
    vectorCustomPoints,
    vectorCustomRenderPoints,
  });

  const pct =
    kind === "raster" && totalRasterPx > 0
      ? Math.min(100, (cursor / totalRasterPx) * 100)
      : kind === "vector" && totalVectorSamples > 0
      ? Math.min(100, (visibleVectorCursor / totalVectorSamples) * 100)
      : phase === "completed"
      ? 100
      : 0;
  const preferServerFigure =
    Boolean(serverFigureUrl) &&
    phase === "completed" &&
    (!hasLiveCanvasData || stats.max > stats.min);
  const displayedFigureUrl = mergedFigureUrl ?? (preferServerFigure ? serverFigureUrl : null);

  let nativeEdge: number;
  if (kind === "raster") {
    nativeEdge = resolution;
  } else if (vectorPattern === "default" && renderMode === "native" && stride > 1) {
    nativeEdge = DAC_RANGE;
  } else {
    nativeEdge = vectorEdge;
  }

  useEffect(() => {
    const canvas = scanPathCanvasRef.current;
    if (!canvas || !showScanPath) return;
    paintVectorScanOrderOverlay(
      canvas,
      vectorEdge,
      visibleVectorCursor,
      vectorScanPath,
    );
  }, [revision, showScanPath, vectorEdge, vectorScanPath, visibleVectorCursor]);

  const phaseKey = PHASE_KEYS[phase];
  const kindKey = KIND_KEYS[kind];
  const phaseLabel = phaseKey ? t(phaseKey) : phase;
  const kindLabel = kindKey ? t(kindKey) : kind;
  const contextTargetId = contextMenu?.annotationId ?? selectedAnnotationId;

  function nextAnnotationId(): string {
    annotationSeqRef.current += 1;
    return `annotation-${annotationSeqRef.current}`;
  }

  function toRelativePoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const frame = frameRef.current;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  }

  function openContextMenu(
    event: {
      preventDefault: () => void;
      stopPropagation: () => void;
      clientX: number;
      clientY: number;
    },
    annotationId: string | null
  ) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedAnnotationId(annotationId);
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    setContextMenu({
      x: Math.min(rect.width - 8, Math.max(8, event.clientX - rect.left)),
      y: Math.min(rect.height - 8, Math.max(8, event.clientY - rect.top)),
      annotationId,
    });
  }

  function handleEditorSurfaceClick(event: { clientX: number; clientY: number }) {
    if (!editorEnabled) return;
    setSelectedAnnotationId(null);
    if (activeTool !== "highlight" && activeTool !== "comment") return;
    setContextMenu(null);
    setEditorError(null);

    const point = toRelativePoint(event.clientX, event.clientY);
    if (!point) return;

    if (activeTool === "comment") {
      setCommentDraft({ x: point.x, y: point.y, text: "" });
      return;
    }

    const annotationId = nextAnnotationId();
    setAnnotations((current) => [
      ...current,
      {
        id: annotationId,
        kind: "highlight",
        x: point.x,
        y: point.y,
        strokeColor,
        lineStyle,
        lineWidth,
      },
    ]);
    setSelectedAnnotationId(annotationId);
  }

  function handleEditorPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!editorEnabled || (activeTool !== "rectangle" && activeTool !== "circle")) return;
    if (event.button !== 0) return;
    const point = toRelativePoint(event.clientX, event.clientY);
    if (!point) return;
    setCommentDraft(null);
    setContextMenu(null);
    setEditorError(null);
    setSelectedAnnotationId(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftShape({
      kind: activeTool,
      x: point.x,
      y: point.y,
      x2: point.x,
      y2: point.y,
      strokeColor,
      lineStyle,
      lineWidth,
    });
  }

  function handleEditorPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!draftShape) return;
    const point = toRelativePoint(event.clientX, event.clientY);
    if (!point) return;
    setDraftShape((current) =>
      current
        ? {
            ...current,
            x2: point.x,
            y2: point.y,
          }
        : current
    );
  }

  function handleEditorPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!draftShape) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const normalized = normalizeShape(draftShape);
    setDraftShape(null);
    if (!normalized || shapeTooSmall(normalized)) return;
    const annotationId = nextAnnotationId();
    setAnnotations((current) => [...current, { ...normalized, id: annotationId }]);
    setSelectedAnnotationId(annotationId);
  }

  function saveCommentDraft() {
    const text = commentDraft?.text.trim() ?? "";
    if (!commentDraft || !text) {
      setCommentDraft(null);
      return;
    }
    const annotationId = nextAnnotationId();
    setAnnotations((current) => [
      ...current,
      {
        id: annotationId,
        kind: "comment",
        x: commentDraft.x,
        y: commentDraft.y,
        strokeColor,
        lineStyle,
        lineWidth,
        text,
      },
    ]);
    setSelectedAnnotationId(annotationId);
    setCommentDraft(null);
    setContextMenu(null);
  }

  function undoLastAnnotation() {
    setAnnotations((current) => {
      const next = current.slice(0, -1);
      setSelectedAnnotationId(next.length ? next[next.length - 1].id : null);
      return next;
    });
    invalidateMergedFigure();
    setDraftShape(null);
    setCommentDraft(null);
    setContextMenu(null);
  }

  function removeAnnotation(annotationId: string | null) {
    if (!annotationId) return;
    setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
    setSelectedAnnotationId((current) => (current === annotationId ? null : current));
    invalidateMergedFigure();
    setDraftShape(null);
    setCommentDraft(null);
    setContextMenu(null);
  }

  async function mergeAnnotationsIntoImage() {
    if (!annotations.length) return;
    setMergeBusy(true);
    try {
      const sourceCanvas = canvasRef.current;
      const exportCanvas = document.createElement("canvas");
      const ctx = exportCanvas.getContext("2d");
      if (!ctx) throw new Error(t("canvas.editor.merge.error"));

      if (displayedFigureUrl) {
        const image = await loadImage(displayedFigureUrl);
        exportCanvas.width = image.naturalWidth || image.width;
        exportCanvas.height = image.naturalHeight || image.height;
        ctx.drawImage(image, 0, 0, exportCanvas.width, exportCanvas.height);
      } else if (sourceCanvas) {
        exportCanvas.width = sourceCanvas.width;
        exportCanvas.height = sourceCanvas.height;
        ctx.drawImage(sourceCanvas, 0, 0);
      } else {
        throw new Error(t("canvas.editor.merge.error"));
      }

      drawCanvasAnnotations(ctx, annotations, exportCanvas.width, exportCanvas.height);
      const mergedUrl = exportCanvas.toDataURL("image/png");
      setMergedFigureUrl(mergedUrl);
      setAnnotations([]);
      setCommentDraft(null);
      setContextMenu(null);
      setEditorError(null);
      if (kind === "raster" || kind === "vector") {
        onMergedFigureChangeRef.current?.(kind, mergedUrl);
        await uploadMergedFigure(kind, mergedUrl, mergedFigureFilename);
      }
      setMergeConfirmOpen(false);
    } catch (error: any) {
      setEditorError(error?.message ?? t("canvas.editor.merge.error"));
    } finally {
      setMergeBusy(false);
    }
  }

  const toolbar = editorToolbarVisible ? (
        <div className="canvas-toolbox" role="toolbar" aria-label={t("canvas.editor.toolbar.aria")}>
          <div className="canvas-toolbox__cluster" role="radiogroup" aria-label={t("canvas.editor.toolbar.tools")}>
            {(
              [
                ["highlight", "highlightTool", "canvas.editor.tool.highlight"],
                ["comment", "commentTool", "canvas.editor.tool.comment"],
                ["rectangle", "rectangleTool", "canvas.editor.tool.rectangle"],
                ["circle", "circleTool", "canvas.editor.tool.circle"],
              ] as const
            ).map(([tool, icon, labelKey]) => (
              <button
                key={tool}
                type="button"
                role="radio"
                aria-checked={activeTool === tool}
                aria-pressed={activeTool === tool}
                className="canvas-toolbox__tool"
                title={t(labelKey)}
                onClick={() => {
                  setActiveTool(tool);
                  setSelectedAnnotationId(null);
                  setDraftShape(null);
                  setCommentDraft(null);
                  setContextMenu(null);
                }}
              >
                <Icon name={icon} tone="accent" />
              </button>
            ))}
          </div>

          <div className="canvas-toolbox__cluster">
            <label className="canvas-toolbox__field" title={t("canvas.editor.pen.color")}>
              <span>{t("canvas.editor.pen.color.short")}</span>
                <input
                  type="color"
                  value={strokeColor}
                  onChange={(event) => setStrokeColor(event.target.value)}
                />
            </label>

            <label className="canvas-toolbox__field" title={t("canvas.editor.pen.lineStyle")}>
              <span>{t("canvas.editor.pen.lineStyle.short")}</span>
                <select
                  className="input canvas-toolbox__select"
                  value={lineStyle}
                  onChange={(event) => setLineStyle(event.target.value as LineStyle)}
                >
                <option value="solid">{t("canvas.editor.pen.lineStyle.solid")}</option>
                <option value="dashed">{t("canvas.editor.pen.lineStyle.dashed")}</option>
                <option value="dotted">{t("canvas.editor.pen.lineStyle.dotted")}</option>
              </select>
            </label>

            <label className="canvas-toolbox__field" title={t("canvas.editor.pen.width")}>
              <span>{t("canvas.editor.pen.width.short")}</span>
                <select
                  className="input canvas-toolbox__select"
                  value={String(lineWidth)}
                  onChange={(event) => setLineWidth(Number(event.target.value))}
                >
                {[0.5, 1, 2, 3, 4, 6, 8].map((width) => (
                  <option key={width} value={width}>
                    {width}px
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="canvas-toolbox__cluster">
              <button
                type="button"
                className="canvas-toolbox__action"
              disabled={!annotations.length}
                title={t("canvas.editor.merge")}
                onClick={() => setMergeConfirmOpen(true)}
              >
              <Icon name="save" tone="success" />
            </button>
          </div>

          <span className="canvas-toolbox__hint">
            {annotations.length > 0
              ? t("canvas.editor.pending", { count: annotations.length })
              : mergedFigureUrl
              ? t("canvas.editor.mergedReady")
              : activeTool === "comment"
              ? t("canvas.editor.instructions.comment")
              : activeTool === "rectangle"
              ? t("canvas.editor.instructions.rectangle")
              : activeTool === "circle"
              ? t("canvas.editor.instructions.circle")
              : t("canvas.editor.instructions.highlight")}
          </span>
        </div>
      ) : null;

  return (
    <div>
      {!showModeToggle && editorToolbarVisible && (toolbarHost && toolbar ? createPortal(<>{toolbar}</>, toolbarHost) : toolbar)}

      {mergeConfirmOpen && createPortal(
        <div className="modal-backdrop canvas-merge-confirm__backdrop" role="presentation">
          <div
            className="modal canvas-merge-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="canvas-merge-confirm-title"
            aria-describedby="canvas-merge-confirm-message"
          >
            <div className="modal__header">
              <div id="canvas-merge-confirm-title" className="modal__title">
                {t("canvas.editor.merge.confirm.title")}
              </div>
              <button
                type="button"
                className="modal__close"
                disabled={mergeBusy}
                onClick={() => setMergeConfirmOpen(false)}
                aria-label={t("help.close")}
              >
                <Icon name="x" />
              </button>
            </div>
            <div id="canvas-merge-confirm-message" className="modal__body canvas-merge-confirm__body">
              {t("canvas.editor.merge.confirm", { count: annotations.length })}
            </div>
            <div className="settings-footer">
              <div className="settings-footer__row">
                <span
                  className="scan-busy"
                  data-visible={mergeBusy ? "true" : "false"}
                  aria-hidden={!mergeBusy}
                >
                  <span className="scan-busy__spinner" />
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={mergeBusy}
                  onClick={() => setMergeConfirmOpen(false)}
                >
                  {t("settings.confirm.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={mergeBusy}
                  onClick={() => void mergeAnnotationsIntoImage()}
                >
                  <Icon name="save" />
                  {mergeBusy
                    ? t("canvas.editor.merge.uploading")
                    : t("canvas.editor.merge.confirm.yes")}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showModeToggle && (
        <div className="row canvas-view-row" style={{ marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
          <span className="card__title" id="render-mode-label">
            {t("canvas.view")}
            <CanvasViewHelp />
          </span>
          <div
            className="segmented"
            role="radiogroup"
            aria-labelledby="render-mode-label"
          >
            {(["decimated", "native"] as VectorRenderMode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={renderMode === m}
                aria-pressed={renderMode === m}
                className="segmented__btn"
                title={
                  m === "decimated"
                    ? t("canvas.view.decimated.title", { edge: viewVectorEdge })
                    : hasExactNativeStride
                    ? t("canvas.view.native.title", { edge: DAC_RANGE, stride })
                    : t("canvas.view.native.title.custom", {
                        edge: DAC_RANGE,
                        sourceEdge: viewVectorEdge,
                      })
                }
                onClick={() => dispatch(setVectorRenderMode(m))}
              >
                <Icon name={m === "decimated" ? "scan" : "gridSvg"} tone="accent" />
                {m === "decimated"
                  ? t("canvas.view.decimated", { edge: viewVectorEdge })
                  : t("canvas.view.native", { edge: DAC_RANGE })}
              </button>
            ))}
          </div>
          <span className="canvas-view-row__editor-inline">
            {viewVectorEdge === DAC_RANGE && (
              <span className="muted canvas-view-row__stride-note">
                {t("canvas.view.identical")}
              </span>
            )}
            {toolbar}
          </span>
        </div>
      )}

      <div
        ref={frameRef}
        className="canvas-frame"
        onContextMenu={(event) => {
          if (editorEnabled) openContextMenu(event, null);
        }}
      >
          <canvas
            ref={canvasRef}
            width={nativeEdge}
            height={nativeEdge}
            onDragStart={(e) => e.preventDefault()}
            style={{
              display: displayedFigureUrl ? "none" : undefined,
            }}
          />
          {showCalibratedAxes && <LiveAxisOverlay roi={roi} showGrid={showGrid} t={t} />}
          {displayedFigureUrl && (
            <img
              className="server-figure"
              src={displayedFigureUrl}
              alt={t("canvas.serverFigure.alt", { kind: kindLabel })}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
            />
          )}
          {showScanPath && (
            <canvas
              ref={scanPathCanvasRef}
              className="canvas-scan-path-overlay"
              width={Math.min(256, Math.max(1, vectorEdge))}
              height={Math.min(256, Math.max(1, vectorEdge))}
              aria-label={t("vector.displayScanPath")}
            />
          )}
          {editorEnabled && (
            <div
              className="canvas-editor-layer"
              data-tool={activeTool}
              onPointerDown={handleEditorPointerDown}
              onPointerMove={handleEditorPointerMove}
              onPointerUp={handleEditorPointerUp}
              onClick={handleEditorSurfaceClick}
            >
              {annotations.map((annotation, index) => (
                annotation.kind === "rectangle" || annotation.kind === "circle" ? (
                  <div
                    key={annotation.id}
                    role="button"
                    tabIndex={0}
                    className={`canvas-editor__shape canvas-editor__shape--${annotation.kind}`}
                    data-selected={selectedAnnotationId === annotation.id ? "true" : "false"}
                    style={shapeStyle(annotation)}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedAnnotationId(annotation.id);
                      setContextMenu(null);
                    }}
                    onContextMenu={(event) => openContextMenu(event, annotation.id)}
                    title={t(
                      annotation.kind === "rectangle"
                        ? "canvas.editor.tool.rectangle"
                        : "canvas.editor.tool.circle"
                    )}
                  />
                ) : (
                  <button
                    key={annotation.id}
                    type="button"
                    className={`canvas-editor__annotation canvas-editor__annotation--${annotation.kind}`}
                    data-selected={selectedAnnotationId === annotation.id ? "true" : "false"}
                    style={{
                      left: `${annotation.x * 100}%`,
                      top: `${annotation.y * 100}%`,
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedAnnotationId(annotation.id);
                      setContextMenu(null);
                    }}
                    onContextMenu={(event) => openContextMenu(event, annotation.id)}
                    title={
                      annotation.kind === "comment"
                        ? annotation.text
                        : t("canvas.editor.tool.highlight")
                    }
                  >
                    <span
                      className="canvas-editor__annotation-index"
                      style={{
                        borderColor: annotation.strokeColor,
                        background: alphaColor(annotation.strokeColor, annotation.kind === "comment" ? 0.92 : 0.24),
                      }}
                    >
                      {index + 1}
                    </span>
                    {annotation.kind === "comment" && annotation.text && (
                      <span className="canvas-editor__label">{annotation.text}</span>
                    )}
                  </button>
                )
              ))}

              {draftShape && (
                <div
                  className={`canvas-editor__shape canvas-editor__shape--${draftShape.kind} canvas-editor__shape--draft`}
                  style={shapeStyle(draftShape)}
                />
              )}

              {commentDraft && (
                <form
                  className="canvas-editor__draft"
                  style={{
                    left: `${commentDraft.x * 100}%`,
                    top: `${commentDraft.y * 100}%`,
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveCommentDraft();
                  }}
                >
                  <input
                    autoFocus
                    className="input"
                    value={commentDraft.text}
                    placeholder={t("canvas.editor.comment.placeholder")}
                    onChange={(event) =>
                      setCommentDraft((current) =>
                        current ? { ...current, text: event.target.value } : current
                      )
                    }
                  />
                  <div className="button-row">
                    <button type="submit" className="btn btn--ghost">
                      {t("canvas.editor.comment.save")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setCommentDraft(null)}
                    >
                      {t("canvas.editor.comment.cancel")}
                    </button>
                  </div>
                </form>
              )}

              {contextMenu && (
                <div
                  className="canvas-editor__menu"
                  style={{ left: contextMenu.x, top: contextMenu.y }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <button
                    type="button"
                    className="canvas-editor__menu-item"
                    disabled={!annotations.length}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      undoLastAnnotation();
                    }}
                  >
                    {t("canvas.editor.context.undo")}
                  </button>
                  <button
                    type="button"
                    className="canvas-editor__menu-item"
                    disabled={!contextTargetId}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeAnnotation(contextTargetId);
                    }}
                  >
                    {t("canvas.editor.context.remove")}
                  </button>
                  <button
                    type="button"
                    className="canvas-editor__menu-item"
                    disabled={!annotations.length}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                    }}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                    }}
                    onClick={() => {
                      setAnnotations([]);
                      setSelectedAnnotationId(null);
                      invalidateMergedFigure();
                      setDraftShape(null);
                      setCommentDraft(null);
                      setContextMenu(null);
                    }}
                  >
                    {t("canvas.editor.context.clear")}
                  </button>
                </div>
              )}
            </div>
          )}
      </div>

      {showServerFigure && !serverFigureUrl && !mergedFigureUrl && (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          {serverFigureBusy
            ? t("canvas.serverFigure.rendering")
            : serverFigureError
            ? t("canvas.serverFigure.unavailable", { detail: serverFigureError })
            : t("canvas.serverFigure.livePreview")}
        </div>
      )}
      {editorError && (
        <div style={{ color: "var(--c-danger)", fontSize: 11, marginTop: 6 }}>
          {editorError}
        </div>
      )}

      <div className="progress" style={{ marginTop: 10 }}>
        <span style={{ width: `${pct}%` }} />
      </div>

      <div className="canvas-meta">
        <span>
          {t("canvas.meta.phase")} <b>{phaseLabel}</b>
        </span>
        <span>
          {t("canvas.meta.chunks")} <b>{fmt(chunksReceived)}</b>
        </span>
        <span>
          {t("canvas.meta.bytes")} <b>{fmt(bytesReceived)}</b>
        </span>
        <span>
          {t("canvas.meta.resolution")} <b>{fmt(nativeEdge)}×{fmt(nativeEdge)}</b>
        </span>
        {kind === "raster" ? (
          <>
            <span>
              {t("canvas.meta.pixels")}{" "}
              <b>
                {fmt(cursor)} / {fmt(totalRasterPx)}
              </b>
            </span>
          </>
        ) : (
          <>
            <span>
              {t("canvas.meta.samples")}{" "}
              <b>
                {fmt(visibleVectorCursor)}
                {totalVectorSamples > 0
                  ? ` / ${fmt(totalVectorSamples)}`
                  : ""}
              </b>
            </span>
            <span className="muted" style={{ fontSize: 11 }}>
              {/* vectorPattern is "default" / "custom" — pull the
                  matching translated noun. */}
              {vectorPattern === "default"
                ? t("vector.pattern.default")
                : t("vector.pattern.custom")}
              {vectorPattern === "default" && ` ${vectorEdge}×${vectorEdge}`}
            </span>
          </>
        )}
        <span title={t("canvas.meta.roi.title")}>
          {t("canvas.meta.roi")}{" "}
          <b>
            {formatPoint(activeRegion.x_start, activeRegion.y_start, roi.scale_unit)} →{" "}
            {formatPoint(activeRegion.x_end, activeRegion.y_end, roi.scale_unit)}
          </b>
        </span>
        {current && (
          <span title={t("canvas.meta.beam.title")}>
            {t("canvas.meta.beam")} <b>{formatPoint(current.x, current.y, roi.scale_unit)}</b>
          </span>
        )}
        {current && (
          <span title={t("canvas.meta.adcNow.title")}>
            {t("canvas.meta.adcNow")} <b>{current.adc}</b>
          </span>
        )}
        {stats.populated > 0 && (
          <span title={t("canvas.meta.adcRange.title")}>
            {t("canvas.meta.adcRange")} <b>{stats.min}..{stats.max}</b>
          </span>
        )}
      </div>
    </div>
  );
}

/* -------- scan metadata helpers --------------------------------------- *
 *
 * Everything below is pure math / canvas rendering — no user-visible
 * strings, no Redux access. Copied verbatim from the original. The
 * paint functions operate on raw buffers and would only need
 * translation if we ever surface their internal warnings/diagnostics,
 * which we don't.
 * --------------------------------------------------------------------- */

interface CurrentBeamArgs {
  kind: ScanKind;
  roi: ROIState;
  region: ROIRequest;
  rasterFrame: Uint16Array;
  rasterResolution: number;
  rasterCursor: number;
  vectorImage: Uint16Array;
  vectorEdge: number;
  vectorCursor: number;
  vectorPattern: "default" | "custom";
  vectorScanPath: VectorScanPath;
  vectorCustomPoints: Float32Array | null;
  vectorCustomRenderPoints: Float32Array | null;
}

interface CurrentBeamPosition {
  x: number;
  y: number;
  adc: number;
}

function clearCanvas(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function paintVectorScanOrderOverlay(
  canvas: HTMLCanvasElement,
  edge: number,
  cursor: number,
  scanPath: VectorScanPath,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const size = canvas.width;
  ctx.clearRect(0, 0, size, size);
  if (edge <= 0 || cursor <= 0) return;

  const total = vectorScanSampleCount(edge, scanPath);
  const limit = Math.min(cursor, total);
  const trailSamples = Math.min(limit, Math.max(24, Math.min(160, edge >> 2)));
  const first = limit - trailSamples;
  ctx.save();
  ctx.strokeStyle = "rgba(111, 190, 211, 0.18)";
  ctx.lineWidth = 0.55;
  ctx.beginPath();
  for (let index = first; index < limit; index++) {
    const point = vectorScanSamplePixel(index, edge, scanPath);
    if (!point) continue;
    const x = (point.x / Math.max(1, edge - 1)) * (size - 1);
    const y = (point.y / Math.max(1, edge - 1)) * (size - 1);
    if (index === first) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  const current = vectorScanSamplePixel(limit - 1, edge, scanPath);
  if (!current) return;
  const cx = (current.x / Math.max(1, edge - 1)) * (size - 1);
  const cy = (current.y / Math.max(1, edge - 1)) * (size - 1);
  ctx.save();
  ctx.fillStyle = "rgba(151, 210, 224, 0.48)";
  ctx.beginPath();
  ctx.arc(cx, cy, 1.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(151, 210, 224, 0.42)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.arc(cx, cy, 1.3, 0, Math.PI * 2);
  ctx.moveTo(cx - 2.3, cy);
  ctx.lineTo(cx + 2.3, cy);
  ctx.moveTo(cx, cy - 2.3);
  ctx.lineTo(cx, cy + 2.3);
  ctx.stroke();
  ctx.restore();
}

function activeROIRegion(roi: ROIState): ROIRequest {
  return roi.selection ?? {
    x_start: roi.x_origin,
    x_end: roi.x_end,
    y_start: roi.y_origin,
    y_end: roi.y_end,
  };
}

function currentBeamPosition(args: CurrentBeamArgs): CurrentBeamPosition | null {
  if (args.kind === "raster") {
    if (args.rasterCursor <= 0 || args.rasterResolution <= 0) return null;
    const idx = Math.min(args.rasterCursor, args.rasterFrame.length) - 1;
    const col = idx % args.rasterResolution;
    const row = Math.floor(idx / args.rasterResolution);
    return {
      ...mapIndexToRegion(col, row, args.rasterResolution, args.region),
      adc: args.rasterFrame[idx] ?? 0,
    };
  }

  if (args.vectorCursor <= 0 || args.vectorEdge <= 0) return null;
  const idx = args.vectorCursor - 1;
  if (args.vectorPattern === "custom" && args.vectorCustomPoints) {
    const pointCount = args.vectorCustomPoints.length / 2;
    if (idx >= pointCount) return null;
    const x = args.vectorCustomPoints[2 * idx] | 0;
    const y = args.vectorCustomPoints[2 * idx + 1] | 0;
    const renderCol = args.vectorCustomRenderPoints?.[2 * idx] ?? x;
    const renderRow = args.vectorCustomRenderPoints?.[2 * idx + 1] ?? y;
    const safeCol = Math.max(0, Math.min(args.vectorEdge - 1, renderCol | 0));
    const safeRow = Math.max(0, Math.min(args.vectorEdge - 1, renderRow | 0));
    return {
      x,
      y,
      adc: args.vectorImage[safeRow * args.vectorEdge + safeCol] ?? 0,
    };
  }

  const pixel = vectorScanSamplePixel(idx, args.vectorEdge, args.vectorScanPath);
  if (!pixel) return null;
  return {
    ...mapIndexToRegion(pixel.x, pixel.y, args.vectorEdge, args.region),
    adc: args.vectorImage[pixel.y * args.vectorEdge + pixel.x] ?? 0,
  };
}

function unitLabel(value: string) {
  switch (value) {
    case "um":
      return "μm";
    case "mm":
    case "cm":
    case "nm":
      return value;
    default:
      return value;
  }
}

function formatOneDecimal(v: number) {
  return Number.isFinite(v) ? v.toFixed(1) : "0.0";
}

function LiveAxisOverlay({
  roi,
  showGrid,
  t,
}: {
  roi: ROIState;
  showGrid: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const minorTicks = 20;
  const majorEvery = 5;
  const ticks = Array.from({ length: minorTicks + 1 }, (_, i) => {
    const ratio = i / minorTicks;
    return {
      key: i,
      ratio,
      percent: `${ratio * 100}%`,
      major: i % majorEvery === 0,
      xLabel: formatOneDecimal(roi.x_origin + (roi.x_end - roi.x_origin) * ratio),
      yLabel: formatOneDecimal(roi.y_origin + (roi.y_end - roi.y_origin) * ratio),
    };
  });
  const unit = unitLabel(roi.scale_unit);

  return (
    <div className="canvas-axis-overlay" aria-hidden="true">
      {showGrid && (
        <>
          {ticks.filter((tick) => tick.major).map((tick) => (
            <div
              key={`grid-x-${tick.key}`}
              className="canvas-axis-overlay__grid canvas-axis-overlay__grid--x"
              style={{ left: tick.percent }}
            />
          ))}
          {ticks.filter((tick) => tick.major).map((tick) => (
            <div
              key={`grid-y-${tick.key}`}
              className="canvas-axis-overlay__grid canvas-axis-overlay__grid--y"
              style={{ top: tick.percent }}
            />
          ))}
        </>
      )}
      <div className="canvas-axis-overlay__axis canvas-axis-overlay__axis--x" />
      <div className="canvas-axis-overlay__axis canvas-axis-overlay__axis--y" />
      {ticks.map((tick) => (
        <div
          key={`x-${tick.key}`}
          className={`canvas-axis-overlay__tick canvas-axis-overlay__tick--x${
            tick.major ? " canvas-axis-overlay__tick--major" : ""
          }`}
          style={{ left: tick.percent }}
        />
      ))}
      {ticks.map((tick) => (
        <div
          key={`y-${tick.key}`}
          className={`canvas-axis-overlay__tick canvas-axis-overlay__tick--y${
            tick.major ? " canvas-axis-overlay__tick--major" : ""
          }`}
          style={{ top: tick.percent }}
        />
      ))}
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`xl-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--x"
          style={{ left: tick.percent }}
        >
          {tick.xLabel}
        </span>
      ))}
      {ticks.filter((tick) => tick.major).map((tick) => (
        <span
          key={`yl-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--y"
          style={{ top: tick.percent }}
        >
          {tick.yLabel}
        </span>
      ))}
      <span className="canvas-axis-overlay__label canvas-axis-overlay__label--start">
        {t("roi.canvas.start", {
          point: `(${formatOneDecimal(roi.x_origin)}, ${formatOneDecimal(roi.y_origin)})`,
          unit,
        })}
      </span>
      <span className="canvas-axis-overlay__label canvas-axis-overlay__label--end">
        {t("roi.canvas.end", {
          point: `(${formatOneDecimal(roi.x_end)}, ${formatOneDecimal(roi.y_end)})`,
          unit,
        })}
      </span>
    </div>
  );
}

function mapIndexToRegion(
  col: number,
  row: number,
  edge: number,
  region: ROIRequest
): { x: number; y: number } {
  const denom = Math.max(1, edge - 1);
  return {
    x: lerp(region.x_start, region.x_end, col / denom),
    y: lerp(region.y_start, region.y_end, row / denom),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function formatPoint(x: number, y: number, unit: string): string {
  return `(${formatCoord(x)}, ${formatCoord(y)}) ${unit}`;
}

function formatCoord(v: number): string {
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
}

function normalizeShape(shape: DraftShape): Omit<CanvasAnnotation, "id" | "text"> | null {
  const x0 = Math.min(shape.x, shape.x2);
  const x1 = Math.max(shape.x, shape.x2);
  const y0 = Math.min(shape.y, shape.y2);
  const y1 = Math.max(shape.y, shape.y2);
  if (![x0, x1, y0, y1].every(Number.isFinite)) return null;
  return {
    kind: shape.kind,
    x: x0,
    y: y0,
    x2: x1,
    y2: y1,
    strokeColor: shape.strokeColor,
    lineStyle: shape.lineStyle,
    lineWidth: shape.lineWidth,
  };
}

function shapeTooSmall(shape: Pick<CanvasAnnotation, "x" | "y" | "x2" | "y2">): boolean {
  return Math.abs((shape.x2 ?? shape.x) - shape.x) < 0.008 || Math.abs((shape.y2 ?? shape.y) - shape.y) < 0.008;
}

function shapeStyle(shape: Pick<CanvasAnnotation, "kind" | "x" | "y" | "x2" | "y2" | "strokeColor" | "lineStyle" | "lineWidth">) {
  const x2 = shape.x2 ?? shape.x;
  const y2 = shape.y2 ?? shape.y;
  return {
    left: `${shape.x * 100}%`,
    top: `${shape.y * 100}%`,
    width: `${Math.max(0, x2 - shape.x) * 100}%`,
    height: `${Math.max(0, y2 - shape.y) * 100}%`,
    borderColor: shape.strokeColor,
    borderWidth: `${shape.lineWidth}px`,
    borderStyle: cssBorderStyle(shape.lineStyle),
  } as const;
}

function cssBorderStyle(lineStyle: LineStyle): "solid" | "dashed" | "dotted" {
  return lineStyle;
}

function canvasLineDash(lineStyle: LineStyle, lineWidth: number): number[] {
  if (lineStyle === "dashed") return [lineWidth * 4, lineWidth * 2];
  if (lineStyle === "dotted") return [lineWidth, lineWidth * 1.8];
  return [];
}

function alphaColor(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return `rgba(255, 214, 10, ${alpha})`;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawCanvasAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: CanvasAnnotation[],
  width: number,
  height: number
): void {
  const markerRadius = Math.max(12, Math.round(Math.min(width, height) * 0.02));
  const fontSize = Math.max(14, Math.round(markerRadius * 0.9));
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  annotations.forEach((annotation, index) => {
    const x = annotation.x * width;
    const y = annotation.y * height;

    ctx.save();
    ctx.lineWidth = annotation.lineWidth;
    ctx.strokeStyle = annotation.strokeColor;
    ctx.setLineDash(canvasLineDash(annotation.lineStyle, annotation.lineWidth));

    if (annotation.kind === "rectangle" || annotation.kind === "circle") {
      const x2 = (annotation.x2 ?? annotation.x) * width;
      const y2 = (annotation.y2 ?? annotation.y) * height;
      const w = Math.max(0, x2 - x);
      const h = Math.max(0, y2 - y);
      if (annotation.kind === "rectangle") {
        ctx.strokeRect(x, y, w, h);
      } else {
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.fillStyle = alphaColor(annotation.strokeColor, 0.24);
    ctx.arc(x, y, markerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#101820";
    ctx.font = `600 ${fontSize}px sans-serif`;
    ctx.fillText(String(index + 1), x, y + 0.5);

    if (annotation.kind === "comment" && annotation.text) {
      const bubblePaddingX = 10;
      const bubblePaddingY = 6;
      const bubbleText = annotation.text;
      ctx.font = `500 ${Math.max(12, Math.round(fontSize * 0.9))}px sans-serif`;
      ctx.textAlign = "left";
      const textWidth = ctx.measureText(bubbleText).width;
      const bubbleWidth = textWidth + bubblePaddingX * 2;
      const bubbleHeight = fontSize + bubblePaddingY * 2;
      const bubbleX = Math.min(width - bubbleWidth - 6, x + markerRadius + 8);
      const bubbleY = Math.max(6, y - bubbleHeight - 8);

      ctx.fillStyle = "rgba(16, 24, 32, 0.88)";
      roundRect(ctx, bubbleX, bubbleY, bubbleWidth, bubbleHeight, 8);
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(x + markerRadius * 0.55, y - markerRadius * 0.2);
      ctx.lineTo(bubbleX + 8, bubbleY + bubbleHeight);
      ctx.lineTo(bubbleX + 18, bubbleY + bubbleHeight);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "#f8fafc";
      ctx.fillText(bubbleText, bubbleX + bubblePaddingX, bubbleY + bubbleHeight / 2);
    }
    ctx.restore();
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`image load failed: ${src}`));
    image.src = src;
  });
}

/* -------- painters ----------------------------------------------------- */

function paintGrayscale(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  populated: number
): PaintStats {
  if (canvas.width !== edge || canvas.height !== edge) {
    canvas.width = edge;
    canvas.height = edge;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, buf.length);

  let lo = 65535;
  let hi = 0;
  for (let i = 0; i < limit; i++) {
    const v = buf[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (limit === 0) {
    lo = 0;
    hi = 0;
  }

  const img = ctx.createImageData(edge, edge);
  const data = img.data;

  const totalPx = edge * edge;
  const reg = limit < totalPx ? limit : totalPx;
  for (let i = 0; i < reg; i++) {
    const g = scaleSample(buf[i], lo, hi);
    const p = i * 4;
    data[p + 0] = g;
    data[p + 1] = g;
    data[p + 2] = g;
    data[p + 3] = 255;
  }
  for (let p = reg * 4; p < data.length; p += 4) {
    data[p + 0] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
    data[p + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);

  return { min: lo, max: hi, populated: limit };
}

function paintVectorDefault(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  populated: number,
  scanPath: VectorScanPath,
  graySpotSelection: GrayScaleSelection = null,
  graySpotColor: { r: number; g: number; b: number } = ROI_ACTION_BLANK_COLOR,
): PaintStats {
  if (canvas.width !== edge || canvas.height !== edge) {
    canvas.width = edge;
    canvas.height = edge;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, buf.length);
  const range = vectorDefaultRange(buf, edge, limit, scanPath);
  const img = ctx.createImageData(edge, edge);
  const data = img.data;

  for (let i = 0; i < limit; i++) {
    const pixel = vectorScanSamplePixel(i, edge, scanPath);
    if (!pixel) break;
    const idx = pixel.y * edge + pixel.x;
    const sample = buf[idx];
    const g = scaleSample(sample, range.min, range.max);
    const p = idx * 4;
    if (sampleInGraySpotSelection(sample, graySpotSelection)) {
      paintSpotPixel(data, p, graySpotColor);
    } else {
      data[p + 0] = g;
      data[p + 1] = g;
      data[p + 2] = g;
    }
    data[p + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return range;
}

function paintVectorCustom(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  points: Float32Array,
  populated: number,
  blankMask: Uint8Array | null,
  spotMask: Uint8Array | null,
  graySpotColor: { r: number; g: number; b: number },
): PaintStats {
  if (canvas.width !== edge || canvas.height !== edge) {
    canvas.width = edge;
    canvas.height = edge;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, points.length / 2);
  let lo = 65535;
  let hi = 0;
  let visible = 0;
  for (let i = 0; i < limit; i++) {
    if (blankMask?.[i] === 1) continue;
    const x = points[2 * i] | 0;
    const y = points[2 * i + 1] | 0;
    if (x < 0 || x >= edge || y < 0 || y >= edge) continue;
    const v = buf[y * edge + x];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    visible++;
  }
  if (visible === 0) {
    lo = 0;
    hi = 0;
  }

  const img = ctx.createImageData(edge, edge);
  const data = img.data;
  for (let i = 0; i < limit; i++) {
    const x = points[2 * i] | 0;
    const y = points[2 * i + 1] | 0;
    if (x < 0 || x >= edge || y < 0 || y >= edge) continue;
    const idx = y * edge + x;
    const g = scaleSample(buf[idx], lo, hi);
    const p = idx * 4;
    if (blankMask?.[i] === 1) {
      paintSpotPixel(data, p, ROI_ACTION_BLANK_COLOR);
    } else if (spotMask?.[i] === 1) {
      paintSpotPixel(data, p, graySpotColor);
    } else {
      data[p + 0] = g;
      data[p + 1] = g;
      data[p + 2] = g;
    }
    data[p + 3] = 255;
  }

  // Spot selections must win even when multiple source points collapse
  // onto the same rendered pixel. A final overlay pass avoids a later
  // non-spot point repainting the selected pixel back to grayscale.
  if (spotMask) {
    for (let i = 0; i < limit; i++) {
      if (spotMask[i] !== 1 || blankMask?.[i] === 1) continue;
      const x = points[2 * i] | 0;
      const y = points[2 * i + 1] | 0;
      if (x < 0 || x >= edge || y < 0 || y >= edge) continue;
      const p = (y * edge + x) * 4;
      paintSpotPixel(data, p, graySpotColor);
      data[p + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return { min: lo, max: hi, populated: limit };
}

function paintVectorDefaultBlockFill(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  populated: number,
  scanPath: VectorScanPath,
  graySpotSelection: GrayScaleSelection = null,
  graySpotColor: { r: number; g: number; b: number } = ROI_ACTION_BLANK_COLOR,
): PaintStats {
  const nativeSize = DAC_RANGE;
  if (canvas.width !== nativeSize || canvas.height !== nativeSize) {
    canvas.width = nativeSize;
    canvas.height = nativeSize;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, buf.length);

  const range = vectorDefaultRange(buf, edge, limit, scanPath);

  const img = ctx.createImageData(nativeSize, nativeSize);
  const data = img.data;

  for (let p = 0; p < data.length; p += 4) {
    data[p + 0] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
    data[p + 3] = 0;
  }

  for (let i = 0; i < limit; i++) {
    const pixel = vectorScanSamplePixel(i, edge, scanPath);
    if (!pixel) break;
    const cellCol = pixel.x;
    const cellRow = pixel.y;
    const cellIdx = cellRow * edge + cellCol;
    const sample = buf[cellIdx];
    const g = scaleSample(sample, range.min, range.max);
    const isSpot = sampleInGraySpotSelection(sample, graySpotSelection);
    const baseY = Math.floor((cellRow * nativeSize) / edge);
    const nextY = Math.floor(((cellRow + 1) * nativeSize) / edge);
    const baseX = Math.floor((cellCol * nativeSize) / edge);
    const nextX = Math.floor(((cellCol + 1) * nativeSize) / edge);
    const blockHeight = Math.max(1, nextY - baseY);
    const blockWidth = Math.max(1, nextX - baseX);

    for (let dy = 0; dy < blockHeight; dy++) {
      let p = ((baseY + dy) * nativeSize + baseX) * 4;
      for (let dx = 0; dx < blockWidth; dx++) {
        if (isSpot) {
          paintSpotPixel(data, p, graySpotColor);
        } else {
          data[p + 0] = g;
          data[p + 1] = g;
          data[p + 2] = g;
        }
        data[p + 3] = 255;
        p += 4;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return range;
}

function vectorDefaultRange(
  buf: Uint16Array,
  edge: number,
  limit: number,
  scanPath: VectorScanPath,
): PaintStats {
  let lo = 65535;
  let hi = 0;
  for (let i = 0; i < limit; i++) {
    const pixel = vectorScanSamplePixel(i, edge, scanPath);
    if (!pixel) break;
    const v = buf[pixel.y * edge + pixel.x];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (limit === 0) {
    lo = 0;
    hi = 0;
  }
  return { min: lo, max: hi, populated: limit };
}

function scaleSample(value: number, lo: number, hi: number): number {
  if (hi <= lo) return hi > 0 ? 255 : 0;
  return Math.max(0, Math.min(255, Math.round(((value - lo) * 255) / (hi - lo))));
}

function sampleInGraySpotSelection(sample: number, selection: GrayScaleSelection): boolean {
  if (!selection) return false;
  return grayScaleSelectionContains(selection, sample >> 8);
}

function paintSpotPixel(
  data: Uint8ClampedArray,
  offset: number,
  color: { r: number; g: number; b: number }
): void {
  data[offset + 0] = color.r;
  data[offset + 1] = color.g;
  data[offset + 2] = color.b;
}

async function uploadMergedFigure(
  kind: Extract<ScanKind, "raster" | "vector">,
  dataUrl: string,
  filename: string | null,
): Promise<void> {
  const response = await fetch(apiUrl("/api/admin/ftp/merged-figure"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
    body: JSON.stringify({
      kind,
      data_url: dataUrl,
      filename,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `HTTP ${response.status}`);
  }
}
