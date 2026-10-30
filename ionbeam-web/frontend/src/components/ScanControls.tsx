/**
 * Run / Stop button group, plus a "Run validated" button that
 * uses the blocking REST endpoint (returns a ScanResult with timing,
 * validation report, and CSV path).
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAppDispatch, useAppSelector } from "../store";
import { apiUrl } from "../lib/backendUrl";
import {
  runRasterValidated,
  runVectorValidated,
  setPreview,
  setInfiniteActive,
  setROIScanEnabled,
  setScanZoom,
  updateScanRegion,
  requestROITargetGrayRun,
  finishROITargetGrayRun,
  streamErrored,
  streamReset,
  type ScanKind,
} from "../store/scanSlice";
import {
  resetRaster,
  resetVector,
  setLiveVectorCustomPoints,
  queueLiveScanDisplay,
} from "../store/imageSlice";
import { registerScanActionStop, stopAllScanActions } from "../hooks/scanActionRegistry";
import { useScanStream, type LiveGrayRule } from "../hooks/useScanStream";
import {
  clearBitmapSelectionCache,
  bitmapImageFrame,
  decorateSimulationBitmap,
  interleaveParallelPoints,
  rasterRequestWithBitmapSelection,
  vectorRequestWithAdaptiveGrayFeedback,
  vectorRequestWithBitmapSelection,
} from "../lib/bitmapVector";
import { useTranslation } from "../i18n";
import { displayScanError } from "../lib/scanError";
import { Icon } from "./Icon";
import { TransformCard } from "./TransformCard";
import { LoadingSpinner } from "./LoadingSpinner";
import { RunValidatedHelp } from "./RunValidatedHelp";
import { HelpPopover } from "./HelpPopover";
import { NumberStepperInput } from "./NumberStepperField";
import { ScanTakeoverEstimate } from "./TakeoverEstimate";
import { selectedEquipmentId, setSelectedEquipmentId } from "../lib/adminActivity";
import { scanAuthHeaders } from "../lib/authIdentity";
import { SITE_OPTIONS } from "../lib/sites";
import { createScanQueue, latestScanQueue, loadScanQueue, type ScanQueueSummary, type StoredScanEntry } from "../lib/scanQueues";
import type { RasterRequest, ROIRequest, VectorRequest } from "../types/api";
import { ScanType } from "../types/scanType";

type InfiniteScanEntry =
  | {
      kind: "raster";
      req: RasterRequest;
      displayROI: ROIRequest | null;
      displayROIs?: ROIRequest[] | null;
      compositeROIs?: ROIRequest[] | null;
      simulationBitmapInfo?: { width: number; height: number } | null;
      hasSimulationBitmap?: boolean;
      initialFrame: Uint16Array | null;
    }
  | {
      kind: "vector";
      req: VectorRequest;
      scanType: ScanType;
      displayROI: ROIRequest | null;
      displayROIs?: ROIRequest[] | null;
      compositeROIs?: ROIRequest[] | null;
      simulationBitmapInfo?: { width: number; height: number } | null;
      hasSimulationBitmap?: boolean;
      initialFrame: Uint16Array | null;
    };
import type { ROIState } from "../store/scanSlice";
import { effectiveScanRegions, zoomInterleavedVectorPoints, zoomVectorPoints } from "../lib/scanRegions";
import { worldSelectionToDacROI } from "../lib/roiDac";
import { targetGrayFilter } from "../lib/roiTargetGray";

type RegionScanEntry =
  | {
      kind: "raster";
      req: RasterRequest;
      displayROI: ROIRequest | null;
      displayROIs?: ROIRequest[] | null;
      compositeROIs?: ROIRequest[] | null;
      simulationBitmapInfo?: { width: number; height: number } | null;
      hasSimulationBitmap?: boolean;
      initialFrame: Uint16Array | null;
    }
  | {
      kind: "vector";
      req: VectorRequest;
      scanType: ScanType;
      displayROI: ROIRequest | null;
      displayROIs?: ROIRequest[] | null;
      compositeROIs?: ROIRequest[] | null;
      customPointGroupLengths?: number[];
      customPointROIs?: Array<ROIRequest | null>;
      simulationBitmapInfo?: { width: number; height: number } | null;
      hasSimulationBitmap?: boolean;
      initialFrame: Uint16Array | null;
    };

const FULL_DAC_ROI: ROIRequest = {
  x_start: 0, x_end: 16383, y_start: 0, y_end: 16383,
};

function combineRasterRegions(requests: RasterRequest[]): RasterRequest {
  const rois = requests.map((request) => request.roi ?? FULL_DAC_ROI);
  const bitmaps = requests.map((request) => request.simulation_bitmap);
  return {
    ...requests[0],
    roi: null,
    parallel_rois: rois,
    simulation_bitmap: null,
    parallel_simulation_bitmaps: bitmaps.every(Boolean) ? bitmaps as NonNullable<RasterRequest["simulation_bitmap"]>[] : null,
  };
}

function hasBitmapSimulation(request: RasterRequest | VectorRequest): boolean {
  return Boolean(
    request.simulation_bitmap || request.simulation_bitmap_id ||
    request.parallel_simulation_bitmaps?.length || request.parallel_simulation_bitmap_ids?.length,
  );
}

function combineVectorRegions(requests: VectorRequest[]): VectorRequest {
  const rois = requests.map((request) => request.roi ?? FULL_DAC_ROI);
  if (requests.every((request) => request.pattern === "custom" && request.points)) {
    const points = interleaveParallelPoints(requests.map((request) => request.points ?? []));
    if (points.length > 1_000_000) {
      throw new Error("Parallel vector path exceeds the 1,000,000 point service limit");
    }
    return {
      ...requests[0],
      target_gray_level: requests.find((request) => request.target_gray_level != null)?.target_gray_level ?? null,
      gray_level_range: requests.find((request) => request.gray_level_range != null)?.gray_level_range ?? null,
      gray_level_skipped: requests.find((request) => request.gray_level_range != null)?.gray_level_skipped ?? null,
      roi: null,
      points,
      simulation_bitmap: null,
      parallel_rois: null,
      parallel_simulation_bitmaps: null,
    };
  }
  if (requests.some((request) => request.pattern !== "default" || request.points)) {
    throw new Error("Parallel regions require one compatible vector path");
  }
  const bitmaps = requests.map((request) => request.simulation_bitmap);
  return {
    ...requests[0],
    target_gray_level: requests.find((request) => request.target_gray_level != null)?.target_gray_level ?? null,
    gray_level_range: requests.find((request) => request.gray_level_range != null)?.gray_level_range ?? null,
    gray_level_skipped: requests.find((request) => request.gray_level_range != null)?.gray_level_skipped ?? null,
    roi: null,
    parallel_rois: rois,
    simulation_bitmap: null,
    parallel_simulation_bitmaps: bitmaps.every(Boolean) ? bitmaps as NonNullable<VectorRequest["simulation_bitmap"]>[] : null,
  };
}

interface EquipmentOption {
  id: number | null;
  name: string;
  model: string;
  serial_number: string;
  site: string;
  description: string;
}

interface EquipmentResponse {
  ok: boolean;
  equipment: EquipmentOption[];
}

interface CurrentAccountResponse {
  ok?: boolean;
  registered?: boolean;
  session_expired?: boolean;
  user?: { role?: number; is_active?: boolean } | null;
  error?: string;
}

function withoutPartialROISelection(roiState: ROIState): ROIState {
  return {
    ...roiState,
    selection: null,
  };
}

function resizeImageFrame(
  frame: Uint16Array,
  sourceEdge: number,
  targetEdge: number,
): Uint16Array | null {
  if (sourceEdge <= 0 || targetEdge <= 0 || frame.length !== sourceEdge * sourceEdge) return null;
  if (sourceEdge === targetEdge) return frame.slice();
  const resized = new Uint16Array(targetEdge * targetEdge);
  for (let y = 0; y < targetEdge; y += 1) {
    const sourceY = Math.min(sourceEdge - 1, Math.floor((y * sourceEdge) / targetEdge));
    for (let x = 0; x < targetEdge; x += 1) {
      const sourceX = Math.min(sourceEdge - 1, Math.floor((x * sourceEdge) / targetEdge));
      resized[y * targetEdge + x] = frame[sourceY * sourceEdge + sourceX];
    }
  }
  return resized;
}

export function ScanControls({
  kind,
  disabled = false,
  scanActive = false,
  zoomDisabled = false,
  vectorGrayScaleSelection = null,
  vectorGrayScaleSkipped = null,
  onScanRunStart,
  validatedActionsHost = null,
  firstRowContent,
}: {
  kind: ScanKind;
  disabled?: boolean;
  scanActive?: boolean;
  zoomDisabled?: boolean;
  vectorGrayScaleSelection?: [number, number] | null;
  vectorGrayScaleSkipped?: boolean | null;
  onScanRunStart?: (scanType: ScanType) => void;
  /** When set, Run validated + Clear render here (bottom of the scan
   *  parameters card, under Validated run options) instead of inline. */
  validatedActionsHost?: HTMLElement | null;
  firstRowContent?: ReactNode;
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const phase = useAppSelector((s) => s.scan.phase);
  const errorMessage = useAppSelector((s) => s.scan.errorMessage);
  const raster = useAppSelector((s) => s.scan.raster);
  const rasterImageFrame = useAppSelector((s) => s.image.frame);
  const rasterImageResolution = useAppSelector((s) => s.image.resolution);
  const rasterImageFilled = useAppSelector((s) => s.image.filled);
  const vector = useAppSelector((s) => s.scan.vector);
  const vectorImageFrame = useAppSelector((s) => s.image.vectorImage);
  const vectorImageEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorImageFilled = useAppSelector((s) => s.image.vectorFilled);
  const preview = useAppSelector((s) => s.scan.preview);
  const roiState = useAppSelector((s) => s.scan.roi);
  const [parallelRegions, setParallelRegions] = useState(false);
  const [roiControlsCollapsed, setROIControlsCollapsed] = useState(true);
  const [pendingQueue, setPendingQueue] = useState<ScanQueueSummary | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const queue = await latestScanQueue();
        if (active) setPendingQueue(queue && queue.status === "interrupted" &&
          queue.next_index >= 0 && queue.next_index < queue.total ? queue : null);
      } catch {
        if (active) setPendingQueue(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [phase]);
  const canParallelRegions = roiState.scan_regions.length > 1;
  // Every ROI scan needs normal full-field data outside its selected area.
  // Parallel controls whether multiple ROIs share one path, not whether the
  // surrounding image is acquired.
  const compositeROIs = roiState.scan_regions.length > 0;
  useEffect(() => {
    setParallelRegions(canParallelRegions);
  }, [canParallelRegions]);
  const selectedTargetGray = useAppSelector((s) => s.scan.selectedTargetGray);
  const defaults = useAppSelector((s) => s.status.defaults);
  const sessionSimulation = useAppSelector((s) => s.status.sessionSimulation);
  const settingsSaving = useAppSelector((s) => s.settings.saving);
  const backendRestarting = useAppSelector((s) => s.settings.backendRestarting);
  const roi = roiState.selection;
  const roiSelectionKey = roi
    ? `${roi.x_start}:${roi.x_end}:${roi.y_start}:${roi.y_end}`
    : "";
  const stream = useScanStream();
  const prevPhaseRef = useRef(phase);
  // Infinite mode repeats one prepared request until Stop: a Raster frame or a
  // Vector scan (with the scan type its progress/feedback handling needs).
  const infiniteScanRef = useRef<InfiniteScanEntry | null>(null);
  const infiniteScanActiveRef = useRef(false);
  const regionScanQueueRef = useRef<RegionScanEntry[]>([]);
  const regionScanRepeatRef = useRef<RegionScanEntry[]>([]);
  const [runStarting, setRunStarting] = useState(false);
  const [infiniteScanActive, setInfiniteScanActive] = useState(false);
  const [pendingZoomRestart, setPendingZoomRestart] = useState<"single" | "infinite" | null>(null);
  const [zoomError, setZoomError] = useState<string | null>(null);
  const [grayRuleError, setGrayRuleError] = useState<string | null>(null);
  const zoomRestartTimerRef = useRef<number | null>(null);
  const zoomUpdateGenerationRef = useRef(0);
  const previousScanRegionsRef = useRef(roiState.scan_regions);
  // Production Live: regions are held back until one full frame has rendered.
  const deferredRegionsRef = useRef(false);
  const autoRestartTimesRef = useRef<number[]>([]);
  const fullFrameReadyRef = useRef(false);
  const liveFramesDone = useAppSelector((s) => kind === "raster" ? s.image.rasterFrames : s.image.vectorPasses);
  const suppressRegionRollbackRef = useRef(false);
  const regionUpdateGenerationRef = useRef(0);
  const pendingStopClearRef = useRef<"raster" | "vector" | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);
  const [region, setRegion] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const availableRegions = SITE_OPTIONS.filter((option) =>
    equipment.some((row) => row.site === option.value),
  );
  const regionEquipment = equipment.filter((row) => row.site === region);
  const isProduction = defaults?.is_production !== false;
  const targetGrayRunning = useAppSelector((s) => s.scan.roiTargetGrayRun.status === "running");
  const vectorPixelFallbackBlank = (() => {
    const vectorParams = defaults?.vector_params;
    if (vectorParams && typeof vectorParams === "object") {
      const normalized = (vectorParams as Record<string, unknown>).pixelFallbackBlank;
      if (typeof normalized === "boolean") return normalized;
    }
    const vectorDefaults = defaults?.vector;
    if (!vectorDefaults || typeof vectorDefaults !== "object") return false;
    return (vectorDefaults as Record<string, unknown>).PixelFallbackBlank === true;
  })();
  const allowBitmapSimulation = !isProduction && Boolean(roiState.imageDataUrl);
  const visibleError = displayScanError(
    errorMessage,
    t("scan.error.deviceNotFound"),
  );
  const activeVectorGrayScaleSelection =
    kind === "vector" && vectorGrayScaleSelection !== null ? vectorGrayScaleSelection : null;
  const activeVectorGrayScaleSkipped =
    kind === "vector" && vectorGrayScaleSkipped !== null ? vectorGrayScaleSkipped : null;
  const targetGraySelection = selectedTargetGray === null
    ? null
    : targetGrayFilter(selectedTargetGray).selection;
  const scanGrayScaleSelection = targetGraySelection ?? activeVectorGrayScaleSelection;
  const scanGrayScaleSkipped = selectedTargetGray !== null
    ? vectorGrayScaleSkipped ?? true
    : activeVectorGrayScaleSkipped;
  const liveGrayRule: LiveGrayRule = {
    target_gray_level: selectedTargetGray,
    gray_level_range: scanGrayScaleSelection,
    gray_level_skipped: scanGrayScaleSkipped,
  };
  const liveGrayRuleKey = JSON.stringify(liveGrayRule);
  const previousLiveGrayRuleRef = useRef(liveGrayRuleKey);
  const vectorGrayFilterActive =
    kind === "vector" &&
    targetGraySelection === null &&
    activeVectorGrayScaleSelection !== null &&
    activeVectorGrayScaleSkipped !== null;

  const logVectorRequestContext = (source: "stream" | "validated", req: VectorRequest, branch: string) => {
    if (kind !== "vector") return;
    console.info("[scan/vector] build", {
      source,
      branch,
      vectorGrayScaleSelection: activeVectorGrayScaleSelection,
      vectorGrayScaleSkipped: activeVectorGrayScaleSkipped,
      pattern: req.pattern,
      feedback_mode: req.feedback_mode,
      gray_level_range: req.gray_level_range ?? null,
      gray_level_skipped: req.gray_level_skipped ?? null,
      roi: req.roi != null,
      simulation_bitmap: req.simulation_bitmap != null,
    });
  };

  const resolveVectorBranch = (req: VectorRequest): string => {
    if (req.feedback_mode === "adaptive_gray_feedback") return "adaptive_gray_feedback";
    if (req.pattern === "custom" && req.points !== null) return "roi_gray_action";
    return "bitmap_selection";
  };

  const resolveVectorScanType = (req: VectorRequest): ScanType =>
    req.feedback_mode === "adaptive_gray_feedback"
      ? ScanType.VECTOR_ADAPTIVE_GRAN_FEED_BLANK
      : ScanType.VECTOR;

  const buildVectorRequest = useCallback(async (scanRegion?: ROIRequest | null) => {
    const requestROI = scanRegion === undefined
      ? withoutPartialROISelection(roiState)
      : { ...roiState, selection: scanRegion };
    console.info("[scan/vector] adaptive gate", {
      vectorPixelFallbackBlank,
      scanGrayScaleSelection,
      scanGrayScaleSkipped,
      isProduction,
      allowBitmapSimulation,
    });
    // Adaptive feedback is a hardware fallback for devices that cannot blank
    // vector pixels directly. In simulation, keep the loaded bitmap attached
    // so the mock stream samples the selected image instead of falling back
    // to the separately configured simulation source.
    if (isProduction && vectorPixelFallbackBlank && scanGrayScaleSelection !== null && scanGrayScaleSkipped !== null) {
      return { ...await vectorRequestWithAdaptiveGrayFeedback(
        { ...vector, roi: null },
        requestROI,
        {
          grayScaleSelection: scanGrayScaleSelection,
          grayScaleSkipped: scanGrayScaleSkipped,
        }
      ), target_gray_level: scanRegion && selectedTargetGray !== null ? selectedTargetGray : null,
      gray_level_range: scanGrayScaleSelection, gray_level_skipped: scanGrayScaleSkipped };
    }
    return { ...await vectorRequestWithBitmapSelection(
      { ...vector, roi: null },
      requestROI,
      {
        isProduction,
        allowBitmapSimulation,
        grayScaleSelection: scanGrayScaleSelection,
        grayScaleSkipped: scanGrayScaleSkipped,
      }
    ), target_gray_level: scanRegion && selectedTargetGray !== null ? selectedTargetGray : null,
      gray_level_range: scanGrayScaleSelection, gray_level_skipped: scanGrayScaleSkipped };
  }, [
    allowBitmapSimulation,
    isProduction,
    roi,
    roiState,
    scanGrayScaleSelection,
    scanGrayScaleSkipped,
    selectedTargetGray,
    vector,
    vectorPixelFallbackBlank,
  ]);

  // Phase taxonomy:
  //   idle/completed/error  → no active stream; safe to start a new one
  //   running               → WS open, chunks arriving
  //   stopping              → close requested, awaiting onclose handshake
  const streaming = phase === "running";
  const closing = phase === "stopping";
  const busy = streaming || closing;
  // The panel is disabled while a scan runs to prevent parameter changes, but
  // Stop must remain available so an active scan can always be cancelled.
  const stopAvailable = streaming || closing || infiniteScanActive || targetGrayRunning;
  const controlsDisabled = disabled || scanActive || settingsSaving || backendRestarting;

  const clearInfiniteScanState = useCallback(() => {
    regionScanRepeatRef.current = [];
    infiniteScanRef.current = null;
    infiniteScanActiveRef.current = false;
    setInfiniteScanActive((current) => current ? false : current);
    dispatch(setInfiniteActive(false));
  }, [dispatch]);

  // Infinite mirrors OBI's live scan / Acquire Photo data path, for Raster
  // AND Vector, in production and simulation: ONE WebSocket and ONE
  // synchronized FPGA command stream for the whole session (`continuous`).
  // The service queues frame after frame (Raster) or replays the point list
  // pass after pass (Vector) in-band, so XY never stops at a boundary, and
  // each chunk is painted as it arrives. The canvas keeps the current image
  // and overwrites it pixel by pixel; the cursor wraps at the frame / pass
  // end (OBI Frame.fill_lines roll-over) instead of blanking the canvas.
  // Stop -> /api/scan/abort -> command.abort, then `done`; the image stays.
  // The completed-transition restart below only fires if the stream ends
  // without Stop (e.g. after a recoverable server close).
  // Adaptive gray feedback decides each pass on the host, so it keeps the
  // per-pass loop (still painting in place).
  const startInfiniteScanRun = useCallback((entry: InfiniteScanEntry, preserveFrame = true) => {
    if (entry.kind === "raster") {
      onScanRunStart?.(ScanType.RASTER);
      stream.startRaster(
        { ...entry.req, preview: entry.req.preview ?? preview, continuous: true },
        {
          preserveFrame,
          continuous: true,
          displayROI: entry.displayROI,
          displayROIs: entry.displayROIs,
          compositeROIs: entry.compositeROIs,
          simulationBitmapInfo: entry.simulationBitmapInfo,
          hasSimulationBitmap: entry.hasSimulationBitmap,
          initialFrame: entry.initialFrame,
        },
      );
      return;
    }
    onScanRunStart?.(entry.scanType);
    const continuous = entry.req.feedback_mode !== "adaptive_gray_feedback";
    stream.startVector(
      { ...entry.req, preview: entry.req.preview ?? preview, continuous },
      {
        preserveFrame,
        continuous,
        displayROI: entry.displayROI,
        displayROIs: entry.displayROIs,
        compositeROIs: entry.compositeROIs,
        simulationBitmapInfo: entry.simulationBitmapInfo,
        hasSimulationBitmap: entry.hasSimulationBitmap,
        initialFrame: entry.initialFrame,
      },
    );
  }, [onScanRunStart, preview, stream]);

  /** Run one Vector pass. Continuous acquisition remains on the Infinite button. */
  const startVectorRun = useCallback(
    (
      req: VectorRequest,
      preserveFrame = false,
      displayROI: ROIRequest | null | undefined = undefined,
      displayROIs: ROIRequest[] | null | undefined = undefined,
      compositeROIs: ROIRequest[] | null | undefined = undefined,
      initialFrame: Uint16Array | null = null,
      onComplete?: () => void,
      simulationBitmapInfo?: { width: number; height: number } | null,
      hasSimulationBitmap?: boolean,
    ) => {
    stream.startVector({ ...req, preview }, {
      preserveFrame,
      displayROI,
      displayROIs,
      compositeROIs,
      simulationBitmapInfo,
      hasSimulationBitmap,
      initialFrame,
      onComplete,
    });
  }, [preview, stream]);

  const startRegionScanEntry = useCallback(function startEntry(entry: RegionScanEntry, preserveFrame = false) {
    // Advance from the stream event, not React phase renders: a fast stream
    // may start and complete before React renders the intermediate phase.
    const onComplete = () => {
      void latestScanQueue().then(setPendingQueue).catch(() => {});
      if (!regionScanQueueRef.current.length && regionScanRepeatRef.current.length) {
        regionScanQueueRef.current = [...regionScanRepeatRef.current];
      }
      const next = regionScanQueueRef.current.shift();
      if (next) startEntry(next, true);
    };
    if (entry.kind === "raster") {
      stream.startRaster({ ...entry.req, preview }, {
        preserveFrame,
        displayROI: entry.displayROI,
        displayROIs: entry.displayROIs,
        compositeROIs: entry.compositeROIs,
        simulationBitmapInfo: entry.simulationBitmapInfo,
        hasSimulationBitmap: entry.hasSimulationBitmap,
        initialFrame: entry.initialFrame,
        onComplete,
      });
    } else {
      startVectorRun(
        entry.req, preserveFrame, entry.displayROI, entry.displayROIs, entry.compositeROIs,
        entry.initialFrame, onComplete, entry.simulationBitmapInfo, entry.hasSimulationBitmap,
      );
    }
  }, [preview, startVectorRun, stream]);

  const startRegionScanSequence = useCallback((entries: RegionScanEntry[], preserveFirst = false, repeat = false) => {
    const [first, ...rest] = entries;
    if (!first) return;
    regionScanRepeatRef.current = repeat ? entries : [];
    if (repeat) {
      infiniteScanRef.current = null;
      infiniteScanActiveRef.current = true;
      setInfiniteScanActive(true);
      dispatch(setInfiniteActive(true));
    }
    regionScanQueueRef.current = rest;
    startRegionScanEntry(first, preserveFirst);
  }, [dispatch, startRegionScanEntry]);

  async function persistScanSequence(entries: RegionScanEntry[], repeat: boolean): Promise<RegionScanEntry[]> {
    if (repeat) return entries;
    const stored = entries.map(({ initialFrame: _initialFrame, ...entry }) => entry) as StoredScanEntry[];
    const created = await createScanQueue(stored);
    setPendingQueue(created.summary);
    return entries.map((entry, index) => ({ ...entry, req: created.entries[index].req })) as RegionScanEntry[];
  }

  async function resumeScanQueue() {
    if (!pendingQueue || pendingQueue.status === "running" || disabled) return;
    try {
      const allowed = await refreshScanPrivilege();
      if (!allowed) return;
      const queue = await latestScanQueue();
      if (!queue || queue.status !== "interrupted" || queue.next_index < 0 || queue.next_index >= queue.total) {
        setPendingQueue(null);
        return;
      }
      const entries = await loadScanQueue(queue);
      const remaining = entries.slice(queue.next_index);
      if (!remaining.length || remaining[0].kind !== kind) return;
      startRegionScanSequence(remaining.map((entry) => ({ ...entry, initialFrame: null })) as RegionScanEntry[], true);
      setPendingQueue({ ...queue, status: "running" });
    } catch (err) {
      dispatch(streamErrored(err instanceof Error ? err.message : String(err)));
    }
  }

  async function startRunRequest(repeatRegions = false) {
    if (disabled) return;
    const allowed = await refreshScanPrivilege();
    if (!allowed) return;
    if (!repeatRegions && !isProduction && selectedTargetGray !== null && roiState.imageDataUrl) {
      dispatch(requestROITargetGrayRun());
      return;
    }
    if (
      selectedTargetGray !== null &&
      ((!isProduction && !roiState.imageDataUrl) ||
        (kind === "vector" && isProduction && !vectorPixelFallbackBlank && !roiState.imageDataUrl))
    ) {
      dispatch(streamErrored(t("roi.targetGray.noImage")));
      return;
    }
    if (kind === "raster") {
      try {
        const regions = effectiveScanRegions(roiState.scan_regions, roiState.scan_zoom, roiState);
        const displayRegions = roiState.scan_regions.length
          ? roiState.scan_regions.map((region) => worldSelectionToDacROI(region, roiState))
          : [null];
        const roiAreaDefined = roiState.scan_regions.length > 0 || roiState.selection !== null;
        // ROI samples only replace their rectangle; keep the previous scan
        // outside it in both hardware and simulation modes.
        const rasterBackground = roiAreaDefined && rasterImageFilled > 0
          ? resizeImageFrame(rasterImageFrame, rasterImageResolution, raster.resolution)
          : null;
        const initialFrames = !isProduction && roiState.imageDataUrl
          ? await Promise.all(regions.map((region, index) => bitmapImageFrame(roiState, raster.resolution, {
              sourceSelection: region,
              displayROI: displayRegions[index] ?? null,
            })))
          : regions.map(() => rasterBackground);
        const requests = await Promise.all(regions.map((region) => rasterRequestWithBitmapSelection(
          { ...raster, roi: region },
          { ...roiState, selection: region },
          {
            isProduction,
            allowBitmapSimulation,
            grayScaleSelection: scanGrayScaleSelection,
            grayScaleSkipped: scanGrayScaleSkipped,
          },
        )));
        onScanRunStart?.(ScanType.RASTER);
        const entries = requests.map((req, index) => ({
          kind: "raster" as const,
          req,
          displayROI: displayRegions[index] ?? null,
          initialFrame: initialFrames[index] ?? null,
        }));
        const fullRequest = compositeROIs ? {
          ...await rasterRequestWithBitmapSelection(
            { ...raster, roi: FULL_DAC_ROI }, { ...roiState, selection: null },
            { isProduction, allowBitmapSimulation, grayScaleSelection: null, grayScaleSkipped: null },
          ), roi: FULL_DAC_ROI,
        } : null;
        const scanEntries = compositeROIs && fullRequest && (parallelRegions || requests.length === 1)
          ? [{
              kind: "raster" as const,
              req: combineRasterRegions([fullRequest, ...requests]),
              displayROI: null,
              displayROIs: [FULL_DAC_ROI, ...displayRegions] as ROIRequest[],
              compositeROIs: displayRegions as ROIRequest[],
              initialFrame: initialFrames[0] ?? null,
            }]
          : compositeROIs && fullRequest
          ? [{
              kind: "raster" as const, req: fullRequest,
              displayROI: null, displayROIs: [FULL_DAC_ROI],
              compositeROIs: displayRegions as ROIRequest[],
              initialFrame: initialFrames[0] ?? null,
            }, ...entries]
          : entries;
        startRegionScanSequence(await persistScanSequence(scanEntries, repeatRegions), roiAreaDefined && rasterBackground !== null && (isProduction || !roiState.imageDataUrl), repeatRegions);
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    } else {
      try {
        const regions = effectiveScanRegions(roiState.scan_regions, roiState.scan_zoom, roiState);
        const displayRegions = roiState.scan_regions.length
          ? roiState.scan_regions.map((region) => worldSelectionToDacROI(region, roiState))
          : [null];
        const roiAreaDefined = roiState.scan_regions.length > 0 || roiState.selection !== null;
        const vectorBackground = roiAreaDefined && vectorImageFilled > 0
          ? resizeImageFrame(vectorImageFrame, vectorImageEdge, vector.vector_resolution)
          : null;
        const initialFrames = !isProduction && roiState.imageDataUrl
          ? await Promise.all(regions.map((region, index) => bitmapImageFrame(roiState, vector.vector_resolution, {
              sourceSelection: region,
              displayROI: displayRegions[index] ?? null,
            })))
          : regions.map(() => vectorBackground);
        const backgroundRequest = compositeROIs
          ? await vectorRequestWithBitmapSelection(
              {
                ...vector, pattern: "default", points: null, roi: null,
                feedback_mode: "standard", gray_level_range: null, gray_level_skipped: null,
              },
              { ...roiState, selection: null },
              { isProduction, allowBitmapSimulation, grayScaleSelection: null, grayScaleSkipped: null },
            )
          : null;
        const requests = await Promise.all(regions.map((region) => buildVectorRequest(region)));
        if (backgroundRequest?.simulation_bitmap) {
          for (const request of requests) {
            if (request.pattern === "default" && !request.points) {
              request.simulation_bitmap = backgroundRequest.simulation_bitmap;
            }
          }
        }
        const compositeVector = compositeROIs && requests.every((request) =>
          request.pattern === "default" && !request.points && request.feedback_mode !== "adaptive_gray_feedback");
        const adaptiveComposite = compositeROIs && requests.every((request) =>
          request.pattern === "default" && !request.points && request.feedback_mode === "adaptive_gray_feedback");
        requests.forEach((req) => logVectorRequestContext("stream", req, resolveVectorBranch(req)));
        const entries = requests.map((req, index) => ({
          kind: "vector" as const,
          req,
          scanType: resolveVectorScanType(req),
          displayROI: displayRegions[index] ?? null,
          initialFrame: initialFrames[index] ?? null,
        }));
        onScanRunStart?.(entries[0]?.scanType ?? ScanType.VECTOR);
        const backgroundEntry = {
          kind: "vector" as const,
          req: backgroundRequest ?? vector,
          scanType: ScanType.VECTOR,
          displayROI: null,
          displayROIs: [FULL_DAC_ROI],
          compositeROIs: displayRegions as ROIRequest[],
          initialFrame: initialFrames[0] ?? null,
        };
        const scanEntries = adaptiveComposite
          ? [backgroundEntry, ...entries.map((entry) => ({ ...entry, initialFrame: null }))]
          : compositeVector && (parallelRegions || requests.length === 1)
          ? [{
              kind: "vector" as const,
              req: combineVectorRegions([
                { ...backgroundRequest!, roi: FULL_DAC_ROI },
                ...requests,
              ]),
              scanType: entries[0].scanType,
              displayROI: null,
              displayROIs: [FULL_DAC_ROI, ...displayRegions] as ROIRequest[],
              compositeROIs: displayRegions as ROIRequest[],
              initialFrame: initialFrames[0] ?? null,
            }]
          : compositeROIs && parallelRegions && requests.length > 1
          ? [backgroundEntry, {
              kind: "vector" as const,
              req: combineVectorRegions(requests),
              scanType: entries[0].scanType,
              displayROI: null,
              displayROIs: displayRegions as ROIRequest[],
              customPointGroupLengths: requests.every((request) => request.pattern === "custom" && request.points)
                ? requests.map((request) => request.points?.length ?? 0) : undefined,
              customPointROIs: requests.every((request) => request.pattern === "custom" && request.points)
                ? requests.map((request) => request.roi ?? null) : undefined,
              initialFrame: null,
            }]
          : compositeROIs
          ? [backgroundEntry, ...entries.map((entry) => ({ ...entry, initialFrame: null }))]
          : entries;
        startRegionScanSequence(await persistScanSequence(scanEntries, repeatRegions), roiAreaDefined && vectorBackground !== null && (isProduction || !roiState.imageDataUrl), repeatRegions);
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    }
  }

  async function startInfiniteRequest() {
    if ((kind !== "raster" && kind !== "vector") || disabled || infiniteScanActiveRef.current) return;
    // Production: a Live scan started with an ROI first scans the full frame.
    // The ROI is applied once that frame has been rendered (see the watcher
    // effect below), so the operator never sees an empty canvas around the ROI.
    const fullFrameRendered = kind === "raster"
      ? rasterImageFilled >= raster.resolution * raster.resolution
      : vectorImageFilled >= vector.vector_resolution * vector.vector_resolution;
    const deferRegions = isProduction && roiState.scan_regions.length > 0 &&
      !fullFrameReadyRef.current && !fullFrameRendered;
    const scanRegionsNow = deferRegions ? [] : roiState.scan_regions;
    const compositeNow = scanRegionsNow.length > 0;
    if (scanRegionsNow.length > 1 && !parallelRegions) {
      await startRunRequest(true);
      return;
    }
    const allowed = await refreshScanPrivilege();
    if (!allowed) return;
    try {
      if (scanRegionsNow.length > 1 && parallelRegions) {
        const regions = effectiveScanRegions(scanRegionsNow, roiState.scan_zoom, roiState)
          .filter((region): region is ROIRequest => region !== null);
        const displayRegions = scanRegionsNow.map((region) => worldSelectionToDacROI(region, roiState));
        let parallelEntry: InfiniteScanEntry;
        if (kind === "raster") {
          const initialFrame = !isProduction && roiState.imageDataUrl
            ? await bitmapImageFrame(roiState, raster.resolution, {
                sourceSelection: regions[0], displayROI: displayRegions[0],
              })
            : rasterImageFilled > 0
              ? resizeImageFrame(rasterImageFrame, rasterImageResolution, raster.resolution)
              : null;
          const requests = await Promise.all(regions.map((region) => rasterRequestWithBitmapSelection(
            { ...raster, roi: region }, { ...roiState, selection: region },
            { isProduction, allowBitmapSimulation, grayScaleSelection: scanGrayScaleSelection, grayScaleSkipped: scanGrayScaleSkipped },
          )));
          const fullRequest = await rasterRequestWithBitmapSelection(
            { ...raster, roi: FULL_DAC_ROI }, { ...roiState, selection: null },
            { isProduction, allowBitmapSimulation, grayScaleSelection: null, grayScaleSkipped: null },
          );
          if (fullRequest.simulation_bitmap) {
            for (const request of requests) request.simulation_bitmap = decorateSimulationBitmap(
              fullRequest.simulation_bitmap, scanGrayScaleSelection, scanGrayScaleSkipped,
            );
          }
          parallelEntry = {
            kind: "raster",
            req: combineRasterRegions([{ ...fullRequest, roi: FULL_DAC_ROI }, ...requests]),
            displayROI: null,
            displayROIs: [FULL_DAC_ROI, ...displayRegions],
            compositeROIs: displayRegions,
            initialFrame,
          };
        } else {
          const initialFrame = !isProduction && roiState.imageDataUrl
            ? await bitmapImageFrame(roiState, vector.vector_resolution, {
                sourceSelection: regions[0], displayROI: displayRegions[0],
              })
            : vectorImageFilled > 0
              ? resizeImageFrame(vectorImageFrame, vectorImageEdge, vector.vector_resolution)
              : null;
          const requests = await Promise.all(regions.map((region) => buildVectorRequest(region)));
          if (requests.some((request) => request.pattern !== "default" || request.points || request.feedback_mode === "adaptive_gray_feedback")) {
            await startRunRequest(true);
            return;
          }
          const fullRequest = await vectorRequestWithBitmapSelection(
            { ...vector, pattern: "default", points: null, roi: null,
              feedback_mode: "standard", gray_level_range: null, gray_level_skipped: null },
            { ...roiState, selection: null },
            { isProduction, allowBitmapSimulation, grayScaleSelection: null, grayScaleSkipped: null },
          );
          if (fullRequest.simulation_bitmap) {
            for (const request of requests) request.simulation_bitmap = decorateSimulationBitmap(
              fullRequest.simulation_bitmap, scanGrayScaleSelection, scanGrayScaleSkipped,
            );
          }
          parallelEntry = {
            kind: "vector",
            req: combineVectorRegions([{ ...fullRequest, roi: FULL_DAC_ROI }, ...requests]),
            scanType: resolveVectorScanType(requests[0]),
            displayROI: null,
            displayROIs: [FULL_DAC_ROI, ...displayRegions],
            compositeROIs: displayRegions,
            initialFrame,
          };
        }
        deferredRegionsRef.current = deferRegions;
        infiniteScanRef.current = parallelEntry;
        infiniteScanActiveRef.current = true;
        setInfiniteScanActive(true);
        dispatch(setInfiniteActive(true));
        startInfiniteScanRun(parallelEntry, isProduction || parallelEntry.initialFrame === null);
        return;
      }
      const regions = effectiveScanRegions(scanRegionsNow, roiState.scan_zoom, roiState);
      const activeIndex = roiState.active_scan_region ?? 0;
      const region = regions[Math.min(activeIndex, regions.length - 1)] ?? null;
      const selectedRegion = scanRegionsNow[Math.min(activeIndex, scanRegionsNow.length - 1)] ?? null;
      const displayROI = selectedRegion ? worldSelectionToDacROI(selectedRegion, roiState) : null;
      const roiAreaDefined = scanRegionsNow.length > 0 || roiState.selection !== null;
      let entry: InfiniteScanEntry;
      if (kind === "raster") {
        const initialFrame = !isProduction && roiState.imageDataUrl
          ? await bitmapImageFrame(roiState, raster.resolution, {
              sourceSelection: region,
              displayROI,
            })
          : roiAreaDefined && rasterImageFilled > 0
            ? resizeImageFrame(rasterImageFrame, rasterImageResolution, raster.resolution)
            : null;
        const req = await rasterRequestWithBitmapSelection(
          { ...raster, roi: region },
          { ...roiState, selection: region },
          {
            isProduction,
            allowBitmapSimulation,
            grayScaleSelection: scanGrayScaleSelection,
            grayScaleSkipped: scanGrayScaleSkipped,
          }
        );
        if (compositeNow && displayROI) {
          const fullReq = await rasterRequestWithBitmapSelection(
            { ...raster, roi: FULL_DAC_ROI },
            { ...roiState, selection: null },
            { isProduction, allowBitmapSimulation, grayScaleSelection: null, grayScaleSkipped: null },
          );
          entry = {
            kind: "raster",
            req: { ...combineRasterRegions([{ ...fullReq, roi: FULL_DAC_ROI }, {
              ...req, simulation_bitmap: fullReq.simulation_bitmap
                ? decorateSimulationBitmap(fullReq.simulation_bitmap, scanGrayScaleSelection, scanGrayScaleSkipped)
                : req.simulation_bitmap,
            }]), preview },
            displayROI: null,
            displayROIs: [FULL_DAC_ROI, displayROI],
            compositeROIs: [displayROI],
            initialFrame,
          };
        } else {
          entry = { kind: "raster", req: { ...req, preview }, displayROI, initialFrame };
        }
      } else {
        const initialFrame = !isProduction && roiState.imageDataUrl
          ? await bitmapImageFrame(roiState, vector.vector_resolution, {
              sourceSelection: region,
              displayROI,
            })
          : roiAreaDefined && vectorImageFilled > 0
            ? resizeImageFrame(vectorImageFrame, vectorImageEdge, vector.vector_resolution)
            : null;
        const req = await buildVectorRequest(region);
        if (compositeNow && (req.feedback_mode === "adaptive_gray_feedback" || req.pattern === "custom")) {
          await startRunRequest(true);
          return;
        }
        logVectorRequestContext(
          "stream",
          req,
          resolveVectorBranch(req),
        );
        if (compositeNow && displayROI && req.pattern === "default" && !req.points && req.feedback_mode !== "adaptive_gray_feedback") {
          const fullReq = await vectorRequestWithBitmapSelection(
            { ...vector, pattern: "default", points: null, roi: null,
              feedback_mode: "standard", gray_level_range: null, gray_level_skipped: null },
            { ...roiState, selection: null },
            { isProduction, allowBitmapSimulation, grayScaleSelection: null, grayScaleSkipped: null },
          );
          entry = {
            kind: "vector",
            req: { ...combineVectorRegions([{ ...fullReq, roi: FULL_DAC_ROI }, {
              ...req, simulation_bitmap: fullReq.simulation_bitmap
                ? decorateSimulationBitmap(fullReq.simulation_bitmap, scanGrayScaleSelection, scanGrayScaleSkipped)
                : req.simulation_bitmap,
            }]), preview },
            scanType: resolveVectorScanType(req),
            displayROI: null,
            displayROIs: [FULL_DAC_ROI, displayROI],
            compositeROIs: [displayROI],
            initialFrame,
          };
        } else {
          entry = {
            kind: "vector",
            req: { ...req, preview },
            scanType: resolveVectorScanType(req),
            displayROI,
            initialFrame,
          };
        }
      }
      deferredRegionsRef.current = deferRegions;
      infiniteScanRef.current = entry;
      infiniteScanActiveRef.current = true;
      setInfiniteScanActive(true);
      dispatch(setInfiniteActive(true));
      startInfiniteScanRun(entry, isProduction || entry.initialFrame === null);
    } catch (e: any) {
      clearInfiniteScanState();
      dispatch(streamErrored(e?.message ?? String(e)));
    }
  }

  function onStop() {
    if (!stopAvailable) return;
    if (targetGrayRunning) {
      dispatch(finishROITargetGrayRun("stopped"));
      return;
    }
    if (zoomRestartTimerRef.current !== null) window.clearTimeout(zoomRestartTimerRef.current);
    zoomRestartTimerRef.current = null;
    setPendingZoomRestart(null);
    // Like OBI, stopping a live session leaves the last image on the canvas:
    // Infinite (a single live session until Stop).
    // Only single runs clear it.
    const stoppingLiveScan = infiniteScanActiveRef.current;
    deferredRegionsRef.current = false;
    fullFrameReadyRef.current = false;
    clearInfiniteScanState();
    regionScanQueueRef.current = [];
    // A loaded simulation image is the canvas's initial frame. Keep it visible
    // when Stop cancels a single run; clear an ordinary run after shutdown.
    if (!stoppingLiveScan && !roiState.imageDataUrl && (kind === "raster" || kind === "vector")) {
      pendingStopClearRef.current = kind;
    }
    stopAllScanActions();
  }

  async function onZoomChange(value: string) {
    setZoomError(null);
    if (zoomRestartTimerRef.current !== null) window.clearTimeout(zoomRestartTimerRef.current);
    zoomRestartTimerRef.current = null;
    const zoom = Number(value);
    if (!Number.isInteger(zoom) || zoom < 1 || zoom > 20000) return;
    const generation = ++zoomUpdateGenerationRef.current;
    if (zoom === roiState.scan_zoom) return;
    if (!stream.hasActiveStream()) {
      dispatch(setScanZoom(zoom));
      return;
    }
    const liveEntry = infiniteScanRef.current;
    if (infiniteScanActiveRef.current) {
      const regions = effectiveScanRegions(roiState.scan_regions, zoom, roiState);
      const dacRegions = regions.map((region) => region ? worldSelectionToDacROI(region, roiState) : null);
      // Sequential Infinite scans already end each region before starting the
      // next one. Replace their queued DAC bounds without cancelling the
      // region currently on the wire.
      if (!liveEntry) {
        const entries = regionScanRepeatRef.current;
        const customEntryIndex = entries.length === 2 && entries[0].compositeROIs ? 1 : 0;
        const combined = entries[customEntryIndex];
        if (entries.length === customEntryIndex + 1 && combined?.kind === "vector" &&
            combined.req.pattern === "custom" && combined.req.points &&
            combined.customPointGroupLengths && combined.customPointROIs &&
            dacRegions.length === combined.customPointGroupLengths.length) {
          const entry = combined;
          entry.req.points = zoomInterleavedVectorPoints(
            entry.req.points!, entry.customPointGroupLengths!, entry.customPointROIs!, dacRegions,
          );
          entry.customPointROIs = dacRegions;
          dispatch(setScanZoom(zoom));
          return;
        }
        const backgroundEntries = entries.length === dacRegions.length + 1 && entries[0]?.compositeROIs ? 1 : 0;
        if (entries.length !== dacRegions.length + backgroundEntries) return;
        entries.slice(backgroundEntries).forEach((entry, index) => {
          const target = dacRegions[index] ?? null;
          if (entry.kind === "vector" && entry.req.pattern === "custom" && entry.req.points) {
            entry.req.points = zoomVectorPoints(entry.req.points, entry.req.roi ?? null, target);
          }
          entry.req.roi = target;
        });
        dispatch(setScanZoom(zoom));
        return;
      }
      // The service cannot change the region count of a running stream. If the
      // running stream no longer matches the current regions (a region was just
      // added or removed), rebuild the live scan at the new zoom instead.
      const runningCount = liveEntry.req.parallel_rois?.length ?? 0;
      const targetCount = liveEntry.req.parallel_rois
        ? (liveEntry.compositeROIs ? 1 : 0) + dacRegions.length
        : 0;
      if (runningCount !== targetCount) {
        dispatch(setScanZoom(zoom));
        scheduleZoomRestart("infinite");
        return;
      }
      if (liveEntry.kind === "vector" && liveEntry.req.feedback_mode === "adaptive_gray_feedback") {
        liveEntry.req.roi = dacRegions[0] ?? null;
        dispatch(setScanZoom(zoom));
        return;
      }
      if (liveEntry.kind === "vector" && liveEntry.req.pattern === "custom" && liveEntry.req.points) {
        const target = dacRegions[0] ?? null;
        const points = zoomVectorPoints(liveEntry.req.points, liveEntry.req.roi ?? null, target);
        if (stream.updateGeometry(
          { roi: target, parallel_rois: liveEntry.req.parallel_rois ?? null, points },
          (detail) => {
            if (zoomUpdateGenerationRef.current !== generation) return;
            if (/region count/i.test(detail)) {
              dispatch(setScanZoom(zoom));
              scheduleZoomRestart("infinite");
              return;
            }
            dispatch(setScanZoom(roiState.scan_zoom));
            setZoomError(detail);
          },
          () => {
            liveEntry.req.roi = target;
            liveEntry.req.points = points;
            dispatch(setLiveVectorCustomPoints(points));
          },
        )) {
          dispatch(setScanZoom(zoom));
        } else {
          setZoomError("Scan stream is not ready to accept a zoom change yet.");
        }
        return;
      }
      const parallelROIs = liveEntry.req.parallel_rois
        ? [...(liveEntry.compositeROIs ? [FULL_DAC_ROI] : []),
            ...dacRegions.filter((region): region is ROIRequest => region !== null)]
        : null;
      const geometry = { roi: parallelROIs ? null : dacRegions[0] ?? null, parallel_rois: parallelROIs };
      // A blanked sample keeps its underlay. Rebuild that underlay from the
      // original image, rather than retaining pixels acquired at the old zoom.
      let initialImage: Uint16Array | null = null;
      if (liveEntry.kind === "vector" && !isProduction && roiState.imageDataUrl && vectorGrayFilterActive) {
        try {
          initialImage = await bitmapImageFrame(roiState, vectorImageEdge, regions.map((region, index) => ({
            sourceSelection: region,
            displayROI: liveEntry.compositeROIs?.[index] ?? liveEntry.displayROIs?.[index] ?? liveEntry.displayROI ?? null,
          })));
        } catch (error) {
          if (generation === zoomUpdateGenerationRef.current) {
            setZoomError(error instanceof Error ? error.message : String(error));
          }
          return;
        }
      }
      if (generation !== zoomUpdateGenerationRef.current || infiniteScanRef.current !== liveEntry ||
          !infiniteScanActiveRef.current) return;
      if (stream.updateGeometry(geometry, (detail) => {
        if (zoomUpdateGenerationRef.current !== generation) return;
        if (/region count/i.test(detail)) {
          dispatch(setScanZoom(zoom));
          scheduleZoomRestart("infinite");
          return;
        }
        dispatch(setScanZoom(roiState.scan_zoom));
        setZoomError(detail);
      }, () => {
        liveEntry.req.roi = geometry.roi;
        liveEntry.req.parallel_rois = geometry.parallel_rois;
        if (initialImage) {
          dispatch(queueLiveScanDisplay({ kind: "vector", display: {
            roi: liveEntry.displayROI ?? null,
            parallelROIs: liveEntry.displayROIs ?? null,
            compositeROIs: liveEntry.compositeROIs ?? null,
            initialImage,
          } }));
        }
      })) {
        dispatch(setScanZoom(zoom));
      } else {
        setZoomError("Scan stream is not ready to accept a zoom change yet.");
      }
      return;
    }
    dispatch(setScanZoom(zoom));
    scheduleZoomRestart("single");
  }

  useEffect(() => {
    const previous = previousScanRegionsRef.current;
    const current = roiState.scan_regions;
    previousScanRegionsRef.current = current;
    if (previous === current || suppressRegionRollbackRef.current) {
      suppressRegionRollbackRef.current = false;
      return;
    }
    if (!infiniteScanActiveRef.current) return;
    // Regions are applied after the full-frame pass (watcher effect).
    if (deferredRegionsRef.current) return;
    // The service cannot change the region count of a running continuous
    // stream. A region drawn or removed on the live screen therefore restarts
    // the same live scan (same scan type, same screen) with the new region set.
    if (previous.length !== current.length) {
      scheduleZoomRestart("infinite");
      return;
    }
    if (!current.length) return;

    const displayRegions = current.map((region) => worldSelectionToDacROI(region, roiState));
    const scanRegions = effectiveScanRegions(current, roiState.scan_zoom, roiState)
      .map((region) => region ? worldSelectionToDacROI(region, roiState) : null);
    const liveEntry = infiniteScanRef.current;
    if (!liveEntry) {
      // OBI's per-frame loop reads the edited ROI at the next frame. Our
      // sequential Infinite loop likewise updates its queued entries only.
      const entries = regionScanRepeatRef.current;
      const backgroundCount = entries.length > 1 && entries[0].compositeROIs ? 1 : 0;
      if (backgroundCount) entries[0].compositeROIs = displayRegions;
      const activeEntries = entries.slice(backgroundCount);
      if (activeEntries.length === current.length) {
        activeEntries.forEach((entry, index) => {
          const target = scanRegions[index];
          if (entry.kind === "vector" && entry.req.pattern === "custom" && entry.req.points) {
            entry.req.points = zoomVectorPoints(entry.req.points, entry.req.roi ?? null, target);
          }
          entry.req.roi = target;
          entry.displayROI = displayRegions[index];
        });
      } else if (activeEntries.length === 1 && activeEntries[0].kind === "vector" &&
                 activeEntries[0].customPointGroupLengths && activeEntries[0].customPointROIs &&
                 activeEntries[0].req.points) {
        const entry = activeEntries[0];
        entry.req.points = zoomInterleavedVectorPoints(
          entry.req.points!, entry.customPointGroupLengths!, entry.customPointROIs!, scanRegions,
        );
        entry.customPointROIs = scanRegions;
        entry.displayROIs = displayRegions;
      } else if (activeEntries.length === 1 && activeEntries[0].req.parallel_rois) {
        const entry = activeEntries[0];
        entry.req.parallel_rois = scanRegions.filter((region): region is ROIRequest => region !== null);
        entry.displayROIs = displayRegions;
      }
      return;
    }

    const target = scanRegions[roiState.active_scan_region ?? 0] ?? scanRegions[0];
    const parallelROIs = liveEntry.req.parallel_rois
      ? [...(liveEntry.compositeROIs ? [FULL_DAC_ROI] : []),
          ...scanRegions.filter((region): region is ROIRequest => region !== null)]
      : null;
    const points = liveEntry.kind === "vector" && liveEntry.req.pattern === "custom" && liveEntry.req.points
      ? zoomVectorPoints(liveEntry.req.points, liveEntry.req.roi ?? null, target)
      : undefined;
    const display = {
      roi: parallelROIs ? null : displayRegions[roiState.active_scan_region ?? 0] ?? displayRegions[0],
      parallelROIs: parallelROIs
        ? [...(liveEntry.compositeROIs ? [FULL_DAC_ROI] : []), ...displayRegions]
        : null,
      compositeROIs: liveEntry.compositeROIs ? displayRegions : null,
    };
    const geometry = { roi: parallelROIs ? null : target, parallel_rois: parallelROIs, ...(points ? { points } : {}) };
    const changed = current.map((region, index) => region !== previous[index] ? index : -1).filter((index) => index >= 0);
    const generation = ++regionUpdateGenerationRef.current;
    if (!stream.updateGeometry(geometry, (detail) => {
      if (generation !== regionUpdateGenerationRef.current) return;
      console.warn("[scan] live ROI edit rejected:", detail);
      if (/region count/i.test(detail)) {
        scheduleZoomRestart("infinite");
        return;
      }
      suppressRegionRollbackRef.current = true;
      changed.forEach((index) => dispatch(updateScanRegion({ index, region: previous[index] })));
    }, () => {
      if (generation !== regionUpdateGenerationRef.current) return;
      liveEntry.req.roi = geometry.roi;
      liveEntry.req.parallel_rois = parallelROIs;
      liveEntry.displayROI = display.roi;
      liveEntry.displayROIs = display.parallelROIs;
      liveEntry.compositeROIs = display.compositeROIs;
      if (points && liveEntry.kind === "vector") {
        liveEntry.req.points = points;
        dispatch(setLiveVectorCustomPoints(points));
      }
      dispatch(queueLiveScanDisplay({ kind: liveEntry.kind, display }));
    })) {
      suppressRegionRollbackRef.current = true;
      changed.forEach((index) => dispatch(updateScanRegion({ index, region: previous[index] })));
    }
  }, [roiState.scan_regions]);

  // Production: once the full-frame pass has rendered, restart the live scan
  // with the held-back ROI(s). The rendered frame is preserved by the restart.
  useEffect(() => {
    if (!deferredRegionsRef.current || !infiniteScanActiveRef.current || liveFramesDone < 1) return;
    deferredRegionsRef.current = false;
    fullFrameReadyRef.current = true;
    scheduleZoomRestart("infinite");
  }, [liveFramesDone]);

  function scheduleZoomRestart(mode: "single" | "infinite") {
    if (zoomRestartTimerRef.current !== null) window.clearTimeout(zoomRestartTimerRef.current);
    // The FPGA receives scan coordinates at stream start. Rebuild the request
    // only if the current scan cannot accept an in-band geometry update.
    zoomRestartTimerRef.current = window.setTimeout(() => {
      zoomRestartTimerRef.current = null;
      if (phaseRef.current !== "running" || !stream.hasActiveStream()) return;
      clearInfiniteScanState();
      regionScanQueueRef.current = [];
      setPendingZoomRestart(mode);
      stream.stop();
    }, 350);
  }

  useEffect(() => {
    const changed = previousLiveGrayRuleRef.current !== liveGrayRuleKey;
    previousLiveGrayRuleRef.current = liveGrayRuleKey;
    if (!changed || !infiniteScanActiveRef.current) return;
    setGrayRuleError(null);
    const liveEntry = infiniteScanRef.current;
    const entries = liveEntry ? [liveEntry] : regionScanRepeatRef.current;
    for (const [index, entry] of entries.entries()) {
      if (entry.kind !== "vector") continue;
      if (index === 0 && entries.length > 1 && entry.compositeROIs?.length) continue;
      Object.assign(entry.req, liveGrayRule);
      if (entry.req.simulation_bitmap) {
        entry.req.simulation_bitmap = decorateSimulationBitmap(
          entry.req.simulation_bitmap, scanGrayScaleSelection, scanGrayScaleSkipped);
      }
      if (entry.req.parallel_simulation_bitmaps) {
        entry.req.parallel_simulation_bitmaps = entry.req.parallel_simulation_bitmaps.map((bitmap, regionIndex) =>
          regionIndex === 0 && entry.compositeROIs?.length ? bitmap :
            decorateSimulationBitmap(bitmap, scanGrayScaleSelection, scanGrayScaleSkipped));
      }
      // Finite adaptive passes and queued regions pick up the rule on their
      // next natural pass; continuous sessions receive it over the same socket.
      if (entry === liveEntry && entry.req.feedback_mode !== "adaptive_gray_feedback") {
        if (!stream.updateGeometry({ gray_rule: liveGrayRule }, setGrayRuleError)) {
          setGrayRuleError("Scan stream is not ready to accept a gray-level change yet.");
        }
      }
    }
    // Compare the rule's values, not the arrays recreated by each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveGrayRuleKey]);

  async function startValidatedRunRequest() {
    if (disabled || kind === "roi") return;
    const allowed = await refreshScanPrivilege();
    if (!allowed) {
      return;
    }
    if (kind === "raster") {
      try {
        const regions = effectiveScanRegions(roiState.scan_regions, roiState.scan_zoom, roiState);
        const requests = await Promise.all(regions.map((region) => rasterRequestWithBitmapSelection(
          { ...raster, roi: region },
          { ...roiState, selection: region },
          { isProduction, allowBitmapSimulation, grayScaleSelection: null, grayScaleSkipped: null },
        )));
        const runRequests = compositeROIs
          ? [combineRasterRegions([
              { ...await rasterRequestWithBitmapSelection(
                { ...raster, roi: FULL_DAC_ROI },
                { ...roiState, selection: null },
                { isProduction, allowBitmapSimulation, grayScaleSelection: null, grayScaleSkipped: null },
              ), roi: FULL_DAC_ROI },
              ...requests,
            ])]
          : parallelRegions && requests.length > 1
          ? [combineRasterRegions(requests)]
          : requests;
        let current: { abort?: () => void } | null = null;
        let cancelled = false;
        const promise = (async () => {
          for (const req of runRequests) {
            if (cancelled) break;
            current = dispatch(runRasterValidated({
              ...req,
              preview,
              ...(sessionSimulation && !hasBitmapSimulation(req) ? { simulation: sessionSimulation } : {}),
            }));
            await (current as unknown as Promise<unknown>);
          }
        })();
        const unregister = registerScanActionStop(() => {
          cancelled = true;
          (current as { abort?: () => void } | null)?.abort?.();
          dispatch(streamReset());
        });
        promise.finally(unregister);
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    }
    else {
      try {
        const regions = effectiveScanRegions(roiState.scan_regions, roiState.scan_zoom, roiState);
        const requests = await Promise.all(regions.map((region) => buildVectorRequest(region)));
        const compositeVector = compositeROIs && requests.every((request) =>
          request.pattern === "default" && !request.points && request.feedback_mode !== "adaptive_gray_feedback");
        const runRequests = compositeVector
          ? [combineVectorRegions([{ ...await buildVectorRequest(null), roi: FULL_DAC_ROI }, ...requests])]
          : parallelRegions && requests.length > 1
          ? [combineVectorRegions(requests)]
          : requests;
        let current: { abort?: () => void } | null = null;
        let cancelled = false;
        const promise = (async () => {
          for (const req of runRequests) {
            if (cancelled) break;
            logVectorRequestContext("validated", req, resolveVectorBranch(req));
            current = dispatch(runVectorValidated({
              ...req,
              preview,
              ...(sessionSimulation && !hasBitmapSimulation(req) ? { simulation: sessionSimulation } : {}),
            }));
            await (current as unknown as Promise<unknown>);
          }
        })();
        const unregister = registerScanActionStop(() => {
          cancelled = true;
          (current as { abort?: () => void } | null)?.abort?.();
          dispatch(streamReset());
        });
        promise.finally(unregister);
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    }
  }

  function onClear() {
    if (disabled) return;
    dispatch(streamReset());
    if (kind === "raster") dispatch(resetRaster({ resolution: raster.resolution }));
    else dispatch(resetVector());
  }

  // One click must start exactly one stream. The handlers await the request
  // build (bitmap selection, privilege check) before startVector/startRaster
  // marks the stream "running", and the Run button stays enabled for that
  // window. A second click then opened a second stream that closed the
  // first one's socket: the service kept that unattended scan, rejected the
  // second as "busy", and the first scan's real result was never shown.
  const runStartingRef = useRef(false);
  const guardRunStart = (start: () => Promise<void>) => async () => {
    if (runStartingRef.current) return;
    runStartingRef.current = true;
    setRunStarting(true);
    try {
      await start();
    } finally {
      runStartingRef.current = false;
      setRunStarting(false);
    }
  };
  const onRun = guardRunStart(startRunRequest);
  const onInfinite = guardRunStart(startInfiniteRequest);
  const onRunValidated = guardRunStart(startValidatedRunRequest);

  const runDisabled =
    controlsDisabled ||
    streaming ||
    closing ||
    runStarting ||
    targetGrayRunning;
  const stopDisabled = !stopAvailable || closing;
  const infiniteDisabled =
    (kind !== "raster" && kind !== "vector") || runDisabled || infiniteScanActive;
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/admin/iobeam/equipment"))
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as EquipmentResponse | null;
        if (!r.ok || !data?.ok) throw new Error(`equipment: HTTP ${r.status}`);
        return Array.isArray(data.equipment) ? data.equipment : [];
      })
      .then((rows) => {
        if (cancelled) return;
        setEquipment(rows);
        const stored = selectedEquipmentId();
        const selected = rows.find((row) => row.id === stored) ?? rows[0];
        if (selected?.id) {
          setRegion(selected.site);
          setEquipmentId(String(selected.id));
          setSelectedEquipmentId(selected.id);
        }
      })
      .catch(() => {
        if (!cancelled) setEquipment([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function onRegionChange(value: string) {
    setRegion(value);
    const selected = equipment.find((row) => row.site === value);
    if (selected?.id) {
      setEquipmentId(String(selected.id));
      setSelectedEquipmentId(selected.id);
    } else {
      setEquipmentId("");
    }
  }

  function onEquipmentChange(value: string) {
    setEquipmentId(value);
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) setSelectedEquipmentId(id);
  }

  async function refreshScanPrivilege(): Promise<boolean> {
    try {
      const r = await fetch(apiUrl("/api/admin/iobeam/auth/current-account"), {
        cache: "no-store",
        headers: scanAuthHeaders(),
      });
      const data = (await r.json().catch(() => null)) as CurrentAccountResponse | null;
      if (!r.ok || !data?.ok) {
        throw new Error(data?.error || `current account: HTTP ${r.status}`);
      }
      const role = typeof data.user?.role === "number" ? data.user.role : Number(data.user?.role ?? 0);
      if (!data.registered || data.session_expired || !data.user?.is_active || role < 1) {
        dispatch(streamErrored(t("scan.permission.required")));
        return false;
      }
      return true;
    } catch (e: any) {
      dispatch(streamErrored(e?.message ?? String(e)));
      return false;
    }
  }

  useEffect(() => {
    const completedNow = phase === "completed" && prevPhaseRef.current !== "completed";
    prevPhaseRef.current = phase;
    if (completedNow && roiState.imageDataUrl && roiState.selection) {
      clearBitmapSelectionCache();
    }
    if (completedNow && infiniteScanActiveRef.current) {
      const entry = infiniteScanRef.current;
      if (entry) {
        // A healthy live stream only ends on Stop. If it keeps ending right
        // after it starts (rejected request, service fault), restarting forever
        // re-initialises the canvas and its contrast on every cycle. Give up
        // after a few automatic restarts in a short window and say why.
        const now = Date.now();
        autoRestartTimesRef.current = [...autoRestartTimesRef.current.filter((t0) => now - t0 < 5000), now];
        console.warn("[scan] live stream ended without Stop; automatic restart",
          { kind: entry.kind, restartsIn5s: autoRestartTimesRef.current.length,
            regions: entry.req.parallel_rois?.length ?? (entry.req.roi ? 1 : 0) });
        if (autoRestartTimesRef.current.length > 3) {
          autoRestartTimesRef.current = [];
          clearInfiniteScanState();
          dispatch(streamErrored(
            "Live scan stopped: the stream kept ending right after it started. Check the scan service log."));
          return;
        }
        clearBitmapSelectionCache();
        startInfiniteScanRun(entry, true);
        return;
      }
    }
    if (phase === "error" || phase === "idle") {
      clearInfiniteScanState();
      if (phase === "error") regionScanQueueRef.current = [];
    }
  }, [clearInfiniteScanState, dispatch, phase, roiState.imageDataUrl, roiSelectionKey, startInfiniteScanRun, startRegionScanEntry]);

  useEffect(() => {
    if (phase === "error") void latestScanQueue().then(setPendingQueue).catch(() => {});
  }, [phase]);

  useEffect(() => {
    if (phase === "error") pendingStopClearRef.current = null;
    if (phase !== "idle" || pendingStopClearRef.current === null) return;
    const clearKind = pendingStopClearRef.current;
    pendingStopClearRef.current = null;
    if (clearKind === "raster") dispatch(resetRaster({ resolution: raster.resolution }));
    else dispatch(resetVector());
  }, [dispatch, phase, raster.resolution]);

  useEffect(() => {
    if (!pendingZoomRestart || (phase !== "idle" && phase !== "error")) return;
    if (phase === "idle" && disabled && !zoomDisabled) return;
    setPendingZoomRestart(null);
    if (phase === "error" || zoomDisabled) return;
    if (pendingZoomRestart === "infinite") void startInfiniteRequest();
    else void startRunRequest();
  }, [disabled, pendingZoomRestart, phase, zoomDisabled]);

  useEffect(() => {
    clearInfiniteScanState();
    regionScanQueueRef.current = [];
  }, [clearInfiniteScanState, roiSelectionKey, kind]);

  useEffect(() => {
    return () => {
      if (zoomRestartTimerRef.current !== null) window.clearTimeout(zoomRestartTimerRef.current);
      clearInfiniteScanState();
    };
  }, [clearInfiniteScanState]);

  const validatedActions = (
    <>
      <span className="scan-action-with-help">
        <button
          type="button"
          className="btn"
          disabled={runDisabled || vectorGrayFilterActive || targetGraySelection !== null}
          onClick={onRunValidated}
          title={t("scan.runValidated.title")}
        >
          <Icon name="check" tone="success" />
          {t("scan.runValidated")}
        </button>
        <RunValidatedHelp />
      </span>
      <button type="button" className="btn btn--ghost" disabled={runDisabled} onClick={onClear}>
        <Icon name="x" tone="danger" />
        {t("scan.clear")}
      </button>
    </>
  );

  return (
    <div className="button-row">
      {firstRowContent}
      <div className="scan-equipment-selectors">
        <label className="scan-equipment-field">
          <span>{t("scan.region.label")}</span>
          <select
            className="select"
            value={region}
            disabled={controlsDisabled || availableRegions.length === 0}
            onChange={(event) => onRegionChange(event.target.value)}
            title={t("scan.region.title")}
          >
            {availableRegions.length === 0 ? (
              <option value="">{t("scan.region.empty")}</option>
            ) : (
              availableRegions.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="scan-equipment-field">
          <span>{t("scan.equipment.label")}</span>
          <select
            className="select"
            value={equipmentId}
            disabled={controlsDisabled || regionEquipment.length === 0}
            onChange={(event) => onEquipmentChange(event.target.value)}
            title={t("scan.equipment.title")}
          >
            {regionEquipment.length === 0 ? (
              <option value="">{t("scan.equipment.empty")}</option>
            ) : (
              regionEquipment.map((row) => (
                <option key={row.id ?? row.serial_number} value={String(row.id)}>
                  {row.name}
                </option>
              ))
            )}
          </select>
        </label>
      </div>
      <div className="scan-preview-zoom-row">
          <label
            className={`checkbox vacuum-switch app-switch scan-preview-toggle${preview ? " scan-preview-toggle--active" : ""}`}
            title={t("scan.preview.title")}
          >
        <input
          type="checkbox"
          checked={preview}
          disabled={controlsDisabled || kind === "roi"}
          onChange={(event) => dispatch(setPreview(event.target.checked))}
        />
        <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
          {preview && <Icon name="alertTriangle" tone="warn" />}
          <span>{t("scan.preview")}</span>
          </label>
          <HelpPopover title={t("scan.preview.help.title")} ariaLabel={t("scan.preview.help.aria")}>
            {t("scan.preview.help.body")}
          </HelpPopover>
          {(kind === "raster" || kind === "vector") && (
            <label className="scan-equipment-field scan-zoom-field">
              <span className="scan-zoom-label"><Icon name="zoomIn" />{t("scan.zoom")}</span>
              <NumberStepperInput
                value={roiState.scan_zoom}
                disabled={zoomDisabled || settingsSaving || backendRestarting}
                min={1}
                max={20000}
                step={1}
                inputMode="numeric"
                ariaLabel={t("scan.zoom")}
                warning={zoomError}
                onValueChange={onZoomChange}
              />
            </label>
          )}
      </div>
          {kind === "vector" && (
            <span
              className="scan-busy"
          data-visible={busy ? "true" : "false"}
          aria-hidden={!busy}
          title={t("scan.busy.title")}
        >
          <LoadingSpinner inline size={20} ariaLabel={t("scan.busy.title")} />
        </span>
      )}
      {(kind === "raster" || kind === "vector") && <TransformCard />}
      {(kind === "raster" || kind === "vector") && (
        <div className="card scan-roi-controls-card">
          <div className="card__header">
            <span className="card__title"><Icon name="target" />{t("tabs.roi")}</span>
            <button
              type="button"
              className="card__collapse-btn"
              aria-expanded={!roiControlsCollapsed}
              aria-label={`${t("tabs.roi")}: ${t(roiControlsCollapsed ? "controls.expand" : "controls.collapse")}`}
              onClick={() => {
                const nextCollapsed = !roiControlsCollapsed;
                setROIControlsCollapsed(nextCollapsed);
                dispatch(setROIScanEnabled(!nextCollapsed));
              }}
            >
              <Icon name="chevronDown" />
            </button>
          </div>
          <div className="card__body scan-region-controls" hidden={roiControlsCollapsed}>
            <label
              className={`checkbox vacuum-switch app-switch scan-roi-toggle${roiState.roi_scan_enabled ? " scan-roi-toggle--active" : ""}`}
              title={t("scan.roi.edit")}
            >
              <input
                type="checkbox"
                checked={roiState.roi_scan_enabled}
                disabled={controlsDisabled}
                onChange={(event) => dispatch(setROIScanEnabled(event.target.checked))}
              />
              <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
              <span>{t("scan.roi.edit")}</span>
            </label>
            <label className="checkbox vacuum-switch app-switch scan-parallel-toggle" title={t("scan.parallel.title")}>
              <input
                type="checkbox"
                checked={parallelRegions && canParallelRegions}
                disabled={controlsDisabled || !canParallelRegions}
                onChange={(event) => setParallelRegions(event.target.checked)}
              />
              <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
              <span>{t("scan.parallel")}</span>
            </label>
          </div>
        </div>
      )}

      <div className={`scan-primary-controls${kind === "raster" ? " scan-primary-controls--raster" : ""}`}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={runDisabled || kind === "roi"}
          onClick={onRun}
          title={t("scan.run.title.start")}
        >
          <Icon name="play" tone="success" />
          {t("scan.run")}
        </button>
        {!runDisabled && kind !== "roi" && pendingQueue && pendingQueue.status === "interrupted" && pendingQueue.next_index >= 0 && pendingQueue.next_index < pendingQueue.total && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void resumeScanQueue()}
            title={t("scan.resumeQueue.title")}
          >
            {t("scan.resume")}
          </button>
        )}
        <button
          type="button"
          className="btn btn--stop"
          disabled={stopDisabled}
          onClick={onStop}
          title={t(closing ? "scan.stopping" : "scan.stop.title")}
        >
          <Icon name="hand" />
          {t(closing ? "scan.stopping" : "scan.stop")}
        </button>
        {(kind === "raster" || kind === "vector") && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={infiniteDisabled}
            onClick={onInfinite}
            title={kind === "vector" ? t("scan.infinite.title.vector") : t("scan.infinite.title")}
            aria-pressed={infiniteScanActive}
          >
            <Icon name="infinity" tone="accent" />
            {t("scan.infinite")}
          </button>
        )}
      </div>

      {grayRuleError && <div className="scan-inline-error" role="alert">{grayRuleError}</div>}
      {kind !== "raster" && <span className="spacer" />}

      {validatedActionsHost ? createPortal(validatedActions, validatedActionsHost) : validatedActions}
      {(kind === "raster" || kind === "vector") && (
        <ScanTakeoverEstimate kind={kind} />
      )}
      {visibleError && (
        <div className="scan-inline-error" role="alert" aria-live="assertive">
          <Icon name="alertTriangle" tone="danger" />
          <span>{visibleError}</span>
        </div>
      )}
    </div>
  );
}
