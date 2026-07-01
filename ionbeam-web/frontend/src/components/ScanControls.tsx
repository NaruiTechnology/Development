/**
 * Run / Pause / Stop button group, plus a "Run validated" button that
 * uses the blocking REST endpoint (returns a ScanResult with timing,
 * validation report, and CSV path).
 *
 * Pause vs. Stop semantics
 * ------------------------
 * The FPGA pipeline is one-shot — once a scan starts, it runs until the
 * point list is exhausted; there is no real mid-frame pause. So Pause
 * and Stop both close the WS (which calls gen.aclose() server-side and
 * cancels the scan), and the only difference is whether the partial
 * frame on the canvas is preserved.
 *
 *   Run    : start a fresh scan
 *   Pause  : end the scan, keep the partial image (operator wants to
 *            inspect what was captured before continuing)
 *   Stop   : end the scan, clear the image
 *
 * After Pause, pressing Run starts a new scan from sample 0 and clears
 * the kept image. We don't label that "Resume" because the previous
 * implementation's "Resume" pretended the partial frame would continue
 * from where it left off — which was never true. The button stays
 * labeled "Run" so the operator knows what it actually does.
 */
import { useEffect, useRef, useState } from "react";

import { useAppDispatch, useAppSelector } from "../store";
import { apiUrl } from "../lib/backendUrl";
import {
  clearROIImage,
  runRasterValidated,
  runVectorValidated,
  setPreview,
  streamErrored,
  streamReset,
  type ScanKind,
} from "../store/scanSlice";
import { resetRaster, resetVector } from "../store/imageSlice";
import { registerScanActionStop } from "../hooks/scanActionRegistry";
import { useScanStream } from "../hooks/useScanStream";
import {
  clearBitmapSelectionCache,
  rasterRequestWithBitmapSelection,
  vectorRequestWithBitmapSelection,
} from "../lib/bitmapVector";
import { useTranslation } from "../i18n";
import { Icon } from "./Icon";
import { RunValidatedHelp } from "./RunValidatedHelp";
import { selectedEquipmentId, setSelectedEquipmentId } from "../lib/adminActivity";
import { scanAuthHeaders } from "../lib/authIdentity";

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
  grayScaleSelection = null,
  grayScaleSkipped = null,
}: {
  kind: ScanKind;
  disabled?: boolean;
  scanActive?: boolean;
  grayScaleSelection?: number | null;
  grayScaleSkipped?: boolean | null;
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
  const roi = roiState.selection;
  const stream = useScanStream();
  const prevPhaseRef = useRef(phase);
  const [equipment, setEquipment] = useState<EquipmentOption[]>([]);
  const [equipmentId, setEquipmentId] = useState("");
  const isProduction = defaults?.is_production !== false;
  const allowBitmapSimulation = !isProduction && Boolean(roiState.imageDataUrl);

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

  async function onRun() {
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
            grayScaleSelection,
            grayScaleSkipped,
          }
        );
        stream.startRaster({ ...req, preview });
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    }
    else {
      try {
        const req = await vectorRequestWithBitmapSelection(
          { ...vector, roi },
          roiState,
          {
            isProduction,
            allowBitmapSimulation,
            grayScaleSelection,
            grayScaleSkipped,
          }
        );
        stream.startVector({ ...req, preview });
      } catch (e: any) {
        dispatch(streamErrored(e?.message ?? String(e)));
      }
    }
  }

  function onPause() {
    if (disabled) return;
    stream.pause();
  }

  function onStop() {
    if (disabled) return;
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
            grayScaleSelection,
            grayScaleSkipped,
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
        const req = await vectorRequestWithBitmapSelection(
          { ...vector, roi },
          roiState,
          {
            isProduction,
            allowBitmapSimulation,
            grayScaleSelection,
            grayScaleSkipped,
          }
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

  const runDisabled = controlsDisabled || streaming || closing;
  const pauseDisabled = disabled || !streaming;
  const stopDisabled = disabled || !(streaming || paused);

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
    if (
      completedNow &&
      roiState.imageDataUrl &&
      roiState.selection &&
      !roiState.keep_loaded_bitmap_after_scan
    ) {
      clearBitmapSelectionCache();
      dispatch(clearROIImage());
    }
  }, [dispatch, phase, roiState.imageDataUrl, roiState.keep_loaded_bitmap_after_scan, roiState.selection]);

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
          disabled={runDisabled || kind === "roi"}
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
      <span
        className="scan-busy"
        data-visible={busy ? "true" : "false"}
        aria-hidden={!busy}
        title={t("scan.busy.title")}
      >
        <span className="scan-busy__spinner" />
      </span>
    </div>
  );
}
