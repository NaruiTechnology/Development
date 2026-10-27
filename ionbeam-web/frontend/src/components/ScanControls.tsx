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
  setROIScanEnabled,
  setScanZoom,
  streamErrored,
  streamReset,
  type ScanKind,
} from "../store/scanSlice";
import {
  resetRaster,
  resetVector,
} from "../store/imageSlice";
import { registerScanActionStop } from "../hooks/scanActionRegistry";
import { useScanStream } from "../hooks/useScanStream";
import {
  clearBitmapSelectionCache,
  bitmapImageFrame,
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
      simulationBitmapInfo?: { width: number; height: number } | null;
      hasSimulationBitmap?: boolean;
      initialFrame: Uint16Array | null;
    };
import type { ROIState } from "../store/scanSlice";
import { effectiveScanRegions } from "../lib/scanRegions";
import { worldSelectionToDacROI } from "../lib/roiDac";

type RegionScanEntry =
  | {
      kind: "raster";
      req: RasterRequest;
      displayROI: ROIRequest | null;
      displayROIs?: ROIRequest[] | null;
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
      simulationBitmapInfo?: { width: number; height: number } | null;
      hasSimulationBitmap?: boolean;
      initialFrame: Uint16Array | null;
    };

function combineRasterRegions(requests: RasterRequest[]): RasterRequest {
  const rois = requests.map((request) => request.roi);
  if (rois.some((roi) => roi === null || roi === undefined)) {
    throw new Error("Every parallel scan area needs valid DAC bounds");
  }
  const bitmaps = requests.map((request) => request.simulation_bitmap);
  return {
    ...requests[0],
    roi: null,
    parallel_rois: rois as ROIRequest[],
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
  const rois = requests.map((request) => request.roi);
  if (rois.some((roi) => roi === null || roi === undefined)) {
    throw new Error("Every parallel scan area needs valid DAC bounds");
  }
  if (requests.every((request) => request.pattern === "custom" && request.points)) {
    const points = interleaveParallelPoints(requests.map((request) => request.points ?? []));
    if (points.length > 1_000_000) {
      throw new Error("Parallel vector path exceeds the 1,000,000 point service limit");
    }
    return {
      ...requests[0],
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
    roi: null,
    parallel_rois: rois as ROIRequest[],
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
  vectorGrayScaleSelection = null,
  vectorGrayScaleSkipped = null,
  onScanRunStart,
  validatedActionsHost = null,
  firstRowContent,
}: {
  kind: ScanKind;
  disabled?: boolean;
  scanActive?: boolean;
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
  const [roiControlsCollapsed, setROIControlsCollapsed] = useState(false);
  const [pendingQueue, setPendingQueue] = useState<ScanQueueSummary | null>(null);
  useEffect(() => {
    void latestScanQueue().then(setPendingQueue).catch(() => {});
  }, []);
  const canParallelRegions = roiState.scan_regions.length > 1;
  useEffect(() => {
    if (!canParallelRegions) setParallelRegions(false);
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
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);
  const [region, setRegion] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const availableRegions = SITE_OPTIONS.filter((option) =>
    equipment.some((row) => row.site === option.value),
  );
  const regionEquipment = equipment.filter((row) => row.site === region);
  const isProduction = defaults?.is_production !== false;
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
    : [selectedTargetGray, selectedTargetGray] as [number, number];
  const scanGrayScaleSelection = targetGraySelection ?? activeVectorGrayScaleSelection;
  const scanGrayScaleSkipped = selectedTargetGray !== null
    ? vectorGrayScaleSkipped ?? false
    : activeVectorGrayScaleSkipped;
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
      return vectorRequestWithAdaptiveGrayFeedback(
        { ...vector, roi: null },
        requestROI,
        {
          grayScaleSelection: scanGrayScaleSelection,
          grayScaleSkipped: scanGrayScaleSkipped,
        }
      );
    }
    return vectorRequestWithBitmapSelection(
      { ...vector, roi: null },
      requestROI,
      {
        isProduction,
        allowBitmapSimulation,
        grayScaleSelection: scanGrayScaleSelection,
        grayScaleSkipped: scanGrayScaleSkipped,
      }
    );
  }, [
    allowBitmapSimulation,
    isProduction,
    roi,
    roiState,
    scanGrayScaleSelection,
    scanGrayScaleSkipped,
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
  const stopAvailable = streaming || closing || infiniteScanActive;
  const controlsDisabled = disabled || scanActive || settingsSaving || backendRestarting;

  const clearInfiniteScanState = useCallback(() => {
    regionScanRepeatRef.current = [];
    infiniteScanRef.current = null;
    infiniteScanActiveRef.current = false;
    setInfiniteScanActive((current) => current ? false : current);
  }, []);

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
      initialFrame: Uint16Array | null = null,
      onComplete?: () => void,
      simulationBitmapInfo?: { width: number; height: number } | null,
      hasSimulationBitmap?: boolean,
    ) => {
    stream.startVector({ ...req, preview }, {
      preserveFrame,
      displayROI,
      displayROIs,
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
        simulationBitmapInfo: entry.simulationBitmapInfo,
        hasSimulationBitmap: entry.hasSimulationBitmap,
        initialFrame: entry.initialFrame,
        onComplete,
      });
    } else {
      startVectorRun(
        entry.req, preserveFrame, entry.displayROI, entry.displayROIs,
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
    }
    regionScanQueueRef.current = rest;
    startRegionScanEntry(first, preserveFirst);
  }, [startRegionScanEntry]);

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
      const entries = await loadScanQueue(pendingQueue);
      const remaining = entries.slice(pendingQueue.next_index);
      if (!remaining.length || remaining[0].kind !== kind) return;
      startRegionScanSequence(remaining.map((entry) => ({ ...entry, initialFrame: null })) as RegionScanEntry[], true);
      setPendingQueue({ ...pendingQueue, status: "running" });
    } catch (err) {
      dispatch(streamErrored(err instanceof Error ? err.message : String(err)));
    }
  }

  async function startRunRequest(repeatRegions = false) {
    if (disabled) return;
    const allowed = await refreshScanPrivilege();
    if (!allowed) return;
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
        const initialFrames = isProduction
          ? regions.map(() => roiAreaDefined && rasterImageFilled > 0
            ? resizeImageFrame(rasterImageFrame, rasterImageResolution, raster.resolution)
            : null)
          : await Promise.all(regions.map((region, index) => bitmapImageFrame(roiState, raster.resolution, {
              sourceSelection: region,
              displayROI: displayRegions[index] ?? null,
            })));
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
        const scanEntries = parallelRegions && requests.length > 1
          ? [{ kind: "raster" as const, req: combineRasterRegions(requests), displayROI: null, displayROIs: displayRegions as ROIRequest[], initialFrame: initialFrames[0] ?? null }]
          : entries;
        startRegionScanSequence(await persistScanSequence(scanEntries, repeatRegions), isProduction && roiAreaDefined, repeatRegions);
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
        const initialFrames = isProduction
          ? regions.map(() => roiAreaDefined && vectorImageFilled > 0
            ? resizeImageFrame(vectorImageFrame, vectorImageEdge, vector.vector_resolution)
            : null)
          : await Promise.all(regions.map((region, index) => bitmapImageFrame(roiState, vector.vector_resolution, {
              sourceSelection: region,
              displayROI: displayRegions[index] ?? null,
            })));
        const requests = await Promise.all(regions.map((region) => buildVectorRequest(region)));
        requests.forEach((req) => logVectorRequestContext("stream", req, resolveVectorBranch(req)));
        const entries = requests.map((req, index) => ({
          kind: "vector" as const,
          req,
          scanType: resolveVectorScanType(req),
          displayROI: displayRegions[index] ?? null,
          initialFrame: initialFrames[index] ?? null,
        }));
        onScanRunStart?.(entries[0]?.scanType ?? ScanType.VECTOR);
        const scanEntries = parallelRegions && requests.length > 1
          ? [{
              kind: "vector" as const,
              req: combineVectorRegions(requests),
              scanType: entries[0].scanType,
              displayROI: null,
              displayROIs: displayRegions as ROIRequest[],
              initialFrame: initialFrames[0] ?? null,
            }]
          : entries;
        startRegionScanSequence(await persistScanSequence(scanEntries, repeatRegions), isProduction && roiAreaDefined, repeatRegions);
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    }
  }

  async function startInfiniteRequest() {
    if ((kind !== "raster" && kind !== "vector") || disabled || infiniteScanActiveRef.current) return;
    if (roiState.scan_regions.length > 1) {
      await startRunRequest(true);
      return;
    }
    const allowed = await refreshScanPrivilege();
    if (!allowed) return;
    try {
      const regions = effectiveScanRegions(roiState.scan_regions, roiState.scan_zoom, roiState);
      const activeIndex = roiState.active_scan_region ?? 0;
      const region = regions[Math.min(activeIndex, regions.length - 1)] ?? null;
      const selectedRegion = roiState.scan_regions[Math.min(activeIndex, roiState.scan_regions.length - 1)] ?? null;
      const displayROI = selectedRegion ? worldSelectionToDacROI(selectedRegion, roiState) : null;
      const roiAreaDefined = roiState.scan_regions.length > 0 || roiState.selection !== null;
      let entry: InfiniteScanEntry;
      if (kind === "raster") {
        const initialFrame = isProduction
          ? roiAreaDefined && rasterImageFilled > 0
            ? resizeImageFrame(rasterImageFrame, rasterImageResolution, raster.resolution)
            : null
          : await bitmapImageFrame(roiState, raster.resolution, {
              sourceSelection: region,
              displayROI,
            });
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
        entry = { kind: "raster", req: { ...req, preview }, displayROI, initialFrame };
      } else {
        const initialFrame = isProduction
          ? roiAreaDefined && vectorImageFilled > 0
            ? resizeImageFrame(vectorImageFrame, vectorImageEdge, vector.vector_resolution)
            : null
          : await bitmapImageFrame(roiState, vector.vector_resolution, {
              sourceSelection: region,
              displayROI,
            });
        const req = await buildVectorRequest(region);
        logVectorRequestContext(
          "stream",
          req,
          resolveVectorBranch(req),
        );
        entry = {
          kind: "vector",
          req: { ...req, preview },
          scanType: resolveVectorScanType(req),
          displayROI,
          initialFrame,
        };
      }
      infiniteScanRef.current = entry;
      infiniteScanActiveRef.current = true;
      setInfiniteScanActive(true);
      startInfiniteScanRun(entry, isProduction || entry.initialFrame === null);
    } catch (e: any) {
      clearInfiniteScanState();
      dispatch(streamErrored(e?.message ?? String(e)));
    }
  }

  function onStop() {
    if (!stopAvailable) return;
    // Like OBI, stopping a live session leaves the last image on the canvas:
    // Infinite (a single live session until Stop).
    // Only single runs clear it.
    const stoppingLiveScan = infiniteScanActiveRef.current;
    clearInfiniteScanState();
    regionScanQueueRef.current = [];
    stream.stop();
    if (stoppingLiveScan) return;
    // A loaded simulation image is also the scan canvas's initial frame.
    // Keep it visible when Stop cancels a single run; resetting here used to
    // erase the source image along with the partial scan result.
    if (roiState.imageDataUrl) return;
    if (kind === "raster") dispatch(resetRaster({ resolution: raster.resolution }));
    else dispatch(resetVector());
  }

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
        const runRequests = parallelRegions && requests.length > 1
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
        const runRequests = parallelRegions && requests.length > 1
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
    runStarting;
  const stopDisabled = !stopAvailable;
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
    clearInfiniteScanState();
    regionScanQueueRef.current = [];
  }, [clearInfiniteScanState, roiSelectionKey, kind]);

  useEffect(() => {
    return () => {
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
            <span className="card__title">{t("tabs.roi")}</span>
            <button
              type="button"
              className="card__collapse-btn"
              aria-expanded={!roiControlsCollapsed}
              aria-label={`${t("tabs.roi")}: ${t(roiControlsCollapsed ? "controls.expand" : "controls.collapse")}`}
              onClick={() => {
                const nextCollapsed = !roiControlsCollapsed;
                setROIControlsCollapsed(nextCollapsed);
                dispatch(setROIScanEnabled(!nextCollapsed));
                if (nextCollapsed) setParallelRegions(false);
              }}
            >
              <Icon name="chevronDown" />
            </button>
          </div>
          <div className="card__body scan-region-controls" hidden={roiControlsCollapsed}>
            <label className="scan-equipment-field scan-zoom-field">
              <span>{t("scan.zoom")}</span>
              <NumberStepperInput
                value={roiState.scan_zoom}
                disabled={controlsDisabled}
                min={1}
                max={1000}
                step={1}
                inputMode="numeric"
                ariaLabel={t("scan.zoom")}
                title={t("scan.zoom.title")}
                onValueChange={(value) => dispatch(setScanZoom(Number(value)))}
              />
            </label>
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
        {pendingQueue && pendingQueue.status !== "running" && pendingQueue.next_index < pendingQueue.total && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={runDisabled || kind === "roi"}
            onClick={() => void resumeScanQueue()}
            title={t("scan.resumeQueue.title")}
          >
            {t("scan.resumeQueue")} ({pendingQueue.next_index + 1}/{pendingQueue.total})
          </button>
        )}
        <button
          type="button"
          className="btn btn--stop"
          disabled={stopDisabled}
          onClick={onStop}
          title={t("scan.stop.title")}
        >
          <Icon name="square" tone="danger" />
          {t("scan.stop")}
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
