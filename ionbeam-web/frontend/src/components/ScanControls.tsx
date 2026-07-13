/**
 * Run / Stop button group, plus a "Run validated" button that
 * uses the blocking REST endpoint (returns a ScanResult with timing,
 * validation report, and CSV path).
 */
import { useCallback, useEffect, useRef, useState } from "react";

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
import { Icon } from "./Icon";
import { ROIGrayActionVectorWedges } from "./ROIGrayActionVectorWedges";
import { RunValidatedHelp } from "./RunValidatedHelp";
import { NumberStepperInput } from "./NumberStepperField";
import { selectedEquipmentId, setSelectedEquipmentId } from "../lib/adminActivity";
import { scanAuthHeaders } from "../lib/authIdentity";
import type { VectorRequest } from "../types/api";
import { ScanType } from "../types/scanType";
import type { ROIState } from "../store/scanSlice";
import {
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
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const phase = useAppSelector((s) => s.scan.phase);
  const raster = useAppSelector((s) => s.scan.raster);
  const vector = useAppSelector((s) => s.scan.vector);
  const preview = useAppSelector((s) => s.scan.preview);
  const roiState = useAppSelector((s) => s.scan.roi);
  const defaults = useAppSelector((s) => s.status.defaults);
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
  // Repeated ROI action scans need a longer settle window between runs
  // so blank/spot updates are fully reflected before the next loop starts.
  const actionLoopGapMs = 750;
  const [actionLoopIteration, setActionLoopIteration] = useState(0);
  const [actionLoopActive, setActionLoopActive] = useState(false);
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);
  const [equipmentId, setEquipmentId] = useState("");
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
          const req = await vectorRequestWithROIGrayScaleAction(
            { ...vector, roi },
            roiState,
            {
              grayScaleSelection: scanGrayScaleSelection,
              grayScaleSkipped: scanGrayScaleSkipped,
            }
          );
          if (Math.trunc(repeat) > 1) {
            startActionLoop(req, ScanType.CUSTOM_GRAY_FEEDBACK_BLANK);
            dispatch(setRetainVectorFeedbackOnComplete(false));
          } else {
            clearActionLoopState();
            dispatch(setRetainVectorFeedbackOnComplete(true));
          }
          onActionRunStart?.();
          onScanRunStart?.(ScanType.CUSTOM_GRAY_FEEDBACK_BLANK);
          stream.startVector({ ...req, preview });
        } else {
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
          clearActionLoopState();
          onActionRunStart?.();
          onScanRunStart?.(ScanType.CUSTOM_RASTER);
          stream.startRaster({ ...req, preview });
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

  function onStop() {
    if (disabled || roiEbeamDisabled) return;
    clearActionLoopState();
    stream.stop();
    if (roiAction && !roiActionGrayFilterActive) dispatch(resetRaster({ resolution: raster.resolution }));
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
        const promise = dispatch(runRasterValidated({ ...req, preview }));
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
        const promise = dispatch(runVectorValidated({ ...req, preview }));
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
  const stopDisabled = disabled || roiEbeamDisabled || !(streaming || closing || actionLoopActive);
  const loopDisplayOffset =
    kind === "vector" && (actionLoopActive || streaming || closing)
      ? 1
      : 0;
  const repeatDisplayCount =
    actionLoopActive || streaming || closing
      ? Math.max(0, actionLoopIteration - loopDisplayOffset)
      : repeat;

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
    if (phase === "error" || phase === "idle") {
      clearActionLoopState();
    }
  }, [clearActionLoopState, dispatch, phase, roiState.imageDataUrl, roiSelectionKey, scheduleNextActionRun]);

  useEffect(() => {
    clearActionLoopState();
  }, [clearActionLoopState, roiAction, roiSelectionKey, kind]);

  useEffect(() => {
    return () => {
      clearActionLoopState();
    };
  }, [clearActionLoopState]);

  if (roiAction) {
    const showRoiGrayControls = roiActionGrayFilterActive;
    return (
      <div className="button-row">
        <label className="scan-equipment-field">
          <span>{t("scan.equipment.label")}</span>
          <select
            className="select"
            value={equipmentId}
            disabled={controlsDisabled || equipment.length === 0}
            onChange={(event) => onEquipmentChange(event.target.value)}
            title={t("scan.equipment.title")}
          >
            {equipment.length === 0 ? (
              <option value="">{t("scan.equipment.empty")}</option>
            ) : (
              equipment.map((row) => (
                <option key={row.id ?? row.serial_number} value={String(row.id)}>
                  {row.name}
                </option>
            ))
          )}
          </select>
        </label>
        {showRoiGrayControls && (
          <div className="scan-loop-controls__roi-wedges">
            <ROIGrayActionVectorWedges
              active={showRoiGrayControls}
              disabled={controlsDisabled || roiEbeamDisabled}
            />
          </div>
        )}
        <div className="scan-loop-controls">
          <div className="scan-loop-controls__preview">
            <label
              className={`checkbox scan-preview-toggle${preview ? " scan-preview-toggle--active" : ""}`}
              title={t("scan.preview.title")}
            >
              <input
                type="checkbox"
                checked={preview}
                disabled={controlsDisabled || roiEbeamDisabled}
                onChange={(event) => dispatch(setPreview(event.target.checked))}
              />
              {preview && <Icon name="alertTriangle" tone="warn" />}
              <span>{t("scan.preview")}</span>
            </label>
            <span
              className="scan-busy"
              data-visible={busy ? "true" : "false"}
              aria-hidden={!busy}
              title={t("scan.busy.title")}
            >
              <span className="scan-busy__spinner" />
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
              className="btn btn--danger"
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
        </div>
      </div>
    );
  }

  return (
    <div className="button-row">
      <label className="scan-equipment-field">
        <span>{t("scan.equipment.label")}</span>
        <select
          className="select"
          value={equipmentId}
          disabled={controlsDisabled || equipment.length === 0}
          onChange={(event) => onEquipmentChange(event.target.value)}
          title={t("scan.equipment.title")}
        >
          {equipment.length === 0 ? (
            <option value="">{t("scan.equipment.empty")}</option>
          ) : (
            equipment.map((row) => (
              <option key={row.id ?? row.serial_number} value={String(row.id)}>
                {row.name}
              </option>
            ))
          )}
        </select>
      </label>
          <label
            className={`checkbox scan-preview-toggle${preview ? " scan-preview-toggle--active" : ""}`}
            title={t("scan.preview.title")}
          >
        <input
          type="checkbox"
          checked={preview}
          disabled={controlsDisabled || kind === "roi"}
          onChange={(event) => dispatch(setPreview(event.target.checked))}
        />
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
          <span className="scan-busy__spinner" />
        </span>
      )}
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
        className="btn btn--danger"
        disabled={stopDisabled}
        onClick={onStop}
        title={t("scan.stop.title")}
      >
        <Icon name="square" tone="danger" />
        {t("scan.stop")}
      </button>

      <span className="spacer" />

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
