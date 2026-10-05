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
  streamErrored,
  streamReset,
  updateROI,
  type ScanKind,
} from "../store/scanSlice";
import {
  resetRaster,
  resetVector,
  setRetainVectorFeedbackOnComplete,
} from "../store/imageSlice";
import { registerScanActionStop } from "../hooks/scanActionRegistry";
import { useScanStream } from "../hooks/useScanStream";
import {
  clearBitmapSelectionCache,
  rasterRequestWithBitmapSelection,
  vectorRequestWithAdaptiveGrayFeedback,
  vectorRequestWithBitmapSelection,
  vectorRequestWithROIGrayScaleAction,
} from "../lib/bitmapVector";
import { useTranslation } from "../i18n";
import { displayScanError } from "../lib/scanError";
import { Icon } from "./Icon";
import { TransformCard } from "./TransformCard";
import { LoadingSpinner } from "./LoadingSpinner";
import { ROIActionWedges } from "./ROIActionWedges";
import { RunValidatedHelp } from "./RunValidatedHelp";
import { NumberStepperInput } from "./NumberStepperField";
import { selectedEquipmentId, setSelectedEquipmentId } from "../lib/adminActivity";
import { scanAuthHeaders } from "../lib/authIdentity";
import { SITE_OPTIONS } from "../lib/sites";
import type { RasterRequest, VectorRequest } from "../types/api";
import { ScanType } from "../types/scanType";

type InfiniteScanEntry =
  | { kind: "raster"; req: RasterRequest }
  | { kind: "vector"; req: VectorRequest; scanType: ScanType };
import type { ROIState } from "../store/scanSlice";
import {
  repeatCountdownDisplay,
  shouldClearROIFeedbackBeforeRepeat,
  shouldRetainROIFeedbackOnComplete,
} from "../lib/scanRepeat";

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

export function ScanControls({
  kind,
  disabled = false,
  scanActive = false,
  roiAction = false,
  repeat,
  onRepeatChange,
  showRepeatControl = true,
  vectorGrayScaleSelection = null,
  vectorGrayScaleSkipped = null,
  onActionRunStart,
  onScanRunStart,
  validatedActionsHost = null,
  firstRowContent,
}: {
  kind: ScanKind;
  disabled?: boolean;
  scanActive?: boolean;
  roiAction?: boolean;
  repeat: number;
  onRepeatChange: (next: number) => void;
  showRepeatControl?: boolean;
  vectorGrayScaleSelection?: [number, number] | null;
  vectorGrayScaleSkipped?: boolean | null;
  onActionRunStart?: () => void;
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
  const vector = useAppSelector((s) => s.scan.vector);
  const preview = useAppSelector((s) => s.scan.preview);
  const roiState = useAppSelector((s) => s.scan.roi);
  const defaults = useAppSelector((s) => s.status.defaults);
  const sessionSimulation = useAppSelector((s) => s.status.sessionSimulation);
  const settingsSaving = useAppSelector((s) => s.settings.saving);
  const backendRestarting = useAppSelector((s) => s.settings.backendRestarting);
  const roiGrayScaleSelection = useAppSelector((s) => s.scan.roiGrayScaleSelection);
  const roiGrayScaleSkipped = useAppSelector((s) => s.scan.roiGrayScaleSkipped);
  const selectedBeam = defaults?.selected_beam;
  const roi = roiState.selection;
  const roiSelectionKey = roi
    ? `${roi.x_start}:${roi.x_end}:${roi.y_start}:${roi.y_end}`
    : "";
  const stream = useScanStream();
  const prevPhaseRef = useRef(phase);
  const actionLoopTimerRef = useRef<number | null>(null);
  const actionLoopRequestRef = useRef<{ req: VectorRequest; preview: boolean; scanType: ScanType } | null>(null);
  const actionLoopRemainingRef = useRef(0);
  const actionLoopIterationRef = useRef(0);
  const actionLoopActiveRef = useRef(false);
  const actionLoopCompletionPendingRef = useRef(false);
  // Infinite mode repeats one prepared request until Stop: a Raster frame or a
  // Vector scan (with the scan type its progress/feedback handling needs).
  const infiniteScanRef = useRef<InfiniteScanEntry | null>(null);
  const infiniteScanActiveRef = useRef(false);
  // Repeated ROI action scans need a longer settle window between runs
  // so blank/spot updates are fully reflected before the next loop starts.
  const actionLoopGapMs = 750;
  const [actionLoopIteration, setActionLoopIteration] = useState(0);
  const [actionLoopActive, setActionLoopActive] = useState(false);
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
  const scanGrayScaleSelection = roiAction ? roiGrayScaleSelection : activeVectorGrayScaleSelection;
  const scanGrayScaleSkipped = roiAction ? roiGrayScaleSkipped : activeVectorGrayScaleSkipped;
  const roiActionGrayFilterActive =
    roiAction &&
    roiGrayScaleSelection !== null &&
    roiGrayScaleSkipped !== null;
  const vectorGrayFilterActive =
    kind === "vector" &&
    activeVectorGrayScaleSelection !== null &&
    activeVectorGrayScaleSkipped !== null;

  const logVectorRequestContext = (source: "stream" | "validated", req: VectorRequest, branch: string) => {
    if (kind !== "vector") return;
    console.info("[scan/vector] build", {
      source,
      branch,
      vectorGrayScaleSelection: activeVectorGrayScaleSelection,
      vectorGrayScaleSkipped: activeVectorGrayScaleSkipped,
      roiGrayScaleSelection,
      roiGrayScaleSkipped,
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

  const buildVectorRequest = useCallback(async () => {
    console.info("[scan/vector] adaptive gate", {
      vectorPixelFallbackBlank,
      scanGrayScaleSelection,
      scanGrayScaleSkipped,
      isProduction,
      allowBitmapSimulation,
    });
    if (vectorPixelFallbackBlank && scanGrayScaleSelection !== null && scanGrayScaleSkipped !== null) {
      return vectorRequestWithAdaptiveGrayFeedback(
        { ...vector, roi: null },
        withoutPartialROISelection(roiState),
        {
          grayScaleSelection: scanGrayScaleSelection,
          grayScaleSkipped: scanGrayScaleSkipped,
        }
      );
    }
    return vectorRequestWithBitmapSelection(
      { ...vector, roi: null },
      withoutPartialROISelection(roiState),
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
  const stopAvailable = streaming || closing || actionLoopActive || infiniteScanActive;
  const controlsDisabled = disabled || scanActive || settingsSaving || backendRestarting;
  const roiEbeamDisabled = roiAction && selectedBeam === "ebeam";

  const clearActionLoopTimer = useCallback(() => {
    if (actionLoopTimerRef.current !== null) {
      window.clearTimeout(actionLoopTimerRef.current);
      actionLoopTimerRef.current = null;
    }
  }, []);

  const clearActionLoopState = useCallback(() => {
    clearActionLoopTimer();
    actionLoopRequestRef.current = null;
    actionLoopRemainingRef.current = 0;
    actionLoopIterationRef.current = 0;
    actionLoopActiveRef.current = false;
    actionLoopCompletionPendingRef.current = false;
    setActionLoopIteration((current) => current === 0 ? current : 0);
    setActionLoopActive((current) => current ? false : current);
  }, [clearActionLoopTimer]);

  const clearInfiniteScanState = useCallback(() => {
    infiniteScanRef.current = null;
    infiniteScanActiveRef.current = false;
    setInfiniteScanActive((current) => current ? false : current);
  }, []);

  // OBI's live scanner runs `capture_frame()` in a `while not abort` loop.
  // This UI has one WebSocket per frame, so starting the next frame from the
  // completed transition is the equivalent lifecycle: Stop closes the active
  // socket, which the service maps to RasterScanCommand.abort. Vector scans
  // use the same loop (each pass is one complete vector scan).
  const startInfiniteScanRun = useCallback((entry: InfiniteScanEntry, preserveFrame = false) => {
    if (entry.kind === "raster") {
      onScanRunStart?.(ScanType.RASTER);
      stream.startRaster(
        { ...entry.req, preview: entry.req.preview ?? preview },
        { preserveFrame },
      );
      return;
    }
    onScanRunStart?.(entry.scanType);
    stream.startVector({ ...entry.req, preview: entry.req.preview ?? preview });
  }, [onScanRunStart, preview, stream]);

  const startRepeatActionRun = useCallback(
    (entry: { req: VectorRequest; preview: boolean; scanType: ScanType }) => {
      actionLoopCompletionPendingRef.current = true;
      onScanRunStart?.(entry.scanType);
      stream.startVector({ ...entry.req, preview: entry.preview });
    },
    [onScanRunStart, stream]
  );

  const startActionLoop = useCallback((req: VectorRequest, scanType: ScanType) => {
    clearActionLoopState();
    actionLoopRequestRef.current = { req, preview, scanType };
    actionLoopRemainingRef.current = Math.max(0, Math.min(50, Math.trunc(repeat)));
    actionLoopIterationRef.current = actionLoopRemainingRef.current;
    actionLoopCompletionPendingRef.current = true;
    setActionLoopIteration(actionLoopIterationRef.current);
    actionLoopActiveRef.current = true;
    setActionLoopActive(true);
  }, [clearActionLoopState, preview, repeat]);

  const scheduleNextActionRun = useCallback(() => {
    clearActionLoopTimer();
    if (!actionLoopActiveRef.current || actionLoopRemainingRef.current <= 0) {
      return;
    }
    actionLoopTimerRef.current = window.setTimeout(() => {
      actionLoopTimerRef.current = null;
      if (!actionLoopActiveRef.current || actionLoopRemainingRef.current <= 0) {
        return;
      }
      const entry = actionLoopRequestRef.current;
      if (!entry) {
        return;
      }
      if (shouldClearROIFeedbackBeforeRepeat(entry.scanType, actionLoopRemainingRef.current)) {
        dispatch(resetVector());
        dispatch(updateROI({ scanImageDataUrl: null }));
      }
      dispatch(
        setRetainVectorFeedbackOnComplete(
          shouldRetainROIFeedbackOnComplete(entry.scanType, actionLoopRemainingRef.current)
        )
      );
      startRepeatActionRun(entry);
    }, actionLoopGapMs);
  }, [actionLoopGapMs, clearActionLoopTimer, dispatch, startRepeatActionRun]);

  async function onRun() {
    if (disabled || (kind === "roi" && !roiAction)) return;
    const allowed = await refreshScanPrivilege();
    if (!allowed) {
      return;
    }
    if (roiAction) {
      try {
        if (roiEbeamDisabled) {
          return;
        }
        const hasGrayFilter =
          scanGrayScaleSelection !== null && scanGrayScaleSkipped !== null;
        if (hasGrayFilter) {
          // Production must make the gray decision from the live 14-bit ADC,
          // not from the loaded ROI reference bitmap. Simulation keeps the
          // bitmap-derived custom point path because it has no physical ADC.
          const adaptiveProductionFilter = isProduction && vectorPixelFallbackBlank;
          const req = adaptiveProductionFilter
            ? await vectorRequestWithAdaptiveGrayFeedback(
                { ...vector, roi },
                roiState,
                {
                  grayScaleSelection: scanGrayScaleSelection,
                  grayScaleSkipped: scanGrayScaleSkipped,
                }
              )
            : await vectorRequestWithROIGrayScaleAction(
                { ...vector, roi },
                roiState,
                {
                  grayScaleSelection: scanGrayScaleSelection,
                  grayScaleSkipped: scanGrayScaleSkipped,
                }
              );
          const grayFilterScanType = adaptiveProductionFilter
            ? ScanType.VECTOR_ADAPTIVE_GRAN_FEED_BLANK
            : ScanType.CUSTOM_GRAY_FEEDBACK_BLANK;
          if (Math.trunc(repeat) > 1) {
            startActionLoop(req, grayFilterScanType);
            dispatch(setRetainVectorFeedbackOnComplete(false));
          } else {
            clearActionLoopState();
            dispatch(setRetainVectorFeedbackOnComplete(true));
          }
          dispatch(updateROI({ scanImageDataUrl: null }));
          onActionRunStart?.();
          onScanRunStart?.(grayFilterScanType);
          stream.startVector({ ...req, preview });
        } else {
          const req = await vectorRequestWithBitmapSelection(
            { ...vector, roi },
            roiState,
            {
              isProduction,
              allowBitmapSimulation,
              grayScaleSelection: null,
              grayScaleSkipped: null,
            }
          );
          clearActionLoopState();
          dispatch(updateROI({ scanImageDataUrl: null }));
          onActionRunStart?.();
          onScanRunStart?.(ScanType.VECTOR);
          stream.startVector({ ...req, preview });
        }
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
      return;
    }
    if (kind === "raster") {
      try {
        const req = await rasterRequestWithBitmapSelection(
          { ...raster, roi: null },
          withoutPartialROISelection(roiState),
          {
            isProduction,
            allowBitmapSimulation,
            grayScaleSelection: scanGrayScaleSelection,
            grayScaleSkipped: scanGrayScaleSkipped,
          }
        );
        onScanRunStart?.(ScanType.RASTER);
        stream.startRaster({ ...req, preview });
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    } else {
      try {
        const req = await buildVectorRequest();
        logVectorRequestContext(
          "stream",
          req,
          resolveVectorBranch(req),
        );
        const scanType = resolveVectorScanType(req);
        if (Math.trunc(repeat) > 1) {
          startActionLoop(req, scanType);
        } else {
          clearActionLoopState();
        }
        onScanRunStart?.(scanType);
        stream.startVector({ ...req, preview });
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    }
  }

  async function onInfinite() {
    if ((kind !== "raster" && kind !== "vector") || disabled || infiniteScanActiveRef.current) return;
    const allowed = await refreshScanPrivilege();
    if (!allowed) return;
    try {
      let entry: InfiniteScanEntry;
      if (kind === "raster") {
        const req = await rasterRequestWithBitmapSelection(
          { ...raster, roi: null },
          withoutPartialROISelection(roiState),
          {
            isProduction,
            allowBitmapSimulation,
            grayScaleSelection: scanGrayScaleSelection,
            grayScaleSkipped: scanGrayScaleSkipped,
          }
        );
        entry = { kind: "raster", req: { ...req, preview } };
      } else {
        const req = await buildVectorRequest();
        logVectorRequestContext(
          "stream",
          req,
          resolveVectorBranch(req),
        );
        entry = { kind: "vector", req: { ...req, preview }, scanType: resolveVectorScanType(req) };
        // Infinite replaces the finite Repeat loop.
        clearActionLoopState();
      }
      infiniteScanRef.current = entry;
      infiniteScanActiveRef.current = true;
      setInfiniteScanActive(true);
      startInfiniteScanRun(entry);
    } catch (e: any) {
      clearInfiniteScanState();
      dispatch(streamErrored(e?.message ?? String(e)));
    }
  }

  function onStop() {
    if (roiEbeamDisabled || !stopAvailable) return;
    clearActionLoopState();
    clearInfiniteScanState();
    stream.stop();
    if (roiAction && !roiActionGrayFilterActive) dispatch(resetVector());
    else if (kind === "raster") dispatch(resetRaster({ resolution: raster.resolution }));
    else dispatch(resetVector());
  }

  async function onRunValidated() {
    if (disabled || kind === "roi") return;
    const allowed = await refreshScanPrivilege();
    if (!allowed) {
      return;
    }
    if (kind === "raster") {
      try {
        const req = await rasterRequestWithBitmapSelection(
          { ...raster, roi },
          roiState,
          {
            isProduction,
            allowBitmapSimulation,
            grayScaleSelection: null,
            grayScaleSkipped: null,
          }
        );
        const promise = dispatch(runRasterValidated({
          ...req,
          preview,
          ...(sessionSimulation ? { simulation: sessionSimulation } : {}),
        }));
        const unregister = registerScanActionStop(() => {
          promise.abort();
          dispatch(streamReset());
        });
        promise.finally(unregister);
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    }
    else {
      try {
        const req = await buildVectorRequest();
        logVectorRequestContext(
          "validated",
          req,
          resolveVectorBranch(req),
        );
        const promise = dispatch(runVectorValidated({
          ...req,
          preview,
          ...(sessionSimulation ? { simulation: sessionSimulation } : {}),
        }));
        const unregister = registerScanActionStop(() => {
          promise.abort();
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

  const runDisabled =
    controlsDisabled ||
    roiEbeamDisabled ||
    streaming ||
    closing ||
    (roiAction && actionLoopActive);
  const stopDisabled = roiEbeamDisabled || !stopAvailable;
  const infiniteDisabled =
    (kind !== "raster" && kind !== "vector") || runDisabled || infiniteScanActive;
  const repeatDisplayCount = repeatCountdownDisplay(
    repeat,
    actionLoopIteration,
    actionLoopActive,
  );

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
    if (
      completedNow &&
      actionLoopActiveRef.current &&
      actionLoopCompletionPendingRef.current
    ) {
      actionLoopCompletionPendingRef.current = false;
      if (actionLoopRemainingRef.current > 0) {
        actionLoopRemainingRef.current -= 1;
        actionLoopIterationRef.current = actionLoopRemainingRef.current;
        setActionLoopIteration(actionLoopIterationRef.current);
      }
      if (actionLoopRemainingRef.current > 0) {
        clearBitmapSelectionCache();
        const scanType = actionLoopRequestRef.current?.scanType;
        if (
          scanType !== undefined &&
          shouldClearROIFeedbackBeforeRepeat(scanType, actionLoopRemainingRef.current)
        ) {
          dispatch(resetVector());
          dispatch(updateROI({ scanImageDataUrl: null }));
        }
        scheduleNextActionRun();
        return;
      }
      clearActionLoopState();
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
      clearActionLoopState();
      clearInfiniteScanState();
    }
  }, [clearActionLoopState, clearInfiniteScanState, dispatch, phase, roiState.imageDataUrl, roiSelectionKey, scheduleNextActionRun, startInfiniteScanRun]);

  useEffect(() => {
    clearActionLoopState();
    clearInfiniteScanState();
  }, [clearActionLoopState, clearInfiniteScanState, roiAction, roiSelectionKey, kind]);

  useEffect(() => {
    return () => {
      clearActionLoopState();
      clearInfiniteScanState();
    };
  }, [clearActionLoopState, clearInfiniteScanState]);

  if (roiAction) {
    const showRoiGrayControls = roiActionGrayFilterActive;
    return (
      <div className="button-row">
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
        <div className="scan-loop-controls__roi-wedges">
          <ROIActionWedges
            mode={showRoiGrayControls ? "vector" : "raster"}
            active={showRoiGrayControls}
            disabled={controlsDisabled || roiEbeamDisabled}
          />
        </div>
        <div className="scan-loop-controls">
          <div className="scan-loop-controls__preview">
            <label
              className={`checkbox vacuum-switch app-switch scan-preview-toggle${preview ? " scan-preview-toggle--active" : ""}`}
              title={t("scan.preview.title")}
            >
              <input
                type="checkbox"
                checked={preview}
                disabled={controlsDisabled || roiEbeamDisabled}
                onChange={(event) => dispatch(setPreview(event.target.checked))}
              />
              <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
              {preview && <Icon name="alertTriangle" tone="warn" />}
              <span>{t("scan.preview")}</span>
            </label>
            <span
              className="scan-busy"
              data-visible={busy ? "true" : "false"}
              aria-hidden={!busy}
              title={t("scan.busy.title")}
            >
              <LoadingSpinner inline size={20} ariaLabel={t("scan.busy.title")} />
            </span>
          </div>
          <div className="scan-loop-controls__buttons scan-loop-controls__buttons--roi">
            <button
              type="button"
              className="btn btn--primary"
              disabled={runDisabled}
              onClick={onRun}
              title={t("roi.actionRun.title")}
            >
              <Icon name="play" tone="success" />
              {t("roi.actionRun")}
            </button>
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
          </div>
          {showRepeatControl && showRoiGrayControls && (
            <div className="scan-loop-controls__footer">
              <RepeatControl
                repeat={repeat}
                displayCount={repeatDisplayCount}
                disabled={controlsDisabled || roiEbeamDisabled}
                onRepeatChange={onRepeatChange}
              />
            </div>
          )}
          {visibleError && (
            <div className="scan-inline-error" role="alert" aria-live="assertive">
              <Icon name="alertTriangle" tone="danger" />
              <span>{visibleError}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  const validatedActions = (
    <>
      <span className="scan-action-with-help">
        <button
          type="button"
          className="btn"
          disabled={runDisabled || kind === "roi" || vectorGrayFilterActive}
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
      {!roiAction && (kind === "raster" || kind === "vector") && <TransformCard />}

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
      {showRepeatControl && (
        <div className="button-row__repeat-footer">
          <RepeatControl
            repeat={repeat}
            displayCount={repeatDisplayCount}
            disabled={controlsDisabled}
            onRepeatChange={onRepeatChange}
          />
        </div>
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

function RepeatControl({
  repeat,
  displayCount,
  disabled,
  onRepeatChange,
}: {
  repeat: number;
  displayCount?: number;
  disabled: boolean;
  onRepeatChange: (next: number) => void;
}) {
  const { t } = useTranslation();
  const count = displayCount ?? repeat;
  return (
    <div className="scan-loop-counter-wrap scan-loop-counter-wrap--shared scan-loop-counter-wrap--controls" title={t("scan.repeat.title")}>
      <span className="scan-loop-counter__label">{t("scan.repeat")}</span>
      <span className="scan-loop-counter scan-loop-counter--compact" aria-hidden="true">
        {count}
      </span>
      <label className="scan-repeat-field scan-repeat-field--shared">
        <NumberStepperInput
          value={repeat}
          min={1}
          max={50}
          step={1}
          inputMode="numeric"
          disabled={disabled}
          onValueChange={(next) => {
            const raw = Number(next);
            const value = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.trunc(raw))) : 1;
            onRepeatChange(value);
          }}
        />
      </label>
    </div>
  );
}
