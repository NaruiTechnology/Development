/**
 * Renders the raster grayscale frame or vector ADC image onto a canvas.
 *
 * Raster and vector scans are stored as flat Uint16Array buffers. The
 * hardware returns OBI-compatible left-aligned 14-bit ADC samples in a
 * Uint16Array. A real detector signal uses only a small slice of that range,
 * so the image is drawn through black/white display levels, exactly like
 * OBI's histogram + gradient "wedge": automatic by default (darkest and
 * brightest 0.5 % of pixels trimmed) or set by dragging the wedge that sits
 * to the right of the canvas. Gray-selection controls still use the absolute
 * 0..0xfffc scale.
 *
 * For raster the buffer is populated row-major as the FPGA emits samples.
 * For vector default, samples arrive x-major/y-inner and are painted back
 * to their actual populated cells. For vector custom, only requested
 * point coordinates are painted; unpopulated cells stay transparent.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useAppDispatch, useAppSelector } from "../store";
import { orientCanvas } from "../lib/canvasOrientation";
import {
  setVectorRenderMode,
  updateROI,
  type ScanKind,
  type ROIState,
  type StreamTransforms,
  type VectorRenderMode,
} from "../store/scanSlice";
import type { ROIRequest, VectorScanPath } from "../types/api";
import { useTranslation, type TranslationKey } from "../i18n";
import { scanAuthHeaders } from "../lib/authIdentity";
import { markScanPerformanceCanvasReady } from "../lib/scanPerformance";
import { clampImagePane } from "../lib/imagePanelLayout";
import { drawScanParamChip, exportScaleFactor, type ScanParamItem } from "../lib/scanParamChip";
import { apiUrl } from "../lib/backendUrl";
import { grayScaleSelectionContains, type GrayScaleSelection } from "../lib/grayScaleSelection";
import { Icon } from "./Icon";
import { LoadingSpinner } from "./LoadingSpinner";
import { CanvasViewHelp } from "./CanvasViewHelp";
import { vectorScanSampleCount, vectorScanSamplePixel } from "../lib/vectorScanPath";
import { scaleScanSample } from "../lib/scanSamples";
import {
  AUTO_LEVELS,
  buildHistogram,
  levelGray,
  resolveLevels,
  type LevelHistogram,
  type LevelSetting,
  type ResolvedLevels,
} from "../lib/displayLevels";
import { LevelWedge } from "./LevelWedge";

const DAC_RANGE = 2048;
// Match the dark red used by ROI's beam-hit/filtered-pixel overlay.
const ROI_ACTION_BLANK_COLOR = { r: 97, g: 0, b: 0 };
const ROI_ACTION_HIGHLIGHT_COLOR = { r: 253, g: 224, b: 71 };

interface PaintStats {
  min: number;
  max: number;
  populated: number;
  /** Histogram of the painted samples and the black/white levels applied. */
  histogram?: LevelHistogram;
  low?: number;
  high?: number;
}

// Display levels are an operator setting, like OBI's wedge: they survive a
// new scan and a remount of the panel, per scan kind.
const levelMemory: Partial<Record<string, LevelSetting>> = {};

// Everything a painter needs to redraw a scan. The live canvas paints from a
// snapshot that references the store buffers; an archived scan keeps a copy
// so a "Previous scan" pane can be repainted through its own level wedge.
type GrayColor = { r: number; g: number; b: number };
type PaintSnapshot =
  | { mode: "clear"; transforms: StreamTransforms }
  | { mode: "grayscale"; buf: Uint16Array; edge: number; populated: number; transforms: StreamTransforms }
  | {
      mode: "vectorDefault" | "vectorBlock";
      buf: Uint16Array;
      edge: number;
      populated: number;
      scanPath: VectorScanPath;
      graySelection: GrayScaleSelection;
      graySkipped: boolean | null;
      grayColor: GrayColor;
      transforms: StreamTransforms;
    }
  | {
      mode: "vectorCustom";
      buf: Uint16Array;
      edge: number;
      points: Float32Array;
      populated: number;
      blankMask: Uint8Array | null;
      spotMask: Uint8Array | null;
      grayColor: GrayColor;
      transforms: StreamTransforms;
    };

// Raw data of captured scans, keyed by the image URL that App stores in the
// pane slots. Bounded so old scans do not pile up; evicted images are
// decoded into grayscale samples to keep the same level controls.
const ARCHIVED_PAINT_LIMIT = 12;
const archivedPaints = new Map<string, PaintSnapshot>();

function rememberArchivedPaint(imageUrl: string, snapshot: PaintSnapshot): void {
  archivedPaints.delete(imageUrl);
  archivedPaints.set(imageUrl, copyPaintSnapshot(snapshot));
  while (archivedPaints.size > ARCHIVED_PAINT_LIMIT) {
    const oldest = archivedPaints.keys().next().value;
    if (oldest === undefined) break;
    archivedPaints.delete(oldest);
  }
}

// Scan settings of each completed image, keyed like archivedPaints, so a
// "Previous scan" pane keeps showing the parameter chip of its own scan.
const archivedScanParams = new Map<string, ScanParamItem[]>();

function rememberScanParams(imageUrl: string, items: ScanParamItem[]): void {
  archivedScanParams.delete(imageUrl);
  archivedScanParams.set(imageUrl, items);
  while (archivedScanParams.size > ARCHIVED_PAINT_LIMIT) {
    const oldest = archivedScanParams.keys().next().value;
    if (oldest === undefined) break;
    archivedScanParams.delete(oldest);
  }
}

// Per scan kind: a counter that advances each time a scan starts running, and
// the image buffer that scan was writing into. A completed image is archived
// only when it was painted from that buffer, so a buffer reset between scans
// (e.g. after a resolution change) is never mistaken for a scan result.
const scanSequenceMemory: Partial<Record<string, number>> = {};
const runBufferMemory: Partial<Record<string, Uint16Array>> = {};
const NO_STREAM_TRANSFORMS: StreamTransforms = { xflip: false, yflip: false, rotate90: false };

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
  onPaneImageChange,
  onPaneRecycle,
  vectorGrayScaleSelection = null,
  vectorGrayScaleSkipped = null,
  imageLayout = 1,
  singlePaneImage = null,
  singlePaneSourceIndex = 0,
  imageSlots = [],
  selectedPane: controlledSelectedPane,
  scanTargetPane: requestedScanTargetPane,
  onSelectedPaneChange,
  ignoreTransforms = false,
}: {
  kind: ScanKind;
  /** `scanId` is the same for every image of one scan run and changes when a new scan starts. */
  onRenderedImageChange?: (kind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null, scanId: number) => void;
  onMergedFigureChange?: (kind: Extract<ScanKind, "raster" | "vector">, imageUrl: string | null) => void;
  onPaneRecycle?: (kind: "raster" | "vector", pane: number) => void;
  onPaneImageChange?: (kind: Extract<ScanKind, "raster" | "vector">, pane: number, imageUrl: string) => void;
  vectorGrayScaleSelection?: [number, number] | null;
  vectorGrayScaleSkipped?: boolean | null;
  imageLayout?: 1 | 2 | 3 | 4;
  singlePaneImage?: string | null;
  singlePaneSourceIndex?: number;
  imageSlots?: Array<string | null>;
  selectedPane?: number;
  scanTargetPane?: number;
  onSelectedPaneChange?: (kind: Extract<ScanKind, "raster" | "vector">, pane: number) => void;
  /** Paint in source orientation, ignoring the transform settings (ROI scans). */
  ignoreTransforms?: boolean;
}) {
  const dispatch = useAppDispatch();
  const { t, fmt } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanPathCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const archivedPaneFramesRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const liveSnapshotRef = useRef<PaintSnapshot | null>(null);
  const annotationSeqRef = useRef(0);
  const [stats, setStats] = useState<PaintStats>({ min: 0, max: 0, populated: 0 });
  const [levelSetting, setLevelSettingState] = useState<LevelSetting>(
    () => levelMemory[kind] ?? AUTO_LEVELS,
  );
  const pendingLevelRef = useRef<LevelSetting | null>(null);
  const levelFrameRef = useRef<number | null>(null);
  // Repaint at most once per animation frame while a wedge handle is dragged.
  const applyLevelSetting = useCallback(
    (next: LevelSetting) => {
      levelMemory[kind] = next;
      pendingLevelRef.current = next;
      if (levelFrameRef.current !== null) return;
      levelFrameRef.current = window.requestAnimationFrame(() => {
        levelFrameRef.current = null;
        if (pendingLevelRef.current) setLevelSettingState(pendingLevelRef.current);
        pendingLevelRef.current = null;
      });
    },
    [kind],
  );
  useEffect(
    () => () => {
      if (levelFrameRef.current !== null) window.cancelAnimationFrame(levelFrameRef.current);
    },
    [],
  );
  const handleWedgeChange = useCallback(
    (levels: ResolvedLevels) => applyLevelSetting({ mode: "manual", low: levels.low, high: levels.high }),
    [applyLevelSetting],
  );
  const handleWedgeAuto = useCallback(() => applyLevelSetting(AUTO_LEVELS), [applyLevelSetting]);
  const [serverFigureUrl, setServerFigureUrl] = useState<string | null>(null);
  const [serverFigureBusy, setServerFigureBusy] = useState(false);
  const [serverFigureError, setServerFigureError] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<AnnotationTool>("highlight");
  const [strokeColor, setStrokeColor] = useState("lawngreen");
  const [lineStyle, setLineStyle] = useState<LineStyle>("solid");
  const [lineWidth, setLineWidth] = useState(0.5);
  const initialSelectedPane = clampImagePane(controlledSelectedPane ?? imageLayout - 1, imageLayout);
  const [selectedPane, setSelectedPane] = useState(initialSelectedPane);
  const selectedPaneRef = useRef(selectedPane);
  selectedPaneRef.current = selectedPane;
  const scanTargetPane = clampImagePane(requestedScanTargetPane ?? imageLayout - 1, imageLayout);
  const scanTargetPaneRef = useRef(scanTargetPane);
  scanTargetPaneRef.current = scanTargetPane;
  const [annotationsByPane, setAnnotationsByPane] = useState<Record<number, CanvasAnnotation[]>>({});
  const annotations = annotationsByPane[selectedPane] ?? [];
  const setAnnotations = useCallback((next: CanvasAnnotation[] | ((current: CanvasAnnotation[]) => CanvasAnnotation[])) => {
    const pane = selectedPaneRef.current;
    setAnnotationsByPane((current) => {
      const paneAnnotations = current[pane] ?? [];
      const nextAnnotations = typeof next === "function" ? next(paneAnnotations) : next;
      return { ...current, [pane]: nextAnnotations };
    });
  }, []);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const editorPressSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [draftShape, setDraftShape] = useState<DraftShape | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [mergedFigureUrl, setMergedFigureUrl] = useState<string | null>(null);
  const [mergedFigureFilename, setMergedFigureFilename] = useState<string | null>(null);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [acknowledgedAnnotationsByPane, setAcknowledgedAnnotationsByPane] = useState<Record<number, CanvasAnnotation[]>>({});
  const [mergeBusy, setMergeBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  // The image panel header (raster / vector) has a spot on its first row for
  // the vector View selector; without it (e.g. ROI) the selector stays inline.
  const [viewToggleHost, setViewToggleHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const nextSelectedPane = clampImagePane(controlledSelectedPane ?? imageLayout - 1, imageLayout);
    setSelectedPane(nextSelectedPane);
    selectedPaneRef.current = nextSelectedPane;
    editorPressSurfaceRef.current = null;
    setSelectedAnnotationId(null);
    setDraftShape(null);
    setCommentDraft(null);
    setContextMenu(null);
  }, [controlledSelectedPane, imageLayout]);
  const lastRenderedImageEmitRef = useRef<{
    kind: Extract<ScanKind, "raster" | "vector">;
    imageUrl: string | null;
    revision: number;
    scanId: number;
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
  // Valid raster pixels; stays at the full frame once a live scan wraps.
  const rasterFilled = useAppSelector((s) => s.image.filled);

  // Vector fields
  const vectorEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorImage = useAppSelector((s) => s.image.vectorImage);
  const vectorCustomPoints = useAppSelector((s) => s.image.vectorCustomPoints);
  const vectorCustomRenderPoints = useAppSelector((s) => s.image.vectorCustomRenderPoints);
  const vectorCustomBlankMask = useAppSelector((s) => s.image.vectorCustomBlankMask);
  const vectorCustomSpotMask = useAppSelector((s) => s.image.vectorCustomSpotMask);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  // Valid vector samples; stays at the full pass once a live scan wraps.
  const vectorFilled = useAppSelector((s) => s.image.vectorFilled);
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
  const configuredStreamTransforms = useAppSelector((s) => s.scan.streamTransforms);
  // Only control changes update the selected pane. Selecting a different pane
  // must not apply the previous pane's controls to its archived scan.
  const transformsByKindRef = useRef<Partial<Record<ScanKind, Array<StreamTransforms | undefined>>>>({});
  const paneTransforms = transformsByKindRef.current[kind] ??= [];
  const previousConfiguredTransformsRef = useRef(configuredStreamTransforms);
  for (let pane = 0; pane < imageLayout; pane += 1) {
    if (!paneTransforms[pane]) {
      const imageUrl = imageSlots[pane];
      paneTransforms[pane] =
        (imageUrl ? archivedPaints.get(imageUrl)?.transforms : undefined) ?? configuredStreamTransforms;
    }
  }
  if (previousConfiguredTransformsRef.current !== configuredStreamTransforms) {
    paneTransforms[selectedPane] = configuredStreamTransforms;
    previousConfiguredTransformsRef.current = configuredStreamTransforms;
  }
  const streamTransforms = ignoreTransforms
    ? NO_STREAM_TRANSFORMS
    : imageLayout === 1
      ? configuredStreamTransforms
      : paneTransforms[scanTargetPane] ?? configuredStreamTransforms;

  const phase = useAppSelector((s) => s.scan.phase);
  const lastResult = useAppSelector((s) => s.scan.lastResult);
  const lastOutput = useAppSelector((s) => s.scan.lastOutput);
  const bytesReceived = useAppSelector((s) => s.scan.bytesReceived);
  const chunksReceived = useAppSelector((s) => s.scan.chunksReceived);
  const lastScanParams = useAppSelector((s) => s.scan.lastScanParams);
  const lastScanParamsRef = useRef(lastScanParams);
  lastScanParamsRef.current = lastScanParams;
  const completedKind = lastOutput?.kind ?? lastResult?.kind ?? null;
  const hasPaintedCanvasImage = stats.populated > 0;
  const showServerFigure =
    !ignoreTransforms &&
    phase === "completed" &&
    completedKind === kind &&
    (kind !== "vector" || vectorSource === "vector");
  const hasLiveCanvasData =
    kind === "raster" ? rasterFilled > 0 : kind === "vector" ? vectorSource === "vector" && vectorFilled > 0 : false;
  const visibleVectorCursor = kind === "vector" && vectorSource !== "vector" ? 0 : vectorCursor;
  const hasRenderedCanvasImage =
    hasPaintedCanvasImage || Boolean(serverFigureUrl) || Boolean(mergedFigureUrl);
  const selectedPaneHasImage = selectedPane !== scanTargetPane && Boolean(imageSlots[selectedPane]);
  const selectedTargetHasImage = selectedPane === scanTargetPane &&
    (imageLayout === 1 || Boolean(imageSlots[scanTargetPane]));
  const editorEnabled = selectedPaneHasImage ||
    (selectedTargetHasImage && phase === "completed" && hasRenderedCanvasImage);
  const toolbarVisible = editorEnabled;
  // A target pane added by the layout button stays empty until a scan fills it.
  const targetParked =
    imageLayout > 1 && phase !== "running" && phase !== "stopping" && !imageSlots[scanTargetPane];
  // Settings chip of the scan the live pane is showing (only once it completed).
  const liveScanParamItems =
    phase === "completed" &&
    !targetParked &&
    lastScanParams?.kind === kind &&
    (completedKind === null || completedKind === kind) &&
    (hasLiveCanvasData || hasRenderedCanvasImage)
      ? lastScanParams.items
      : null;
  const editorToolbarVisible = toolbarVisible;
  const showCalibratedAxes = kind !== "roi";
  const showGrid =
    kind === "raster"
      ? roi.raster_show_grid
      : kind === "vector"
        ? roi.vector_show_grid
        : roi.show_grid;
  const [paneGridByKind, setPaneGridByKind] = useState<Partial<Record<ScanKind, boolean[]>>>({});
  const previousGridDefaultsRef = useRef<Partial<Record<ScanKind, boolean>>>({});
  const paneGridVisibility = paneGridByKind[kind] ?? Array<boolean>(4).fill(showGrid);
  useEffect(() => {
    const previous = previousGridDefaultsRef.current[kind];
    previousGridDefaultsRef.current[kind] = showGrid;
    // A header-switch change updates this view; switching scan kinds must
    // preserve each pane's independent grid choice.
    if (previous !== undefined && previous !== showGrid) {
      setPaneGridByKind((current) => ({ ...current, [kind]: Array<boolean>(4).fill(showGrid) }));
    }
  }, [showGrid, kind]);
  const setPaneGrid = (index: number, visible: boolean) => {
    setPaneGridByKind((current) => ({
      ...current,
      [kind]: (current[kind] ?? Array<boolean>(4).fill(showGrid))
        .map((value, pane) => pane === index ? visible : value),
    }));
  };
  const showScanPath =
    (kind === "raster" || (kind === "vector" && vectorPattern === "default")) &&
    (kind === "raster" ? roi.raster_show_scan_path : roi.vector_show_scan_path);

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

  // Capture run identity and buffer before the paint effect.
  // Orientation follows the shared controls immediately, including during a run.
  const previousPhaseRef = useRef(phase);
  useEffect(() => {
    if (kind !== "raster" && kind !== "vector") return;
    if (phase === "running" || phase === "stopping") {
      const wasRunning = previousPhaseRef.current === "running" || previousPhaseRef.current === "stopping";
      if (!wasRunning) {
        scanSequenceMemory[kind] = (scanSequenceMemory[kind] ?? 0) + 1;
      }
      runBufferMemory[kind] = kind === "raster" ? frame : vectorImage;
    }
    previousPhaseRef.current = phase;
  }, [kind, phase, revision, frame, vectorImage, streamTransforms]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const paintTransforms = streamTransforms;

    let snapshot: PaintSnapshot;
    if (kind === "raster") {
      snapshot = { mode: "grayscale", buf: frame, edge: resolution, populated: rasterFilled, transforms: paintTransforms };
    } else if (kind === "vector" && vectorSource !== "vector") {
      snapshot = { mode: "clear", transforms: paintTransforms };
    } else if (kind === "vector" && vectorPattern === "default") {
      snapshot = {
        mode: renderMode === "native" && vectorEdge < DAC_RANGE ? "vectorBlock" : "vectorDefault",
        buf: vectorImage,
        edge: vectorEdge,
        populated: vectorFilled,
        scanPath: vectorScanPath,
        graySelection: vectorGraySpotSelection,
        graySkipped: vectorGraySpotSkipped,
        grayColor: vectorGraySpotColor,
        transforms: paintTransforms,
      };
    } else if (kind === "vector" && vectorCustomRenderPoints) {
      snapshot = {
        mode: "vectorCustom",
        buf: vectorImage,
        edge: vectorEdge,
        points: vectorCustomRenderPoints,
        populated: vectorFilled,
        blankMask: vectorCustomBlankMask,
        spotMask: vectorCustomSpotMask,
        grayColor: vectorGraySpotColor,
        transforms: paintTransforms,
      };
    } else {
      snapshot = { mode: "grayscale", buf: vectorImage, edge: vectorEdge, populated: vectorFilled, transforms: paintTransforms };
    }
    liveSnapshotRef.current = snapshot;
    setStats(paintSnapshot(canvas, snapshot, levelSetting));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    revision,
    kind,
    renderMode,
    theme,
    vectorGraySpotSelection,
    vectorGraySpotSkipped,
    levelSetting,
    streamTransforms,
    singlePaneImage,
  ]);

  useEffect(() => {
    if (singlePaneImage || !onRenderedImageChangeRef.current || (kind !== "raster" && kind !== "vector")) return;
    const scanId = scanSequenceMemory[kind] ?? 0;

    const emit = (imageUrl: string | null) => {
      const previous = lastRenderedImageEmitRef.current;
      if (previous?.kind === kind && previous.imageUrl === imageUrl && previous.revision === revision && previous.scanId === scanId) return;
      lastRenderedImageEmitRef.current = { kind, imageUrl, revision, scanId };
      onRenderedImageChangeRef.current?.(kind, imageUrl, scanId);
    };

    // Use the image-buffer revision as well as its URL: two different scans
    // can render identical pixels but must still be archived separately.
    if (!hasLiveCanvasData) {
      emit(null);
      return;
    }
    if (phase !== "completed") return;
    // Only a buffer the last scan actually ran into is a scan result.
    const liveBuffer = kind === "raster" ? frame : vectorImage;
    const runBuffer = runBufferMemory[kind];
    if (!runBuffer || runBuffer !== liveBuffer) return;

    const handle = window.requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;
      try {
        const image = canvas.toDataURL("image/png");
        markScanPerformanceCanvasReady(kind);
        const snapshot = liveSnapshotRef.current;
        if (snapshot) rememberArchivedPaint(image, snapshot);
        const scanParams = lastScanParamsRef.current;
        if (scanParams?.kind === kind) rememberScanParams(image, scanParams.items);
        emit(image);
      } catch {
        emit(null);
      }
    });

    return () => window.cancelAnimationFrame(handle);
  }, [
    kind,
    phase,
    revision,
    renderMode,
    cursor,
    vectorCursor,
    hasLiveCanvasData,
    streamTransforms,
    vectorGraySpotSelection,
    vectorGraySpotSkipped,
    vectorGraySpotColor,
    singlePaneImage,
  ]);

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
      const targetSelected = selectedPaneRef.current === scanTargetPaneRef.current;
      if (targetSelected) {
        setAnnotations([]);
        setMergedFigureUrl(null);
      }
      setSelectedAnnotationId(null);
      setDraftShape(null);
      setCommentDraft(null);
      setContextMenu(null);
      setMergeConfirmOpen(false);
      setMergeBusy(false);
      setEditorError(null);
      if (notifyMerged && selectedPaneRef.current === scanTargetPaneRef.current && (kind === "raster" || kind === "vector")) {
        onMergedFigureChangeRef.current?.(kind, null);
      }
    },
    [kind]
  );

  const invalidateMergedFigure = useCallback(() => {
    if (selectedPaneRef.current !== scanTargetPaneRef.current) return;
    setMergedFigureUrl(null);
    if (kind === "raster" || kind === "vector") {
      onMergedFigureChangeRef.current?.(kind, null);
    }
  }, [kind]);

  // The paint effect above already refreshes `stats` (and the wedge histogram)
  // whenever `kind` changes; resetting them here would run after it and blank
  // the wedge on mount.
  useEffect(() => {
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
    if (typeof document === "undefined") return;
    const host = document.getElementById("image-panel-view-slot");
    setViewToggleHost((current) => (current === host ? current : host));
  });

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
  }, [showServerFigure, kind, renderMode, chunksReceived, streamTransforms]);

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
    !hasLiveCanvasData;
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
    const edge = kind === "raster" ? resolution : vectorEdge;
    const receivedCursor = kind === "raster" ? cursor : visibleVectorCursor;
    const path = kind === "raster" ? "horizontal_sawtooth" : vectorScanPath;
    const running = phase === "running";
    let animationFrame = 0;
    const draw = (now: number) => {
      // Chunks commonly end on whole rows. Animate the visual indicator within
      // the active sweep; this is not a per-pixel hardware position report.
      const sweepStart = Math.floor(Math.max(0, receivedCursor - 1) / edge) * edge;
      const indicatorCursor = running
        ? sweepStart + Math.floor(((now % 800) / 800) * edge) + 1
        : receivedCursor;
      paintVectorScanOrderOverlay(canvas, edge, indicatorCursor, path);
      orientCanvas(canvas, streamTransforms);
      if (running) animationFrame = requestAnimationFrame(draw);
    };
    draw(performance.now());
    return () => cancelAnimationFrame(animationFrame);
  }, [revision, showScanPath, kind, resolution, cursor, vectorEdge, vectorScanPath, visibleVectorCursor, streamTransforms, phase]);

  const phaseKey = PHASE_KEYS[phase];
  const kindKey = KIND_KEYS[kind];
  const phaseLabel = phaseKey ? t(phaseKey) : phase;
  const kindLabel = kindKey ? t(kindKey) : kind;
  const contextTargetId = contextMenu?.annotationId ?? selectedAnnotationId;

  function nextAnnotationId(): string {
    annotationSeqRef.current += 1;
    return `annotation-${annotationSeqRef.current}`;
  }

  function getSelectedPaneFrame(): HTMLDivElement | null {
    const pane = selectedPaneRef.current;
    if (pane === scanTargetPaneRef.current) return frameRef.current;
    return archivedPaneFramesRef.current.get(pane) ?? null;
  }

  function selectPane(pane: number) {
    if (pane === selectedPaneRef.current) return;
    selectedPaneRef.current = pane;
    setSelectedPane(pane);
    if (kind === "raster" || kind === "vector") onSelectedPaneChange?.(kind, pane);
    setSelectedAnnotationId(null);
    setDraftShape(null);
    setCommentDraft(null);
    setContextMenu(null);
  }

  function toRelativePoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const frame = getSelectedPaneFrame();
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
    const frame = getSelectedPaneFrame();
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    setContextMenu({
      x: Math.min(rect.width - 8, Math.max(8, event.clientX - rect.left)),
      y: Math.min(rect.height - 8, Math.max(8, event.clientY - rect.top)),
      annotationId,
    });
  }

  function handleEditorSurfaceClick(event: React.MouseEvent<HTMLDivElement>) {
    const pressSurface = editorPressSurfaceRef.current;
    editorPressSurfaceRef.current = null;
    // A control click or forwarded label click is not an image-edit gesture.
    if (!editorEnabled || pressSurface !== event.currentTarget || event.target !== event.currentTarget || event.detail === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
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
    editorPressSurfaceRef.current = null;
    if (!editorEnabled || event.button !== 0 || event.target !== event.currentTarget) return;
    editorPressSurfaceRef.current = event.currentTarget;
    if (activeTool !== "rectangle" && activeTool !== "circle") return;
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
    const mergePane = selectedPane;
    const archivedImageUrl = mergePane !== scanTargetPane ? imageSlots[mergePane] ?? null : null;
    setMergeBusy(true);
    try {
      const sourceCanvas = canvasRef.current;
      const exportCanvas = document.createElement("canvas");
      const ctx = exportCanvas.getContext("2d");
      if (!ctx) throw new Error(t("canvas.editor.merge.error"));

      // Low-resolution scans are enlarged by an integer factor (no smoothing,
      // pixels stay crisp blocks) so annotation labels and the parameter chip
      // stay proportionate instead of covering the whole image.
      const drawScaled = (source: CanvasImageSource, w: number, h: number) => {
        const scale = exportScaleFactor(w, h);
        exportCanvas.width = w * scale;
        exportCanvas.height = h * scale;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, 0, 0, exportCanvas.width, exportCanvas.height);
      };
      if (archivedImageUrl || displayedFigureUrl) {
        const image = await loadImage(archivedImageUrl ?? displayedFigureUrl!);
        drawScaled(image, image.naturalWidth || image.width, image.naturalHeight || image.height);
      } else if (sourceCanvas) {
        drawScaled(sourceCanvas, sourceCanvas.width, sourceCanvas.height);
      } else {
        throw new Error(t("canvas.editor.merge.error"));
      }

      drawCanvasAnnotations(ctx, annotations, exportCanvas.width, exportCanvas.height);
      // Burn the scan-parameter chip into the merged PNG so the file carries
      // the settings the scan ran with. A source that is already a merged
      // figure has the chip in its pixels (and no params registered for an
      // archived merged URL), so it is never stamped twice.
      const paramItems = archivedImageUrl
        ? archivedScanParams.get(archivedImageUrl) ?? null
        : mergedFigureUrl
          ? null
          : liveScanParamItems;
      if (paramItems?.length) {
        drawScanParamChip(
          ctx,
          paramItems,
          (key) => t(key as TranslationKey),
          exportCanvas.width,
          exportCanvas.height,
        );
      }
      const mergedUrl = exportCanvas.toDataURL("image/png");
      if (archivedImageUrl && (kind === "raster" || kind === "vector")) {
        // The chip is now part of the merged pixels; do not register it for
        // the merged URL or the overlay would be drawn on top of it again.
        onPaneImageChange?.(kind, mergePane, mergedUrl);
      } else {
        setMergedFigureUrl(mergedUrl);
      }
      setAnnotations([]);
      setCommentDraft(null);
      setContextMenu(null);
      setEditorError(null);
      // Close the in-app confirmation before asynchronous upload/download work
      // can open a browser-owned Save dialog. The browser dialog is not part
      // of this modal's lifecycle and may be cancelled independently.
      setMergeConfirmOpen(false);
      if (!archivedImageUrl && (kind === "raster" || kind === "vector")) {
        onMergedFigureChangeRef.current?.(kind, mergedUrl);
        await uploadMergedFigure(kind, mergedUrl, mergedFigureFilename);
      }
    } catch (error: any) {
      setEditorError(error?.message ?? t("canvas.editor.merge.error"));
    } finally {
      setMergeBusy(false);
    }
  }

  const viewToggle = (
    <div className="canvas-view-toggle">
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
    </div>
  );

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
                className={`canvas-toolbox__action${annotations.length > 0 && annotations !== acknowledgedAnnotationsByPane[selectedPane] && !mergeConfirmOpen ? " canvas-toolbox__action--pending" : ""}`}
              disabled={!annotations.length}
                title={t("canvas.editor.merge")}
                onClick={() => {
                  setAcknowledgedAnnotationsByPane((current) => ({ ...current, [selectedPane]: annotations }));
                  setMergeConfirmOpen(true);
                }}
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

  const recyclePaneButton = (pane: number) => (
    <button
      type="button"
      className="btn btn--ghost image-panel-grid__recycle"
      aria-label={t("canvas.layout.recycle", { number: pane + 1 })}
      title={t("canvas.layout.recycle", { number: pane + 1 })}
      disabled={phase === "running" || phase === "stopping"}
      onClick={(event) => {
        event.stopPropagation();
        if (kind !== "raster" && kind !== "vector") return;
        setAnnotationsByPane((current) => ({ ...current, [pane]: [] }));
        setAcknowledgedAnnotationsByPane((current) => ({ ...current, [pane]: [] }));
        setSelectedAnnotationId(null);
        setDraftShape(null);
        setCommentDraft(null);
        setContextMenu(null);
        editorPressSurfaceRef.current = null;
        paneTransforms[pane] = configuredStreamTransforms;
        if (pane === scanTargetPane) {
          setMergedFigureUrl(null);
          setMergedFigureFilename(null);
        }
        onPaneRecycle?.(kind, pane);
      }}
    >
      <Icon name="x" />
    </button>
  );

  const archivedEditorLayer = selectedPaneHasImage && editorEnabled ? (
    <div
      className="canvas-editor-layer"
      data-tool={activeTool}
      onPointerDown={handleEditorPointerDown}
      onPointerMove={handleEditorPointerMove}
      onPointerUp={handleEditorPointerUp}
      onPointerCancel={() => { editorPressSurfaceRef.current = null; setDraftShape(null); }}
      onClick={handleEditorSurfaceClick}
    >
      {annotations.map((annotation, index) => annotation.kind === "rectangle" || annotation.kind === "circle" ? (
        <div
          key={annotation.id}
          role="button"
          tabIndex={0}
          className={`canvas-editor__shape canvas-editor__shape--${annotation.kind}`}
          data-selected={selectedAnnotationId === annotation.id ? "true" : "false"}
          style={shapeStyle(annotation)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); setSelectedAnnotationId(annotation.id); }}
          onContextMenu={(event) => openContextMenu(event, annotation.id)}
        />
      ) : (
        <button
          key={annotation.id}
          type="button"
          className={`canvas-editor__annotation canvas-editor__annotation--${annotation.kind}`}
          data-selected={selectedAnnotationId === annotation.id ? "true" : "false"}
          style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); setSelectedAnnotationId(annotation.id); }}
          onContextMenu={(event) => openContextMenu(event, annotation.id)}
          title={annotation.kind === "comment" ? annotation.text : t("canvas.editor.tool.highlight")}
        >
          <span className="canvas-editor__annotation-index" style={{ borderColor: annotation.strokeColor, background: alphaColor(annotation.strokeColor, annotation.kind === "comment" ? 0.92 : 0.24) }}>
            {index + 1}
          </span>
          {annotation.kind === "comment" && annotation.text && <span className="canvas-editor__label">{annotation.text}</span>}
        </button>
      ))}
      {draftShape && <div className={`canvas-editor__shape canvas-editor__shape--${draftShape.kind} canvas-editor__shape--draft`} style={shapeStyle(draftShape)} />}
      {commentDraft && (
        <form className="canvas-editor__draft" style={{ left: `${commentDraft.x * 100}%`, top: `${commentDraft.y * 100}%` }} onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); saveCommentDraft(); }}>
          <input autoFocus className="input" value={commentDraft.text} placeholder={t("canvas.editor.comment.placeholder")} onChange={(event) => setCommentDraft((current) => current ? { ...current, text: event.target.value } : current)} />
          <div className="button-row">
            <button type="submit" className="btn btn--ghost">{t("canvas.editor.comment.save")}</button>
            <button type="button" className="btn btn--cancel" onClick={() => setCommentDraft(null)}>{t("canvas.editor.comment.cancel")}</button>
          </div>
        </form>
      )}
      {contextMenu && (
        <div className="canvas-editor__menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <button type="button" className="canvas-editor__menu-item" disabled={!annotations.length} onClick={undoLastAnnotation}>{t("canvas.editor.context.undo")}</button>
          <button type="button" className="canvas-editor__menu-item" disabled={!contextTargetId} onClick={() => removeAnnotation(contextTargetId)}>{t("canvas.editor.context.remove")}</button>
          <button type="button" className="canvas-editor__menu-item" disabled={!annotations.length} onClick={() => { setAnnotations([]); setSelectedAnnotationId(null); setDraftShape(null); setCommentDraft(null); setContextMenu(null); }}>{t("canvas.editor.context.clear")}</button>
        </div>
      )}
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
                  <LoadingSpinner inline size={20} ariaLabel={t("canvas.editor.merge.uploading")} />
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn--cancel"
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

      {showModeToggle && viewToggleHost && createPortal(viewToggle, viewToggleHost)}
      {showModeToggle && (
        <div className="row canvas-view-row" style={{ marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
          {!viewToggleHost && viewToggle}
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

      <div id="image-panel-grid" className={`image-panel-grid image-panel-grid--${imageLayout}`}>
      {Array.from({ length: imageLayout }, (_, index) => index)
        .filter((index) => index !== scanTargetPane)
        .map((index) => {
        const imageUrl = imageSlots[index] ?? null;
        return (
          <div
            className="image-panel-grid__tile"
            data-selected={selectedPane === index ? "true" : "false"}
            key={`history-${index}`}
            style={{ order: index }}
            onClick={() => selectPane(index)}
          >
            <div className="image-panel-grid__label">
              <span>{t("canvas.layout.previous", { number: index + 1 })}</span>
              {showCalibratedAxes && <label className="checkbox vacuum-switch app-switch image-panel-grid__grid-toggle" onClick={(event) => event.stopPropagation()}>
                <input type="checkbox" checked={paneGridVisibility[index]} onChange={(event) => setPaneGrid(index, event.target.checked)} />
                <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
                {t("roi.showGrid")}
              </label>}
              {recyclePaneButton(index)}
            </div>
            {imageUrl ? (
              <ArchivedScanDisplay
                key={imageUrl}
                kind={kind}
                imageUrl={imageUrl}
                alt={t("canvas.layout.previous", { number: index + 1 })}
                roi={roi}
                showGrid={paneGridVisibility[index]}
                showAxes={showCalibratedAxes}
                transforms={paneTransforms[index]}
                t={t}
                onFrameRef={(node) => {
                  if (node) archivedPaneFramesRef.current.set(index, node);
                  else archivedPaneFramesRef.current.delete(index);
                }}
                editorLayer={
                  selectedPane === index
                    ? archivedEditorLayer
                    : <ArchivedAnnotationPreview annotations={annotationsByPane[index] ?? []} t={t} />
                }
              />
            ) : (
              <div className="canvas-stage image-panel-grid__archived-stage">
                <div className="canvas-frame image-panel-grid__empty">
                  {t("canvas.layout.empty", { number: index + 1 })}
                  {showCalibratedAxes && <LiveAxisOverlay roi={roi} showGrid={paneGridVisibility[index]} t={t} transforms={paneTransforms[index]} />}
                </div>
                <LevelWedge histogram={null} levels={{ low: 0, high: 0xfffc }} auto onChange={() => undefined} onAuto={() => undefined} disabled />
              </div>
            )}
          </div>
        );
      })}
      <div
        className={`image-panel-grid__target${imageLayout === 1 ? " image-panel-grid__target--single" : " image-panel-grid__target--active"}`}
        data-selected={selectedPane === scanTargetPane ? "true" : "false"}
        style={{ order: scanTargetPane }}
        onClick={() => selectPane(scanTargetPane)}
      >
        {imageLayout > 1 && <div className="image-panel-grid__label">
          <span />
          {showCalibratedAxes && <label className="checkbox vacuum-switch app-switch image-panel-grid__grid-toggle" onClick={(event) => event.stopPropagation()}>
            <input type="checkbox" checked={paneGridVisibility[scanTargetPane]} onChange={(event) => setPaneGrid(scanTargetPane, event.target.checked)} />
            <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
            {t("roi.showGrid")}
          </label>}
          {recyclePaneButton(scanTargetPane)}
        </div>}
          {singlePaneImage && imageLayout === 1 ? (
            <ArchivedScanDisplay
              kind={kind}
              imageUrl={singlePaneImage}
              transforms={paneTransforms[singlePaneSourceIndex]}
              alt={kindLabel}
              roi={roi}
              showGrid={paneGridVisibility[singlePaneSourceIndex]}
              showAxes={showCalibratedAxes}
              t={t}
              onFrameRef={(node) => { frameRef.current = node; }}
              editorLayer={null}
            />
          ) : (
          <div className={`canvas-stage${targetParked ? " canvas-stage--parked" : ""}`}>
      <div
        ref={frameRef}
        className="canvas-frame"
        onContextMenu={(event) => {
          if (editorEnabled && selectedPane === scanTargetPane) openContextMenu(event, null);
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
          {showCalibratedAxes && <LiveAxisOverlay roi={roi} showGrid={paneGridVisibility[scanTargetPane]} t={t} ignoreTransforms={ignoreTransforms} transforms={streamTransforms} />}
          {liveScanParamItems && !mergedFigureUrl && <ScanParamChip items={liveScanParamItems} t={t} />}
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
          {editorEnabled && selectedPane === scanTargetPane && (
            <div
              className="canvas-editor-layer"
              data-tool={activeTool}
              onPointerDown={handleEditorPointerDown}
              onPointerMove={handleEditorPointerMove}
              onPointerUp={handleEditorPointerUp}
              onPointerCancel={() => { editorPressSurfaceRef.current = null; setDraftShape(null); }}
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
                      className="btn btn--cancel"
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
      <LevelWedge
        histogram={targetParked ? null : stats.histogram ?? null}
        levels={targetParked ? { low: 0, high: 0xfffc } : { low: stats.low ?? 0, high: stats.high ?? 0xfffc }}
        auto={targetParked || levelSetting.mode === "auto"}
        onChange={handleWedgeChange}
        onAuto={handleWedgeAuto}
        disabled={targetParked || !stats.histogram || stats.histogram.total <= 0 || Boolean(displayedFigureUrl)}
      />
          </div>
          )}
      </div>
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
  // Show the complete active sweep, including the part ahead of the marker.
  const first = Math.floor((limit - 1) / edge) * edge;
  const sweepEnd = Math.min(first + edge, total);
  ctx.save();
  ctx.strokeStyle = "rgba(111, 190, 211, 0.75)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let index = first; index < sweepEnd; index++) {
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
  ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
  ctx.shadowBlur = 2;
  ctx.fillStyle = "rgba(151, 210, 224, 1)";
  ctx.beginPath();
  ctx.arc(cx, cy, 1.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(151, 210, 224, 1)";
  ctx.lineWidth = 0.9;
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
  ignoreTransforms = false,
  transforms: paneTransforms,
}: {
  roi: ROIState;
  showGrid: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  ignoreTransforms?: boolean;
  transforms?: StreamTransforms;
}) {
  const configuredTransforms = useAppSelector((s) => s.scan.streamTransforms);
  const transforms = ignoreTransforms ? NO_STREAM_TRANSFORMS : paneTransforms ?? configuredTransforms;
  const transformPoint = (x: number, y: number) => {
    if (transforms.rotate90) [x, y] = [1 - y, x];
    if (transforms.xflip) x = 1 - x;
    if (transforms.yflip) y = 1 - y;
    return { x, y };
  };
  const pct = (value: number) => `${value * 100}%`;
  const xAxisStart = transformPoint(0, 0);
  const xAxisEnd = transformPoint(1, 0);
  const yAxisStart = transformPoint(0, 0);
  const yAxisEnd = transformPoint(0, 1);
  const xAxisVertical = Math.abs(xAxisStart.x - xAxisEnd.x) < 0.5;
  const yAxisVertical = Math.abs(yAxisStart.x - yAxisEnd.x) < 0.5;
  const axisStyle = (vertical: boolean, point: { x: number; y: number }) => vertical
    ? { left: pct(point.x), top: 0, bottom: 0 }
    : { left: 0, right: 0, top: pct(point.y) };
  const tickPosition = (vertical: boolean, point: { x: number; y: number }) => vertical
    ? { top: pct(point.y), left: pct(point.x) }
    : { left: pct(point.x), top: pct(point.y) };
  const tickClass = (vertical: boolean) => vertical ? "--y" : "--x";
  const inwardTickTransform = (vertical: boolean, point: { x: number; y: number }) => {
    if (vertical) return `translate(${point.x > 0.5 ? "-100%" : "0"}, -0.5px)`;
    return `translate(-0.5px, ${point.y > 0.5 ? "-100%" : "0"})`;
  };
  const xAxisPoint = (ratio: number) => transformPoint(ratio, 0);
  const yAxisPoint = (ratio: number) => transformPoint(0, ratio);
  const valueStyle = (vertical: boolean, point: { x: number; y: number }) => {
    if (vertical) {
      const atTop = point.y < 0.05;
      const atBottom = point.y > 0.95;
      const onRight = point.x > 0.5;
      const xOffset = onRight ? `calc(${pct(point.x)} - 14px)` : `calc(${pct(point.x)} + 14px)`;
      const xAlign = onRight ? "-100%" : "0";
      const yAlign = atTop ? "0" : atBottom ? "-100%" : "-50%";
      return { left: xOffset, top: pct(point.y), transform: `translate(${xAlign}, ${yAlign})` };
    }

    const atLeft = point.x < 0.05;
    const atRight = point.x > 0.95;
    const onBottom = point.y > 0.5;
    const xAlign = atLeft ? "0" : atRight ? "-100%" : "-50%";
    const top = onBottom ? `calc(${pct(point.y)} - 16px)` : `calc(${pct(point.y)} + 16px)`;
    return { left: pct(point.x), top, transform: `translateX(${xAlign})` };
  };
  const minorTicks = 20;
  const majorEvery = 5;
  const ticks = Array.from({ length: minorTicks + 1 }, (_, i) => {
    const ratio = i / minorTicks;
    return {
      key: i,
      ratio,
      major: i % majorEvery === 0,
      xLabel: formatOneDecimal(roi.x_origin + (roi.x_end - roi.x_origin) * ratio),
      yLabel: formatOneDecimal(roi.y_origin + (roi.y_end - roi.y_origin) * ratio),
    };
  });
  const unit = unitLabel(roi.scale_unit);

  return (
    <div className="canvas-axis-overlay" aria-hidden="true">
      {showGrid && (
        <svg
          className="canvas-axis-overlay__grid"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          shapeRendering="crispEdges"
          aria-hidden="true"
        >
          {ticks.filter((tick) => tick.major).flatMap((tick) => {
            const xPoint = xAxisPoint(tick.ratio);
            const yPoint = yAxisPoint(tick.ratio);
            return [
              <line
                key={`grid-x-${tick.key}`}
                x1={xAxisVertical ? 0 : xPoint.x * 100}
                x2={xAxisVertical ? 100 : xPoint.x * 100}
                y1={xAxisVertical ? xPoint.y * 100 : 0}
                y2={xAxisVertical ? xPoint.y * 100 : 100}
                vectorEffect="non-scaling-stroke"
              />,
              <line
                key={`grid-y-${tick.key}`}
                x1={yAxisVertical ? 0 : yPoint.x * 100}
                x2={yAxisVertical ? 100 : yPoint.x * 100}
                y1={yAxisVertical ? yPoint.y * 100 : 0}
                y2={yAxisVertical ? yPoint.y * 100 : 100}
                vectorEffect="non-scaling-stroke"
              />,
            ];
          })}
        </svg>
      )}
      <div className={`canvas-axis-overlay__axis canvas-axis-overlay__axis--${xAxisVertical ? "y" : "x"}`} style={axisStyle(xAxisVertical, xAxisStart)} />
      <div className={`canvas-axis-overlay__axis canvas-axis-overlay__axis--${yAxisVertical ? "y" : "x"}`} style={axisStyle(yAxisVertical, yAxisStart)} />
      {ticks.map((tick) => {
        const point = xAxisPoint(tick.ratio);
        return (
        <div
          key={`x-${tick.key}`}
          className={`canvas-axis-overlay__tick canvas-axis-overlay__tick${tickClass(xAxisVertical)}${
            tick.major ? " canvas-axis-overlay__tick--major" : ""
          }`}
          style={{ ...tickPosition(xAxisVertical, point), transform: inwardTickTransform(xAxisVertical, xAxisStart) }}
        />
      );})}
      {ticks.map((tick) => {
        const point = yAxisPoint(tick.ratio);
        return (
        <div
          key={`y-${tick.key}`}
          className={`canvas-axis-overlay__tick canvas-axis-overlay__tick${tickClass(yAxisVertical)}${
            tick.major ? " canvas-axis-overlay__tick--major" : ""
          }`}
          style={{ ...tickPosition(yAxisVertical, point), transform: inwardTickTransform(yAxisVertical, yAxisStart) }}
        />
      );})}
      {ticks.filter((tick) => tick.major).map((tick) => {
        const point = xAxisPoint(tick.ratio);
        return (
        <span
          key={`xl-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--x"
          style={valueStyle(xAxisVertical, point)}
        >
          {tick.xLabel}
        </span>
      );})}
      {ticks.filter((tick) => tick.major).map((tick) => {
        const point = yAxisPoint(tick.ratio);
        return (
        <span
          key={`yl-${tick.key}`}
          className="canvas-axis-overlay__value canvas-axis-overlay__value--y"
          style={valueStyle(yAxisVertical, point)}
        >
          {tick.yLabel}
        </span>
      );})}
      {([[[0, 0], "start"], [[1, 1], "end"]] as const).map(([[x, y], name]) => {
        const point = transformPoint(x, y);
        return <span
        key={name}
        className={`canvas-axis-overlay__label canvas-axis-overlay__label--${name}`}
        style={{ left: pct(point.x), top: pct(point.y), transform: `translate(${point.x > 0.5 ? "-100%" : "0"}, ${point.y > 0.5 ? "-100%" : "0"})` }}
      >
        {name === "start" ? t("roi.canvas.start", {
          point: `(${formatOneDecimal(roi.x_origin)}, ${formatOneDecimal(roi.y_origin)})`,
          unit,
        }) : t("roi.canvas.end", {
          point: `(${formatOneDecimal(roi.x_end)}, ${formatOneDecimal(roi.y_end)})`,
          unit,
        })}
      </span>;
      })}
    </div>
  );
}

/**
 * Low-opacity summary of the settings a scan ran with, drawn over the image
 * in the annotation layer. It never takes pointer events, so the editor
 * tools underneath keep working. Merging edits burns the same summary into
 * the merged PNG (see drawScanParamChip), after which this overlay is hidden.
 */
function ScanParamChip({
  items,
  t,
}: {
  items: ScanParamItem[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  if (!items.length) return null;
  return (
    <div className="canvas-scan-params" role="note" aria-label={t("canvas.scanParams.aria")}>
      {items.map((item) => (
        <span key={item.id} className="canvas-scan-params__item">
          <span className="canvas-scan-params__label">{t(item.labelKey as TranslationKey)}</span>
          <span className="canvas-scan-params__value">
            {item.valueKey ? t(item.valueKey as TranslationKey) : item.value}
            {item.suffix}
          </span>
        </span>
      ))}
    </div>
  );
}

function ArchivedScanDisplay({
  kind,
  imageUrl,
  alt,
  roi,
  showGrid,
  showAxes,
  t,
  transforms,
  onFrameRef,
  editorLayer,
}: {
  kind: ScanKind;
  imageUrl: string;
  alt: string;
  roi: ROIState;
  showGrid: boolean;
  showAxes: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  transforms?: StreamTransforms;
  onFrameRef: (node: HTMLDivElement | null) => void;
  editorLayer: ReactNode;
}) {
  const [decodedSnapshot, setDecodedSnapshot] = useState<PaintSnapshot | null>(null);
  const snapshot = archivedPaints.get(imageUrl) ?? decodedSnapshot;
  const scanParams = archivedScanParams.get(imageUrl) ?? null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Start from the levels the live image was shown with, then keep this
  // pane's own levels: adjusting it never touches the live wedge.
  const [levelSetting, setLevelSetting] = useState<LevelSetting>(() => levelMemory[kind] ?? AUTO_LEVELS);
  const [stats, setStats] = useState<PaintStats>({ min: 0, max: 0, populated: 0 });
  const pendingLevelRef = useRef<LevelSetting | null>(null);
  const levelFrameRef = useRef<number | null>(null);
  const applyLevelSetting = useCallback((next: LevelSetting) => {
    pendingLevelRef.current = next;
    if (levelFrameRef.current !== null) return;
    levelFrameRef.current = window.requestAnimationFrame(() => {
      levelFrameRef.current = null;
      if (pendingLevelRef.current) setLevelSetting(pendingLevelRef.current);
      pendingLevelRef.current = null;
    });
  }, []);
  useEffect(
    () => () => {
      if (levelFrameRef.current !== null) window.cancelAnimationFrame(levelFrameRef.current);
    },
    [],
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snapshot) return;
    setStats(paintSnapshot(canvas, { ...snapshot, transforms: transforms ?? snapshot.transforms }, levelSetting));
  }, [snapshot, levelSetting, transforms]);

  if (snapshot) {
    return (
      <div className="canvas-stage image-panel-grid__archived-stage">
        <div className="canvas-frame" ref={onFrameRef}>
          <canvas ref={canvasRef} aria-label={alt} onDragStart={(event) => event.preventDefault()} />
          {showAxes && <LiveAxisOverlay roi={roi} showGrid={showGrid} t={t} transforms={transforms ?? snapshot?.transforms ?? NO_STREAM_TRANSFORMS} />}
          {scanParams && <ScanParamChip items={scanParams} t={t} />}
          {editorLayer}
        </div>
        <LevelWedge
          histogram={stats.histogram ?? null}
          levels={{ low: stats.low ?? 0, high: stats.high ?? 0xfffc }}
          auto={levelSetting.mode === "auto"}
          onChange={(levels) => applyLevelSetting({ mode: "manual", low: levels.low, high: levels.high })}
          onAuto={() => applyLevelSetting(AUTO_LEVELS)}
          disabled={!stats.histogram || stats.histogram.total <= 0}
        />
      </div>
    );
  }

  // Reconstruct display samples from an uncached PNG. These are image gray
  // values rather than the original ADC readings, but use the same wedge.
  return (
    <div className="canvas-stage image-panel-grid__archived-stage">
      <div className="canvas-frame" ref={onFrameRef}>
        <img
          className="image-panel-grid__image image-panel-grid__archived-image"
          src={imageUrl}
          alt={alt}
          onLoad={(event) => {
            const image = event.currentTarget;
            const edge = Math.max(image.naturalWidth, image.naturalHeight);
            if (!edge) return;
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = edge;
            const context = canvas.getContext("2d");
            if (!context) return;
            try {
              context.drawImage(image, 0, 0, edge, edge);
              const pixels = context.getImageData(0, 0, edge, edge).data;
              const buf = new Uint16Array(edge * edge);
              for (let i = 0; i < buf.length; i += 1) {
                buf[i] = Math.round((0.299 * pixels[4 * i] + 0.587 * pixels[4 * i + 1] + 0.114 * pixels[4 * i + 2]) * 0xfffc / 255);
              }
              setDecodedSnapshot({ mode: "grayscale", buf, edge, populated: buf.length, transforms: NO_STREAM_TRANSFORMS });
            } catch {
              // Keep the stored image visible if its pixels cannot be read.
            }
          }}
        />
        {showAxes && <LiveAxisOverlay roi={roi} showGrid={showGrid} t={t} transforms={transforms ?? NO_STREAM_TRANSFORMS} />}
        {scanParams && <ScanParamChip items={scanParams} t={t} />}
        {editorLayer}
      </div>
      <LevelWedge
        histogram={null}
        levels={{ low: 0, high: 0xfffc }}
        auto
        onChange={() => undefined}
        onAuto={() => undefined}
        disabled
      />
    </div>
  );
}

function ArchivedAnnotationPreview({
  annotations,
  t,
}: {
  annotations: CanvasAnnotation[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  if (annotations.length === 0) return null;
  return (
    <div className="canvas-editor-layer canvas-editor-layer--preview" aria-hidden="true">
      {annotations.map((annotation, index) => annotation.kind === "rectangle" || annotation.kind === "circle" ? (
        <div
          key={annotation.id}
          className={`canvas-editor__shape canvas-editor__shape--${annotation.kind}`}
          style={shapeStyle(annotation)}
        />
      ) : (
        <div
          key={annotation.id}
          className={`canvas-editor__annotation canvas-editor__annotation--${annotation.kind}`}
          style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}
          title={annotation.kind === "comment" ? annotation.text : t("canvas.editor.tool.highlight")}
        >
          <span
            className="canvas-editor__annotation-index"
            style={{ borderColor: annotation.strokeColor, background: alphaColor(annotation.strokeColor, annotation.kind === "comment" ? 0.92 : 0.24) }}
          >
            {index + 1}
          </span>
          {annotation.kind === "comment" && annotation.text && (
            <span className="canvas-editor__label">{annotation.text}</span>
          )}
        </div>
      ))}
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

function paintSnapshot(canvas: HTMLCanvasElement, snapshot: PaintSnapshot, setting: LevelSetting): PaintStats {
  let stats: PaintStats;
  switch (snapshot.mode) {
    case "clear":
      clearCanvas(canvas);
      stats = { min: 0, max: 0, populated: 0 };
      break;
    case "grayscale":
      stats = paintGrayscale(canvas, snapshot.buf, snapshot.edge, snapshot.populated, setting);
      break;
    case "vectorBlock":
      stats = paintVectorDefaultBlockFill(
        canvas,
        snapshot.buf,
        snapshot.edge,
        snapshot.populated,
        snapshot.scanPath,
        snapshot.graySelection,
        snapshot.graySkipped,
        snapshot.grayColor,
        setting,
      );
      break;
    case "vectorDefault":
      stats = paintVectorDefault(
        canvas,
        snapshot.buf,
        snapshot.edge,
        snapshot.populated,
        snapshot.scanPath,
        snapshot.graySelection,
        snapshot.graySkipped,
        snapshot.grayColor,
        setting,
      );
      break;
    case "vectorCustom":
      stats = paintVectorCustom(
        canvas,
        snapshot.buf,
        snapshot.edge,
        snapshot.points,
        snapshot.populated,
        snapshot.blankMask,
        snapshot.spotMask,
        snapshot.grayColor,
        setting,
      );
      break;
  }
  orientCanvas(canvas, snapshot.transforms);
  return stats;
}

// The store reuses its buffers for the next scan, so an archive needs its own copy.
function copyPaintSnapshot(snapshot: PaintSnapshot): PaintSnapshot {
  switch (snapshot.mode) {
    case "clear":
      return { ...snapshot };
    case "grayscale":
    case "vectorDefault":
    case "vectorBlock":
      return { ...snapshot, buf: snapshot.buf.slice() };
    case "vectorCustom":
      return {
        ...snapshot,
        buf: snapshot.buf.slice(),
        points: snapshot.points.slice(),
        blankMask: snapshot.blankMask ? snapshot.blankMask.slice() : null,
        spotMask: snapshot.spotMask ? snapshot.spotMask.slice() : null,
      };
  }
}

function paintGrayscale(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  populated: number,
  setting: LevelSetting = AUTO_LEVELS,
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

  const histogram = buildHistogram(lo, hi, limit, (visit) => {
    for (let i = 0; i < limit; i++) visit(buf[i]);
  });
  const { low, high } = resolveLevels(histogram, setting);

  const img = ctx.createImageData(edge, edge);
  const data = img.data;

  const totalPx = edge * edge;
  const reg = limit < totalPx ? limit : totalPx;
  for (let i = 0; i < reg; i++) {
    const g = levelGray(buf[i], low, high);
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

  return { min: lo, max: hi, populated: limit, histogram, low, high };
}

function paintVectorDefault(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  populated: number,
  scanPath: VectorScanPath,
  graySpotSelection: GrayScaleSelection = null,
  graySpotSkipped: boolean | null = null,
  graySpotColor: { r: number; g: number; b: number } = ROI_ACTION_BLANK_COLOR,
  setting: LevelSetting = AUTO_LEVELS,
): PaintStats {
  if (canvas.width !== edge || canvas.height !== edge) {
    canvas.width = edge;
    canvas.height = edge;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, buf.length);
  const range = vectorDefaultRange(buf, edge, limit, scanPath, setting);
  const img = ctx.createImageData(edge, edge);
  const data = img.data;

  for (let i = 0; i < limit; i++) {
    const pixel = vectorScanSamplePixel(i, edge, scanPath);
    if (!pixel) break;
    const idx = pixel.y * edge + pixel.x;
    const sample = buf[idx];
    const g = levelGray(sample, range.low ?? 0, range.high ?? 0xfffc);
    const p = idx * 4;
    if (sampleInGraySelectionToFilter(sample, graySpotSelection, graySpotSkipped)) {
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
  setting: LevelSetting = AUTO_LEVELS,
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
  const histogram = buildHistogram(lo, hi, visible, (visit) => {
    for (let i = 0; i < limit; i++) {
      if (blankMask?.[i] === 1) continue;
      const x = points[2 * i] | 0;
      const y = points[2 * i + 1] | 0;
      if (x < 0 || x >= edge || y < 0 || y >= edge) continue;
      visit(buf[y * edge + x]);
    }
  });
  const { low, high } = resolveLevels(histogram, setting);

  const img = ctx.createImageData(edge, edge);
  const data = img.data;
  for (let i = 0; i < limit; i++) {
    const x = points[2 * i] | 0;
    const y = points[2 * i + 1] | 0;
    if (x < 0 || x >= edge || y < 0 || y >= edge) continue;
    const idx = y * edge + x;
    const g = levelGray(buf[idx], low, high);
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
  return { min: lo, max: hi, populated: limit, histogram, low, high };
}

function paintVectorDefaultBlockFill(
  canvas: HTMLCanvasElement,
  buf: Uint16Array,
  edge: number,
  populated: number,
  scanPath: VectorScanPath,
  graySpotSelection: GrayScaleSelection = null,
  graySpotSkipped: boolean | null = null,
  graySpotColor: { r: number; g: number; b: number } = ROI_ACTION_BLANK_COLOR,
  setting: LevelSetting = AUTO_LEVELS,
): PaintStats {
  const nativeSize = DAC_RANGE;
  if (canvas.width !== nativeSize || canvas.height !== nativeSize) {
    canvas.width = nativeSize;
    canvas.height = nativeSize;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { min: 0, max: 0, populated: 0 };

  const limit = Math.min(populated, buf.length);

  const range = vectorDefaultRange(buf, edge, limit, scanPath, setting);

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
    const g = levelGray(sample, range.low ?? 0, range.high ?? 0xfffc);
    const isSpot = sampleInGraySelectionToFilter(sample, graySpotSelection, graySpotSkipped);
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
  setting: LevelSetting = AUTO_LEVELS,
): PaintStats {
  let lo = 65535;
  let hi = 0;
  let counted = 0;
  for (let i = 0; i < limit; i++) {
    const pixel = vectorScanSamplePixel(i, edge, scanPath);
    if (!pixel) break;
    const v = buf[pixel.y * edge + pixel.x];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    counted++;
  }
  if (counted === 0) {
    lo = 0;
    hi = 0;
  }
  const histogram = buildHistogram(lo, hi, counted, (visit) => {
    for (let i = 0; i < counted; i++) {
      const pixel = vectorScanSamplePixel(i, edge, scanPath);
      if (!pixel) break;
      visit(buf[pixel.y * edge + pixel.x]);
    }
  });
  const { low, high } = resolveLevels(histogram, setting);
  return { min: lo, max: hi, populated: limit, histogram, low, high };
}

function sampleInGraySelectionToFilter(
  sample: number,
  selection: GrayScaleSelection,
  skipped: boolean | null,
): boolean {
  if (!selection) return false;
  const selected = grayScaleSelectionContains(selection, scaleScanSample(sample));
  return skipped === false ? !selected : selected;
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
