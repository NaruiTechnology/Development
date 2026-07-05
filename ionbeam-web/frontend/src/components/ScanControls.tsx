/**
 * Run / Pause / Stop button group, plus a "Run validated" button that
 * uses the blocking REST endpoint (returns a ScanResult with timing,
 * validation report, and CSV path).
 *
 * ROI loops use Pause as a repeat-loop toggle: the current run is
 * allowed to finish, then the remaining repeats are held until the
 * operator clicks Resume.
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
  type ScanKind,
} from "../store/scanSlice";
import { bumpRevision, resetRaster, resetVector } from "../store/imageSlice";
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
import { RunValidatedHelp } from "./RunValidatedHelp";
import { NumberStepperInput } from "./NumberStepperField";
import { selectedEquipmentId, setSelectedEquipmentId } from "../lib/adminActivity";
import { scanAuthHeaders } from "../lib/authIdentity";
import type { VectorRequest } from "../types/api";

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
  const stream = useScanStream();
  const prevPhaseRef = useRef(phase);
  const actionLoopTimerRef = useRef<number | null>(null);
  const actionLoopRequestRef = useRef<{ req: VectorRequest; preview: boolean } | null>(null);
  const actionLoopRemainingRef = useRef(0);
  const actionLoopIterationRef = useRef(0);
  const actionLoopActiveRef = useRef(false);
  const actionLoopPausedRef = useRef(false);
  const actionLoopGapMs = 180;
  const [actionLoopIteration, setActionLoopIteration] = useState(0);
  const [actionLoopActive, setActionLoopActive] = useState(false);
  const [actionLoopPaused, setActionLoopPaused] = useState(false);
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
  const scanGrayScaleSelection =
    activeVectorGrayScaleSelection ?? roiGrayScaleSelection;
  const scanGrayScaleSkipped =
    activeVectorGrayScaleSkipped ?? roiGrayScaleSkipped;
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
        { ...vector, roi },
        roiState,
        {
          grayScaleSelection: scanGrayScaleSelection,
          grayScaleSkipped: scanGrayScaleSkipped,
        }
      );
    }
    return vectorRequestWithBitmapSelection(
      { ...vector, roi },
      roiState,
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
  //   paused                → close completed, image preserved
  const streaming = phase === "running";
  const closing = phase === "stopping";
  const paused = phase === "paused";
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
    actionLoopPausedRef.current = false;
    setActionLoopIteration(0);
    setActionLoopActive(false);
    setActionLoopPaused(false);
  }, [clearActionLoopTimer]);

  const startActionLoop = useCallback((req: VectorRequest) => {
    clearActionLoopState();
    actionLoopRequestRef.current = { req, preview };
    actionLoopRemainingRef.current = Math.max(0, Math.min(50, Math.trunc(repeat)));
    actionLoopIterationRef.current = actionLoopRemainingRef.current;
    setActionLoopIteration(actionLoopIterationRef.current);
    actionLoopActiveRef.current = true;
    actionLoopPausedRef.current = false;
    setActionLoopActive(true);
    setActionLoopPaused(false);
  }, [clearActionLoopState, preview, repeat]);

  const scheduleNextActionRun = useCallback(() => {
    clearActionLoopTimer();
    if (!actionLoopActiveRef.current || actionLoopPausedRef.current || actionLoopRemainingRef.current <= 0) {
      return;
    }
    actionLoopTimerRef.current = window.setTimeout(() => {
      actionLoopTimerRef.current = null;
      if (!actionLoopActiveRef.current || actionLoopPausedRef.current || actionLoopRemainingRef.current <= 0) {
        return;
      }
      const entry = actionLoopRequestRef.current;
      if (!entry) {
        return;
      }
      dispatch(bumpRevision());
      stream.startVector({ ...entry.req, preview: entry.preview });
    }, actionLoopGapMs);
  }, [actionLoopGapMs, clearActionLoopTimer, dispatch, stream]);

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
        if (scanGrayScaleSelection === null || scanGrayScaleSkipped === null) {
          throw new Error(t("roi.actionRun.selectionRequired"));
        }
        const req = await vectorRequestWithROIGrayScaleAction(
          { ...vector, roi },
          roiState,
          {
            grayScaleSelection: scanGrayScaleSelection,
            grayScaleSkipped: scanGrayScaleSkipped,
          }
        );
        startActionLoop(req);
        onActionRunStart?.();
        stream.startVector({ ...req, preview });
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
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
            grayScaleSelection: scanGrayScaleSelection,
            grayScaleSkipped: scanGrayScaleSkipped,
          }
        );
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
        if (Math.trunc(repeat) > 1) {
          startActionLoop(req);
        } else {
          clearActionLoopState();
        }
        stream.startVector({ ...req, preview });
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    }
  }

  function onPause() {
    if (disabled || roiEbeamDisabled) return;
    if (roiAction) {
      if (!actionLoopActiveRef.current && !actionLoopPausedRef.current) {
        return;
      }
      if (actionLoopPausedRef.current) {
        actionLoopPausedRef.current = false;
        setActionLoopPaused(false);
        if (!streaming && actionLoopActiveRef.current && actionLoopRemainingRef.current > 0) {
          scheduleNextActionRun();
        }
        return;
      }
      actionLoopPausedRef.current = true;
      setActionLoopPaused(true);
      clearActionLoopTimer();
      return;
    }
    stream.pause();
  }

  function onStop() {
    if (disabled || roiEbeamDisabled) return;
    clearActionLoopState();
    stream.stop();
    if (kind === "raster") dispatch(resetRaster({ resolution: raster.resolution }));
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
            grayScaleSelection: roiGrayScaleSelection,
            grayScaleSkipped: roiGrayScaleSkipped,
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
    (roiAction && (actionLoopActive || actionLoopPaused));
  const roiPauseEnabled = actionLoopActive || actionLoopPaused || streaming || closing || paused;
  const pauseDisabled = roiAction ? disabled || roiEbeamDisabled || !roiPauseEnabled : disabled || !streaming;
  const stopDisabled = disabled || roiEbeamDisabled || !(streaming || paused || closing || actionLoopActive || actionLoopPaused);
  const roiResumeMode = roiAction && actionLoopPaused;
  const roiPauseButtonClass = roiResumeMode ? "btn btn--primary" : `btn ${actionLoopActive || actionLoopPaused || streaming || closing || paused ? "btn--gold" : ""}`;
  const roiPauseButtonLabel = roiResumeMode ? t("scan.resume") : t("scan.pause");
  const roiPauseButtonTitle = roiResumeMode ? t("scan.resume.title") : t("scan.pause.title");
  const roiPauseButtonIcon = roiResumeMode ? "play" : "pause";
  const repeatDisplayCount =
    actionLoopActive || actionLoopPaused || streaming || closing || paused ? actionLoopIteration : repeat;

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
    if (completedNow && actionLoopActiveRef.current) {
      if (actionLoopRemainingRef.current > 0) {
        actionLoopRemainingRef.current -= 1;
        actionLoopIterationRef.current = actionLoopRemainingRef.current;
        setActionLoopIteration(actionLoopIterationRef.current);
      }
      if (!actionLoopPausedRef.current && actionLoopRemainingRef.current > 0) {
        clearBitmapSelectionCache();
        dispatch(bumpRevision());
        scheduleNextActionRun();
        return;
      }
      clearActionLoopState();
    }
    if (phase === "error" || phase === "idle") {
      clearActionLoopState();
    }
  }, [clearActionLoopState, phase, roiState.imageDataUrl, roiState.selection, scheduleNextActionRun]);

  useEffect(() => {
    clearActionLoopState();
  }, [clearActionLoopState, roiAction, roiState.selection, kind]);

  useEffect(() => {
    return () => {
      clearActionLoopState();
    };
  }, [clearActionLoopState]);

  if (roiAction) {
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
              className="btn btn--primary"
              disabled={runDisabled}
              onClick={onRun}
              title={t("roi.actionRun.title")}
            >
              <Icon name="play" tone="success" />
              {t("roi.actionRun")}
            </button>
            <button
              className={roiPauseButtonClass}
              disabled={pauseDisabled}
              onClick={onPause}
              title={roiPauseButtonTitle}
            >
              <Icon
                name={roiPauseButtonIcon}
                tone={roiResumeMode ? "success" : actionLoopActive || actionLoopPaused || streaming || closing || paused ? "accent" : "warn"}
              />
              {roiPauseButtonLabel}
            </button>
            <button
              className="btn btn--danger"
              disabled={stopDisabled}
              onClick={onStop}
              title={t("scan.stop.title")}
            >
              <Icon name="square" tone="danger" />
              {t("scan.stop")}
            </button>
          </div>
          {showRepeatControl && (
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
        className="btn btn--primary"
        disabled={runDisabled || kind === "roi"}
        onClick={onRun}
        title={paused ? t("scan.run.title.paused") : t("scan.run.title.start")}
      >
        <Icon name="play" tone="success" />
        {t("scan.run")}
      </button>
      <button
        className="btn btn--warn"
        disabled={pauseDisabled}
        onClick={onPause}
        title={t("scan.pause.title")}
      >
        <Icon name="pause" tone="warn" />
        {closing ? t("scan.pausing") : t("scan.pause")}
      </button>
      <button
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
      <button className="btn btn--ghost" disabled={runDisabled} onClick={onClear}>
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
