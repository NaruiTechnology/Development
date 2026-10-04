/**
 * SettingsDialog - modal editor for streamData.json with tabbed sections.
 *
 * Lifecycle
 * ---------
 *   open    -> mounts component, dispatches fetchSettingsConfig()
 *   loading -> spinner; tabs render their last cached state if any
 *   ready   -> tabs edit `draft`; Save As / Default operate on it
 *   saving  -> buttons disabled, spinner on the action that fired
 *   restart -> result surfaced under the buttons (success or error
 *              detail), independent of the save itself
 *
 * Why a single tree of forms rather than three slice editors
 * ----------------------------------------------------------
 * Each tab edits a different subtree of the SAME JSON document, but
 * "Save As" / "Default" operate on the document as a whole. Composing
 * three slice editors would mean either:
 *   (a) reconciling three local drafts on save (error-prone), or
 *   (b) pushing each per-field change up to settingsSlice immediately
 *       (what we do here).
 * (b) is simpler: persisted inputs dispatch `setDraft(writePath(...))`
 * with an immutably updated copy, and the dialog reads `draft` for
 * every render. Session-only image transforms and Simulation values stay in
 * local modal state until Update is clicked. The Redux DevTools timeline
 * becomes the edit history for persisted fields for free.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { useTranslation, type TranslationKey } from "../i18n";
import { useAppDispatch, useAppSelector, type AppDispatch } from "../store";
import {
  clearLastResult,
  clearROIImage,
  clearROISelection,
  setStreamTransforms,
  streamReset,
  type StreamTransforms,
} from "../store/scanSlice";
import { resetRaster, resetVector } from "../store/imageSlice";
import { fetchDefaultsMetadata, previewConfigDefaults, setSessionSimulation } from "../store/statusSlice";
import { scanAuthHeaders } from "../lib/authIdentity";
import { apiUrl } from "../lib/backendUrl";
import { readJsonResponse } from "../lib/readJsonResponse";
import {
  ACTION_DATA_PATH,
  FTP_PATH,
  PINS_PATH,
  RASTER_PATH,
  SIMULATION_PATH,
  VECTOR_PATH,
  clearError,
  clearLastRestart,
  closeDialog,
  setBackendRestarting,
  consumeBackupNotice,
  fetchSettingsConfig,
  readPath,
  restoreSettingsConfig,
  saveSettingsConfig,
  setActiveTab,
  setDraft,
  setError,
  writePath,
  type SettingsConfigInfo,
  type SettingsTab,
} from "../store/settingsSlice";
import { HelpPopover } from "./HelpPopover";
import { CalibrationPanel } from "./calibration/CalibrationPanel";
import { EquipmentGrid } from "./EquipmentGrid";
import { UserAccountsGrid } from "./UserAccountsGrid";
import {
  emptyEquipment,
  equipmentFromDraft,
  type EquipmentRow,
} from "../lib/equipmentModel";
import { parseEquipmentCsv } from "../lib/equipmentCsv";
import { Icon } from "./Icon";
import { LoadingSpinner } from "./LoadingSpinner";
import { PresetNumberField, type PresetNumberOption } from "./PresetNumberField";
import { NumberStepperInput } from "./NumberStepperField";
import { clearBitmapSelectionCache } from "../lib/bitmapVector";
import { DEFAULT_SITE, SITE_OPTIONS, normalizeSiteValue } from "../lib/sites";

const RASTER_RESOLUTION_OPTIONS: PresetNumberOption[] = [256, 512, 1024, 2048].map((value) => ({ value }));
const VECTOR_RESOLUTION_OPTIONS: PresetNumberOption[] = [256, 512, 1024, 2048].map((value) => ({ value }));
const DWELL_OPTIONS: PresetNumberOption[] = [0, 1, 3, 7, 15, 31, 63].map((value) => ({ value }));

export function SettingsDialog({
  targetAccountId = null,
  targetLogin = null,
  mobilityMode = false,
  scanLocked = false,
  vectorGrayLevelsEnabled = false,
}: {
  targetAccountId?: number | null;
  targetLogin?: string | null;
  mobilityMode?: boolean;
  scanLocked?: boolean;
  vectorGrayLevelsEnabled?: boolean;
}) {
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.settings.dialogOpen);

  useEffect(() => {
    if (!open) return;
    dispatch(fetchSettingsConfig());
  }, [dispatch, open]);

  // Scroll lock while the settings modal is open. Persisted updates keep the
  // dialog open for restart results; session-only updates close it.
  useEffect(() => {
    if (!open) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <SettingsModalShell
        targetAccountId={targetAccountId}
        targetLogin={targetLogin}
        mobilityMode={mobilityMode}
        scanLocked={scanLocked}
        vectorGrayLevelsEnabled={vectorGrayLevelsEnabled}
      />
    </div>
  );
}

async function refreshDefaultsForSettings(dispatch: AppDispatch) {
  const result = await dispatch(fetchDefaultsMetadata());
  return fetchDefaultsMetadata.fulfilled.match(result);
}

function resetPartialROISelection(dispatch: AppDispatch) {
  clearBitmapSelectionCache();
  dispatch(clearROISelection());
}

function resetROIPreview(dispatch: AppDispatch) {
  resetPartialROISelection(dispatch);
  dispatch(clearROIImage());
}

function resetScanImages(dispatch: AppDispatch, rasterResolution: number, preserveVectorImage: boolean) {
  dispatch(streamReset());
  dispatch(clearLastResult());
  dispatch(resetRaster({ resolution: rasterResolution }));
  if (!preserveVectorImage) dispatch(resetVector());
}

function simulationImageSignature(config: unknown): string {
  return JSON.stringify({
    enabled: readPath(config, [...SIMULATION_PATH, "enabled"]),
    mode: readPath(config, [...SIMULATION_PATH, "mode"]),
    imageResolution: readPath(config, [...SIMULATION_PATH, "imageResolution"]),
    source: readPath(config, [...SIMULATION_PATH, "source"]),
    patternKind: readPath(config, [...SIMULATION_PATH, "patternKind"]),
    invert: readPath(config, [...SIMULATION_PATH, "invert"]),
    seed: readPath(config, [...SIMULATION_PATH, "seed"]),
  });
}

function simulationImageChanged(before: unknown, after: unknown): boolean {
  return simulationImageSignature(before) !== simulationImageSignature(after);
}

function simulationRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sessionSimulationSignature(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/* -------- modal shell -------------------------------------------------- */

function SettingsModalShell({
  targetAccountId,
  targetLogin,
  mobilityMode,
  scanLocked,
  vectorGrayLevelsEnabled,
}: {
  targetAccountId: number | null;
  targetLogin: string | null;
  mobilityMode: boolean;
  scanLocked: boolean;
  vectorGrayLevelsEnabled: boolean;
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const {
    activeTab,
    loading,
    saving,
    restoring,
    source,
    draft,
    configPath,
    hasBackup,
    error,
    lastRestart,
    backupNotice,
  } = useAppSelector((s) => s.settings);
  const rasterResolution = useAppSelector((s) => s.scan.raster.resolution);
  const activeTransforms = useAppSelector((s) => s.scan.streamTransforms);
  const appliedSessionSimulation = useAppSelector((s) => s.status.sessionSimulation);
  const defaultSimulation = useAppSelector((s) => s.status.defaults?.simulation ?? null);

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const titleIdRef = useRef(
    `settings-modal-title-${Math.random().toString(36).slice(2, 9)}`,
  );

  useEffect(() => {
    const focusTimer = window.setTimeout(() => closeBtnRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, []);

  useEffect(() => {
    if (activeTab === "admin") return;
    if (targetAccountId !== null || targetLogin) {
      dispatch(setActiveTab("admin"));
    }
  }, [activeTab, dispatch, targetAccountId, targetLogin]);

  useEffect(() => {
    if (mobilityMode && activeTab !== "admin") {
      dispatch(setActiveTab("admin"));
    }
  }, [activeTab, dispatch, mobilityMode]);

  // "Save As" and "Default" both fire a confirm-then-action flow. We
  // use local component state for the confirm row rather than a nested
  // modal - a second modal layer is heavy for a yes/no prompt.
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDefault, setConfirmDefault] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<AdminSubTab>("users");
  const [currentAccountRole, setCurrentAccountRole] = useState<number | null>(null);
  // Image orientation is a browser-session control. Keep its pending values
  // outside the streamData draft so Update never persists or restarts for it.
  const [sessionTransforms, setSessionTransforms] = useState<StreamTransforms>(() => ({
    ...activeTransforms,
  }));
  // Null means untouched: until the operator edits Simulation, follow the
  // latest active/default block instead of freezing an early loading value.
  const [sessionSimulationDraft, setSessionSimulationDraft] = useState<Record<string, unknown> | null>(null);

  const configuredSimulation = simulationRecord(readPath(source, SIMULATION_PATH));
  const activeSimulation = appliedSessionSimulation ?? defaultSimulation ?? configuredSimulation ?? {};
  const pendingSimulation = sessionSimulationDraft ?? activeSimulation;

  const busy = loading || saving || restoring;
  const adcTimingValid = draft === null || validAdcTiming(draft);
  const configChanged = draft !== null && draft !== source;
  const sessionTransformsChanged =
    sessionTransforms.xflip !== activeTransforms.xflip ||
    sessionTransforms.yflip !== activeTransforms.yflip ||
    sessionTransforms.rotate90 !== activeTransforms.rotate90;
  const sessionSimulationChanged =
    sessionSimulationDraft !== null &&
    sessionSimulationSignature(pendingSimulation) !== sessionSimulationSignature(activeSimulation);
  const sessionOnlyChanged = sessionTransformsChanged || sessionSimulationChanged;
  const canEditPins = currentAccountRole !== null && currentAccountRole >= ADMIN_ROLE;
  const canEditFtp = currentAccountRole !== null && currentAccountRole >= ADMIN_ROLE;
  const visibleTabs: SettingsTab[] = mobilityMode
    ? ["admin"]
    : ["general", "raster", "vector", "pins", "simulation", "admin"];

  useEffect(() => {
    if (targetAccountId !== null || targetLogin) {
      setActiveSubTab("users");
    }
  }, [targetAccountId, targetLogin]);

  useEffect(() => {
    let cancelled = false;
    fetchCurrentAccountRole()
      .then((role) => {
        if (!cancelled) setCurrentAccountRole(role);
      })
      .catch(() => {
        if (!cancelled) setCurrentAccountRole(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function onSelectTab(tab: SettingsTab) {
    if (confirmSave) setConfirmSave(false);
    if (confirmDefault) setConfirmDefault(false);
    dispatch(setActiveTab(tab));
  }

  function applySessionSettings() {
    if (sessionTransformsChanged) dispatch(setStreamTransforms(sessionTransforms));
    if (sessionSimulationChanged) dispatch(setSessionSimulation(pendingSimulation));
    if (sessionSimulationChanged) resetROIPreview(dispatch);
    else if (sessionTransformsChanged) resetPartialROISelection(dispatch);
  }

  function onUpdate() {
    if (configChanged) {
      setConfirmSave(true);
      return;
    }
    if (!sessionOnlyChanged) return;
    applySessionSettings();
    dispatch(closeDialog());
  }

  async function onConfirmSave() {
    if (draft === null) return;
    if (!validAdcTiming(draft)) {
      setConfirmSave(false);
      dispatch(setError(t("settings.general.adcTiming.validation")));
      return;
    }
    setConfirmSave(false);
    const imageChanged = simulationImageChanged(source, draft);
    const result = await dispatch(saveSettingsConfig(draft));
    if (saveSettingsConfig.fulfilled.match(result)) {
      if (sessionOnlyChanged) applySessionSettings();
      if (imageChanged) {
        resetROIPreview(dispatch);
      } else {
        resetPartialROISelection(dispatch);
      }
      resetScanImages(dispatch, rasterResolution, vectorGrayLevelsEnabled);
      dispatch(previewConfigDefaults(configDefaultsPreview(draft)));
      if (await refreshDefaultsForSettings(dispatch)) {
        dispatch(setBackendRestarting(false));
      }
      if (sessionOnlyChanged) dispatch(closeDialog());
    }
    // The restart result is surfaced via `lastRestart`; we don't
    // auto-close the dialog so the operator can see whether it
    // succeeded.
  }

  async function onConfirmDefault() {
    setConfirmDefault(false);
    const result = await dispatch(restoreSettingsConfig());
    if (restoreSettingsConfig.fulfilled.match(result)) {
      resetScanImages(dispatch, rasterResolution, vectorGrayLevelsEnabled);
      // Pull the restored values back into the dialog so the tabs
      // show the freshly-installed defaults instead of the pre-restore
      // draft.
      const config = await dispatch(fetchSettingsConfig());
      if (fetchSettingsConfig.fulfilled.match(config)) {
        if (simulationImageChanged(source, config.payload.data)) {
          resetROIPreview(dispatch);
        } else {
          resetPartialROISelection(dispatch);
        }
        dispatch(previewConfigDefaults(configDefaultsPreview(config.payload.data)));
      } else {
        resetPartialROISelection(dispatch);
      }
      if (await refreshDefaultsForSettings(dispatch)) {
        dispatch(setBackendRestarting(false));
      }
    }
  }

  // Render gate. We keep the shell mounted even during loading so the
  // close button and the dimmed backdrop work the moment the dialog
  // opens - only the body switches to a spinner. Once `draft` arrives
  // we light up the tabs.
  return (
    <div
      className={`modal settings-modal${activeTab === "admin" && activeSubTab === "calibration" ? " settings-modal--wide" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleIdRef.current}
    >
      <div className="modal__header">
        <div id={titleIdRef.current} className="modal__title">
          {t("settings.title")}
        </div>
        <button
          ref={closeBtnRef}
          type="button"
          className="modal__close"
          onClick={() => dispatch(closeDialog())}
          aria-label={t("help.close")}
          title={t("help.close")}
          disabled={busy}
        >
          <Icon name="x" />
        </button>
      </div>

      {!mobilityMode && configPath && (
        <div className="settings-path-strip" title={configPath}>
          <span className="settings-path-strip__label">
            {t("settings.boundTo")}
          </span>
          <code className="settings-path-strip__path">{configPath}</code>
        </div>
      )}

      {backupNotice && (
        <SettingsNotice
          tone="info"
          message={t("settings.backupCreated")}
          onDismiss={() => dispatch(consumeBackupNotice())}
        />
      )}

      {error && (
        <SettingsNotice
          tone="error"
          message={error}
          onDismiss={() => dispatch(clearError())}
        />
      )}

      {lastRestart && (
        <SettingsNotice
          tone={lastRestart.ok ? "success" : "error"}
          message={
            lastRestart.ok
              ? lastRestart.skipped
                ? t("settings.restart.skipped")
                : t("settings.restart.ok", { command: lastRestart.command })
              : t("settings.restart.fail", {
                  command: lastRestart.command,
                  detail: lastRestart.error || lastRestart.stderr || "",
                })
          }
          onDismiss={() => dispatch(clearLastRestart())}
        />
      )}

      <div className="settings-tabs" role="tablist" aria-label={t("settings.tabs.aria")}>
        {visibleTabs.map((tab) => (
          <SettingsTabButton key={tab} tab={tab} active={activeTab} onSelect={onSelectTab} />
        ))}
      </div>

      <div className="modal__body settings-modal__body">
        {loading && draft === null ? (
          <LoadingSpinner className="settings-loading" label={t("settings.loading")} />
        ) : draft === null ? (
          <div className="settings-loading">{t("settings.empty")}</div>
        ) : (
        <SettingsTabBody
          tab={activeTab}
          draft={draft}
          targetAccountId={targetAccountId}
          targetLogin={targetLogin}
          activeSubTab={activeSubTab}
          onSelectAdminSubTab={(tab) => {
              setConfirmSave(false);
              setConfirmDefault(false);
              setActiveSubTab(tab);
            }}
          mobilityMode={mobilityMode}
          canEditPins={canEditPins}
          canEditFtp={canEditFtp}
          sessionTransforms={sessionTransforms}
          onSessionTransformsChange={setSessionTransforms}
          sessionSimulation={pendingSimulation}
          onSessionSimulationChange={setSessionSimulationDraft}
        />
        )}
      </div>

      <div className="settings-footer">
        {confirmSave ? (
          <ConfirmRow
            message={t("settings.confirm.save")}
            confirmLabel={t("settings.confirm.save.yes")}
            disabled={busy}
            onConfirm={onConfirmSave}
            onCancel={() => setConfirmSave(false)}
          />
        ) : confirmDefault ? (
          <ConfirmRow
            message={t("settings.confirm.default")}
            confirmLabel={t("settings.confirm.default.yes")}
            disabled={busy}
            onConfirm={onConfirmDefault}
            onCancel={() => setConfirmDefault(false)}
          />
        ) : activeTab === "admin" ? null : (
          <div className="settings-footer__row">
            <span
              className="scan-busy"
              data-visible={busy || scanLocked ? "true" : "false"}
              aria-hidden={!busy}
            >
              <LoadingSpinner inline size={20} ariaLabel={t("settings.admin.busy")} />
            </span>

            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => dispatch(fetchSettingsConfig())}
              disabled={busy || scanLocked}
              title={t("settings.reload.title")}
            >
              <Icon name="refresh" tone="accent" />
              {t("settings.reload")}
            </button>

            <span className="spacer" />

            <button
              type="button"
              className="btn btn--warn"
              disabled={busy || scanLocked || !hasBackup}
              onClick={() => setConfirmDefault(true)}
              title={
                hasBackup
                  ? t("settings.btn.default.title")
                  : t("settings.btn.default.title.noBackup")
              }
            >
              <Icon name="refresh" tone="warn" />
              {t("settings.btn.default")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || scanLocked || draft === null || (!configChanged && !sessionOnlyChanged) || !adcTimingValid}
              onClick={onUpdate}
              title={
                configChanged
                  ? t("settings.btn.saveAs.title")
                  : t("settings.btn.sessionOnly.title")
              }
            >
              <Icon name="download" />
              {t("settings.btn.saveAs")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------- tab buttons -------------------------------------------------- */

function SettingsTabButton({
  tab,
  active,
  onSelect,
}: {
  tab: SettingsTab;
  active: SettingsTab;
  onSelect: (t: SettingsTab) => void;
}) {
  const { t } = useTranslation();
  const labelKey: TranslationKey = (
    {
      general: "settings.tabs.general",
      raster: "settings.tabs.raster",
      vector: "settings.tabs.vector",
      pins: "settings.tabs.pins",
      simulation: "settings.tabs.simulation",
      ftp: "settings.tabs.ftp",
      admin: "settings.tabs.admin",
    } as const
  )[tab];
  return (
    <button
      type="button"
      role="tab"
      className="tab"
      aria-selected={active === tab}
      onClick={() => onSelect(tab)}
    >
      {t(labelKey)}
    </button>
  );
}

/* -------- tab bodies --------------------------------------------------- */

function SettingsTabBody({
  tab,
  draft,
  targetAccountId,
  targetLogin,
  activeSubTab,
  onSelectAdminSubTab,
  mobilityMode,
  canEditPins,
  canEditFtp,
  sessionTransforms,
  onSessionTransformsChange,
  sessionSimulation,
  onSessionSimulationChange,
}: {
  tab: SettingsTab;
  draft: unknown;
  targetAccountId: number | null;
  targetLogin: string | null;
  activeSubTab: AdminSubTab;
  onSelectAdminSubTab: (tab: AdminSubTab) => void;
  mobilityMode: boolean;
  canEditPins: boolean;
  canEditFtp: boolean;
  sessionTransforms: StreamTransforms;
  onSessionTransformsChange: (transforms: StreamTransforms) => void;
  sessionSimulation: Record<string, unknown>;
  onSessionSimulationChange: (simulation: Record<string, unknown>) => void;
}) {
  switch (tab) {
    case "general":
      return (
        <GeneralTab
          draft={draft}
          sessionTransforms={sessionTransforms}
          onSessionTransformsChange={onSessionTransformsChange}
        />
      );
    case "raster":
      return <RasterTab draft={draft} />;
    case "vector":
      return <VectorTab draft={draft} />;
    case "pins":
      return <PinsTab draft={draft} disabled={!canEditPins} />;
    case "simulation":
      return (
        <SimulationTab
          simulation={sessionSimulation}
          onSimulationChange={onSessionSimulationChange}
        />
      );
    case "ftp":
      return <FtpTab draft={draft} disabled={!canEditFtp} />;
    case "admin":
      return (
        <AdminTab
          targetAccountId={targetAccountId}
          targetLogin={targetLogin}
          activeSubTab={activeSubTab}
          onSelectSubTab={onSelectAdminSubTab}
          mobilityMode={mobilityMode}
        />
      );
  }
}

/* General tab: top-level flags plus the basic actionData scalars that
 * aren't raster- or vector-specific. */
function GeneralTab({
  draft,
  sessionTransforms,
  onSessionTransformsChange,
}: {
  draft: unknown;
  sessionTransforms: StreamTransforms;
  onSessionTransformsChange: (transforms: StreamTransforms) => void;
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();

  // Top-level scalars.
  const version = stringField(draft, ["Version"], "");
  const logName = stringField(draft, ["LogName"], "");
  const verbose = boolField(draft, ["Verbose"], false);
  const isProduction = boolField(draft, ["IsProduction"], false);
  const { xflip, yflip, rotate90 } = sessionTransforms;
  const dumpData = boolField(draft, ["DumpData"], false);

  // Glasgow / Device0 id.
  const deviceId = stringField(draft, ["Glasgow", "Device0", "Id"], "");

  // actionData scalars.
  const ev = numberField(
    draft,
    [...ACTION_DATA_PATH, "ev"],
    1000,
  );
  const bufferSize = stringField(draft, [...ACTION_DATA_PATH, "bufferSize"], "");
  const adcHalfPeriod = numberField(draft, [...ACTION_DATA_PATH, "adcHalfPeriod"], 3);
  const adcSettleCycles = numberField(draft, [...ACTION_DATA_PATH, "adcSettleCycles"], 1);
  const adcLatchCycles = numberField(draft, [...ACTION_DATA_PATH, "adcLatchCycles"], 1);
  const busTurnaroundCycles = numberField(draft, [...ACTION_DATA_PATH, "busTurnaroundCycles"], 0);
  const dacDataSetupCycles = numberField(draft, [...ACTION_DATA_PATH, "dacDataSetupCycles"], 1);
  const dacLatchCycles = numberField(draft, [...ACTION_DATA_PATH, "dacLatchCycles"], 1);
  const adcTimingValid = validAdcTiming(draft);
  const requiredTimingCycles = adcSettleCycles + adcLatchCycles
    + busTurnaroundCycles + 2 * (dacDataSetupCycles + dacLatchCycles);
  const adcMinimumHalfPeriod = Math.max(
    2, adcLatchCycles + adcSettleCycles, Math.ceil(requiredTimingCycles / 2),
  );
  const adcClockMHz = Number.isFinite(adcHalfPeriod) && adcHalfPeriod > 0
    ? 48 / (2 * adcHalfPeriod)
    : 0;
  const enableEbeam = boolField(draft, [...ACTION_DATA_PATH, "enableEbeam"], false);
  const enableIbeam = boolField(draft, [...ACTION_DATA_PATH, "enableIbeam"], true);
  const selectedBeam = enableIbeam || !enableEbeam ? "ion" : "ebeam";

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    dispatch(setDraft(writePath(draft, p, v)));
  }

  function setTransform(name: "xflip" | "yflip" | "rotate90", value: boolean) {
    onSessionTransformsChange({ ...sessionTransforms, [name]: value });
  }

  function setHardwareTiming(
    halfPeriod: number, settleCycles: number, latchCycles: number,
    turnaroundCycles: number, dacSetupCycles: number, nextDacLatchCycles: number,
  ) {
    let next = writePath(draft, [...ACTION_DATA_PATH, "adcHalfPeriod"], halfPeriod);
    next = writePath(next, [...ACTION_DATA_PATH, "adcSettleCycles"], settleCycles);
    next = writePath(next, [...ACTION_DATA_PATH, "adcLatchCycles"], latchCycles);
    next = writePath(next, [...ACTION_DATA_PATH, "busTurnaroundCycles"], turnaroundCycles);
    next = writePath(next, [...ACTION_DATA_PATH, "dacDataSetupCycles"], dacSetupCycles);
    next = writePath(next, [...ACTION_DATA_PATH, "dacLatchCycles"], nextDacLatchCycles);
    dispatch(setDraft(next));
  }

  function boundedTimingValue(value: number, minimum = 1, maximum = 255): number {
    return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
  }

  function applyTimingChange(values: {
    half?: number; settle?: number; latch?: number; turnaround?: number;
    setup?: number; dacLatch?: number;
  }) {
    const settle = values.settle ?? adcSettleCycles;
    const latch = values.latch ?? adcLatchCycles;
    const turnaround = values.turnaround ?? busTurnaroundCycles;
    const setup = values.setup ?? dacDataSetupCycles;
    const dacLatch = values.dacLatch ?? dacLatchCycles;
    const required = Math.max(
      2,
      settle + latch,
      Math.ceil((settle + latch + turnaround + 2 * (setup + dacLatch)) / 2),
    );
    const half = Math.max(required, values.half ?? adcHalfPeriod);
    setHardwareTiming(half, settle, latch, turnaround, setup, dacLatch);
  }

  return (
    <div className="settings-form">
      <h4 className="settings-form__group">{t("settings.general.group.runtime")}</h4>

      <div className="field-row">
        <TextField
          label={t("settings.general.version")}
          value={version}
          onChange={(v) => set(["Version"], v)}
        />
        <TextField
          label={t("settings.general.logName")}
          value={logName}
          onChange={(v) => set(["LogName"], v)}
        />
        <TextField
          label={t("settings.general.deviceId")}
          value={deviceId}
          onChange={(v) => set(["Glasgow", "Device0", "Id"], v)}
        />
      </div>

      <div className="settings-flags">
        <CheckboxField
          label={t("settings.general.isProduction")}
          value={isProduction}
          onChange={(v) => set(["IsProduction"], v)}
        />
        <CheckboxField
          label={t("settings.general.verbose")}
          value={verbose}
          onChange={(v) => set(["Verbose"], v)}
        />
        <CheckboxField
          label={t("settings.general.xflip")}
          value={xflip}
          onChange={(v) => setTransform("xflip", v)}
        />
        <CheckboxField
          label={t("settings.general.yflip")}
          value={yflip}
          onChange={(v) => setTransform("yflip", v)}
        />
        <CheckboxField
          label={t("settings.general.rotate90")}
          value={rotate90}
          onChange={(v) => setTransform("rotate90", v)}
        />
        <CheckboxField
          label={t("settings.general.dumpData")}
          value={dumpData}
          onChange={(v) => set(["DumpData"], v)}
        />
      </div>

      <h4 className="settings-form__group">
        {t("settings.general.group.actionData")}
      </h4>

      <div className="field-row">
        <NumberField
          label={t("settings.general.ev")}
          help={<SettingsHelp topic="generalVoltage" />}
          value={ev}
          step="any"
          onChange={(v) => set([...ACTION_DATA_PATH, "ev"], v)}
        />
        <TextField
          label={t("settings.general.bufferSize")}
          help={<SettingsHelp topic="generalBuffer" />}
          value={bufferSize}
          onChange={(v) => set([...ACTION_DATA_PATH, "bufferSize"], v)}
        />
      </div>

      <h4 className="settings-form__group">
        {t("settings.general.group.adcTiming")}
      </h4>

      <p className="settings-form__hint">
        {t("settings.general.adcClock", { mhz: adcClockMHz.toFixed(2) })}
        {" "}
        {t("settings.general.adcTiming.rule", { minimum: adcMinimumHalfPeriod })}
      </p>

      <div className="field-row field-row--three">
        <NumberField
          label={t("settings.general.adcHalfPeriod")}
          help={<SettingsHelp topic="generalAdcHalfPeriod" />}
          value={adcHalfPeriod} min={adcMinimumHalfPeriod} max={255}
          invalid={!adcTimingValid}
          warning={!adcTimingValid ? t("settings.general.adcTiming.validation") : undefined}
          onChange={(value) => applyTimingChange({ half: boundedTimingValue(value, 2) })}
        />
        <NumberField
          label={t("settings.general.adcSettleCycles")}
          help={<SettingsHelp topic="generalAdcSettleCycles" />}
          value={adcSettleCycles} min={1} max={255} invalid={!adcTimingValid}
          onChange={(value) => applyTimingChange({ settle: boundedTimingValue(value) })}
        />
        <NumberField
          label={t("settings.general.adcLatchCycles")}
          help={<SettingsHelp topic="generalAdcLatchCycles" />}
          value={adcLatchCycles} min={1} max={255} invalid={!adcTimingValid}
          onChange={(value) => applyTimingChange({ latch: boundedTimingValue(value) })}
        />
      </div>

      <div className="field-row field-row--three settings-form__timing-row">
        <NumberField
          label={t("settings.general.busTurnaroundCycles")}
          help={<SettingsHelp topic="generalBusTurnaroundCycles" />}
          value={busTurnaroundCycles} min={0} max={255} invalid={!adcTimingValid}
          onChange={(value) => applyTimingChange({ turnaround: boundedTimingValue(value, 0) })}
        />
        <NumberField
          label={t("settings.general.dacDataSetupCycles")}
          help={<SettingsHelp topic="generalDacDataSetupCycles" />}
          value={dacDataSetupCycles} min={1} max={255} invalid={!adcTimingValid}
          onChange={(value) => applyTimingChange({ setup: boundedTimingValue(value) })}
        />
        <NumberField
          label={t("settings.general.dacLatchCycles")}
          help={<SettingsHelp topic="generalDacLatchCycles" />}
          value={dacLatchCycles} min={1} max={255} invalid={!adcTimingValid}
          onChange={(value) => applyTimingChange({ dacLatch: boundedTimingValue(value) })}
        />
      </div>

      <h4 className="settings-form__group">
        {t("settings.general.group.beam")}
      </h4>

      <div className="settings-flags" role="radiogroup">
        <RadioField
          name="beam-enable"
          label={t("settings.general.enableEbeam")}
          checked={selectedBeam === "ebeam"}
          onChange={() =>
            dispatch(
              setDraft(
                writePath(
                  writePath(draft, [...ACTION_DATA_PATH, "enableEbeam"], true),
                  [...ACTION_DATA_PATH, "enableIbeam"],
                  false,
                ),
              ),
            )
          }
        />
        <RadioField
          name="beam-enable"
          label={t("settings.general.enableIbeam")}
          checked={selectedBeam === "ion"}
          onChange={() =>
            dispatch(
              setDraft(
                writePath(
                  writePath(draft, [...ACTION_DATA_PATH, "enableEbeam"], false),
                  [...ACTION_DATA_PATH, "enableIbeam"],
                  true,
                ),
              ),
            )
          }
        />
      </div>
    </div>
  );
}

/* Raster tab - Actions[0].streamData.actionData.rasterScan */
function RasterTab({ draft }: { draft: unknown }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();

  const pixels = numberField(draft, [...RASTER_PATH, "pixels"], 0);
  const frameBlank = boolField(draft, [...RASTER_PATH, "frameBlank"], false);
  const resolution = numberField(draft, [...RASTER_PATH, "resolution"], 512);
  const adcLatency = numberField(draft, [...RASTER_PATH, "adcLatency"], 8);
  const dwell = numberField(draft, [...RASTER_PATH, "dwell"], 16);

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    dispatch(setDraft(writePath(draft, p, v)));
  }

  return (
    <div className="settings-form">
      <h4 className="settings-form__group">{t("settings.raster.group.scan")}</h4>

      <div className="field-row">
        <NumberField
          label={t("settings.raster.pixels")}
          help={<SettingsHelp topic="rasterPixels" />}
          value={pixels}
          onChange={(v) => set([...RASTER_PATH, "pixels"], v)}
        />
        <PresetNumberField
          label={<FieldLabel label={t("settings.raster.resolution")} help={<SettingsHelp topic="rasterResolution" />} />}
          value={resolution}
          options={RASTER_RESOLUTION_OPTIONS}
          min={1}
          max={2048}
          disabled={false}
          onChange={(v) => set([...RASTER_PATH, "resolution"], v)}
        />
      </div>

      <div className="field-row">
        <NumberField
          label={t("settings.raster.adcLatency")}
          help={<SettingsHelp topic="rasterAdcLatency" />}
          value={adcLatency}
          onChange={(v) => set([...RASTER_PATH, "adcLatency"], v)}
        />
        <PresetNumberField
          label={<FieldLabel label={t("settings.raster.dwell")} help={<SettingsHelp topic="rasterDwell" />} />}
          value={dwell}
          options={DWELL_OPTIONS}
          min={0}
          max={65535}
          disabled={false}
          onChange={(v) => set([...RASTER_PATH, "dwell"], v)}
        />
      </div>

      <div className="settings-flags">
        <CheckboxField
          label={t("settings.raster.frameBlank")}
          help={<SettingsHelp topic="rasterFrameBlank" />}
          value={frameBlank}
          onChange={(v) => set([...RASTER_PATH, "frameBlank"], v)}
        />
      </div>
    </div>
  );
}

/* Vector tab - Actions[0].streamData.actionData.vectorScan */
function VectorTab({ draft }: { draft: unknown }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();

  const vectorResolution = numberField(draft, [...VECTOR_PATH, "vectorResolution"], 2048);
  const dwell = numberField(draft, [...VECTOR_PATH, "dwell"], 16);
  const latency = numberField(draft, [...VECTOR_PATH, "latency"], 0);
  const adcLatency = numberField(draft, [...VECTOR_PATH, "adcLatency"], 0);
  const lineShift = numberField(draft, [...VECTOR_PATH, "lineShiftPerXRow"], 0);
  const drainFloor = numberField(draft, [...VECTOR_PATH, "drainFloorPixels"], 0);

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    dispatch(setDraft(writePath(draft, p, v)));
  }

  function validateCustomVectorResolution(value: number): string | null {
    const intValue = Math.trunc(value);
    if (intValue < 128) return t("vector.resolution.validation.min128");
    if (!Number.isInteger(intValue) || (intValue & (intValue - 1)) !== 0) {
      return t("vector.resolution.validation.powerOfTwo");
    }
    return null;
  }

  return (
    <div className="settings-form">
      <h4 className="settings-form__group">{t("settings.vector.group.scan")}</h4>

      <div className="field-row">
        <PresetNumberField
          label={<FieldLabel label={t("settings.vector.resolution")} help={<SettingsHelp topic="vectorResolution" />} />}
          value={vectorResolution}
          options={VECTOR_RESOLUTION_OPTIONS}
          min={1}
          max={2048}
          disabled={false}
          customValidate={validateCustomVectorResolution}
          onChange={(v) => set([...VECTOR_PATH, "vectorResolution"], v)}
        />
        <PresetNumberField
          label={<FieldLabel label={t("settings.vector.dwell")} help={<SettingsHelp topic="vectorDwell" />} />}
          value={dwell}
          options={DWELL_OPTIONS}
          min={0}
          max={65535}
          disabled={false}
          onChange={(v) => set([...VECTOR_PATH, "dwell"], v)}
        />
      </div>

      <div className="field-row">
        <NumberField
          label={t("settings.vector.latency")}
          help={<SettingsHelp topic="vectorLatency" />}
          value={latency}
          onChange={(v) => set([...VECTOR_PATH, "latency"], v)}
        />
        <NumberField
          label={t("settings.vector.adcLatency")}
          help={<SettingsHelp topic="vectorAdcLatency" />}
          value={adcLatency}
          onChange={(v) => set([...VECTOR_PATH, "adcLatency"], v)}
        />
      </div>

      <div className="field-row">
        <NumberField
          label={t("settings.vector.lineShiftPerXRow")}
          help={<SettingsHelp topic="vectorLineShift" />}
          value={lineShift}
          step="any"
          onChange={(v) => set([...VECTOR_PATH, "lineShiftPerXRow"], v)}
        />
        <NumberField
          label={t("settings.vector.drainFloorPixels")}
          help={<SettingsHelp topic="vectorDrainFloor" />}
          value={drainFloor}
          onChange={(v) => set([...VECTOR_PATH, "drainFloorPixels"], v)}
        />
      </div>

    </div>
  );
}

/* -------- Pins tab - Actions[0].streamData.actionData.pins ------------ *
 *
 * Two sub-sections in the JSON:
 *
 *   pins.control.subsignals[]   - array of {name, pin, direction, invert?}
 *                                 plus an attrs.IO_STANDARD string.
 *   pins.data                   - {pins: "B2 C4 ...", direction, attrs.*}
 *
 * The control sub-signals come from a fixed catalogue (the six bus
 * strobes plus d_clock) - their *names* are dictated by BusController
 * and shouldn't be edited at runtime. We render `name` as a read-only
 * label, `pin` as a text input, `direction` as a select, and `invert`
 * as a sliding switch.
 *
 * Adding rows is intentionally NOT supported: build_iobeam_resources()
 * silently skips entries whose `name` isn't on the catalogue. Removing
 * them would just shift the maintenance burden onto the JSON without
 * any UI benefit. Operators who need an extra strobe edit the file
 * directly.
 * --------------------------------------------------------------------- */
function PinsTab({ draft, disabled = false }: { draft: unknown; disabled?: boolean }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();

  // The control list: read the array, render rows, write back through
  // writePath at the per-cell granularity. Defaulting to [] keeps the
  // tab usable on a malformed config that's missing this sub-tree.
  const subsignalsRaw = readPath(draft, [...PINS_PATH, "control", "subsignals"]);
  const subsignals: ControlSubsignal[] = Array.isArray(subsignalsRaw)
    ? (subsignalsRaw as ControlSubsignal[])
    : [];

  const controlIoStd = stringField(
    draft, [...PINS_PATH, "control", "attrs", "IO_STANDARD"], "SB_LVCMOS33"
  );
  const dataPins = stringField(draft, [...PINS_PATH, "data", "pins"], "");
  const dataDirection = stringField(draft, [...PINS_PATH, "data", "direction"], "io");
  const dataIoStd = stringField(
    draft, [...PINS_PATH, "data", "attrs", "IO_STANDARD"], "SB_LVCMOS33"
  );

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    dispatch(setDraft(writePath(draft, p, v)));
  }

  // Update a single field of one subsignal. We write back at the
  // most-specific path (e.g. ...subsignals[3].pin) so writePath's
  // ancestor cloning stays shallow.
  function setSubsignalField(
    index: number,
    field: "pin" | "direction" | "invert",
    value: string | boolean,
  ) {
    set([...PINS_PATH, "control", "subsignals", index, field], value);
  }

  return (
    <div className="settings-form">
      <h4 className="settings-form__group">{t("settings.pins.group.control")}</h4>
      <p className="settings-form__hint">{t("settings.pins.group.controlHint")}</p>

      <div className="settings-pins-table" role="table">
        <div className="settings-pins-table__head" role="row">
          <span role="columnheader">{t("settings.pins.col.name")}</span>
          <span role="columnheader">{t("settings.pins.col.pin")}</span>
          <span role="columnheader">{t("settings.pins.col.direction")}</span>
          <span role="columnheader">{t("settings.pins.col.invert")}</span>
        </div>
        {subsignals.map((row, i) => (
          <div
            key={(row && row.name) || `subsignal-${i}`}
            className="settings-pins-table__row"
            role="row"
          >
            <span className="settings-pins-table__name mono" role="cell">
              {row?.name ?? `(unnamed ${i})`}
            </span>
            <input
              type="text"
              className="input"
              role="cell"
              value={typeof row?.pin === "string" ? row.pin : ""}
              placeholder=""
              disabled={disabled}
              onChange={(e) => setSubsignalField(i, "pin", e.target.value)}
            />
            <select
              className="select"
              role="cell"
              value={typeof row?.direction === "string" ? row.direction : "o"}
              disabled={disabled}
              onChange={(e) => setSubsignalField(i, "direction", e.target.value)}
            >
              <option value="o">{t("settings.pins.dir.o")}</option>
              <option value="i">{t("settings.pins.dir.i")}</option>
              <option value="io">{t("settings.pins.dir.io")}</option>
              <option value="oe">{t("settings.pins.dir.oe")}</option>
            </select>
            <label
              className="vacuum-switch settings-switch settings-switch--table"
              role="cell"
            >
              <input
                type="checkbox"
                aria-label={`${row?.name ?? `subsignal ${i + 1}`} ${t("settings.pins.col.invert")}`}
                checked={Boolean(row?.invert)}
                disabled={disabled}
                onChange={(e) => setSubsignalField(i, "invert", e.target.checked)}
              />
              <span className="vacuum-switch__track">
                <span className="vacuum-switch__thumb" />
              </span>
            </label>
          </div>
        ))}
      </div>

      <div className="field-row">
        <TextField
          label={t("settings.pins.control.attrs.ioStandard")}
          value={controlIoStd}
          disabled={disabled}
          onChange={(v) => set([...PINS_PATH, "control", "attrs", "IO_STANDARD"], v)}
        />
      </div>

      <h4 className="settings-form__group">{t("settings.pins.group.data")}</h4>
      <p className="settings-form__hint">{t("settings.pins.group.dataHint")}</p>

      <div className="field-row">
        <TextField
          label={t("settings.pins.data.pins")}
          value={dataPins}
          disabled={disabled}
          onChange={(v) => set([...PINS_PATH, "data", "pins"], v)}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label>{t("settings.pins.data.direction")}</label>
          <select
            className="select"
            value={dataDirection}
            disabled={disabled}
            onChange={(e) => set([...PINS_PATH, "data", "direction"], e.target.value)}
          >
            <option value="o">{t("settings.pins.dir.o")}</option>
            <option value="i">{t("settings.pins.dir.i")}</option>
            <option value="io">{t("settings.pins.dir.io")}</option>
            <option value="oe">{t("settings.pins.dir.oe")}</option>
          </select>
        </div>
        <TextField
          label={t("settings.pins.data.attrs.ioStandard")}
          value={dataIoStd}
          disabled={disabled}
          onChange={(v) => set([...PINS_PATH, "data", "attrs", "IO_STANDARD"], v)}
        />
      </div>
    </div>
  );
}

interface ControlSubsignal {
  name?: string;
  pin?: string;
  direction?: string;
  invert?: boolean;
}

/* -------- Simulation tab ----------------------------------------------- *
 *
 * Edits actionData.simulation. The block carries TWO orthogonal axes:
 *
 *   mode    = what fills the ADC data line when no real PCB is attached:
 *               "image"    -> FakeAdcSimulator drives data_i from BRAM
 *               "zeros"    -> tie data_i to zero (no BRAM)
 *               "loopback" -> coord-loopback (data_i echoes DAC code)
 *
 *   source  = where the image bytes come from. Only meaningful when
 *             mode == "image":
 *               "pattern"  -> built-in: ramp / checker / bars / bullseye
 *               "file"     -> load filePath as PNG/BMP/JPG
 *               "random"   -> RNG-fill, seeded by `seed`
 *
 * Per-source fields (patternKind / invert / seed) appear
 * conditionally under the source picker. The source picker itself is
 * disabled when mode != "image" because picking an image source has
 * no effect outside image mode.
 *
 * This consolidates the old _alt_file / _alt_random overlay layout
 * into flat keys. The python `imageSource.get_image_data` still
 * understands the legacy shape, so writing back the new shape is a
 * one-way migration without breaking older configs in the wild.
 * --------------------------------------------------------------------- */
function SimulationTab({
  simulation,
  onSimulationChange,
}: {
  simulation: Record<string, unknown>;
  onSimulationChange: (simulation: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();

  const enabled = boolField(simulation, ["enabled"], true);
  const mode = stringField(simulation, ["mode"], "image");
  const imageResolution = numberField(
    simulation, ["imageResolution"], 64
  );
  const source = stringField(simulation, ["source"], "pattern");
  const patternKind = stringField(
    simulation, ["patternKind"], "bullseye"
  );
  const invert = boolField(simulation, ["invert"], false);
  const seed = numberField(simulation, ["seed"], 0);

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    onSimulationChange(writePath(simulation, p, v) as Record<string, unknown>);
  }

  // Two derived gates. `imageMode` controls whether the source picker
  // even applies, and `source` then picks which per-source field group
  // to show.
  const imageMode = mode === "image";

  return (
    <div className="settings-form">
      <h4 className="settings-form__group">{t("settings.simulation.group.core")}</h4>
      <p className="settings-form__hint">{t("settings.simulation.group.coreHint")}</p>

      <div className="settings-flags">
        <CheckboxField
          label={t("settings.simulation.enabled")}
          help={<SettingsHelp topic="simulationEnabled" />}
          value={enabled}
          onChange={(v) => set(["enabled"], v)}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <FieldLabel label={t("settings.simulation.mode")} help={<SettingsHelp topic="simulationMode" />} />
          <select
            className="select"
            value={mode}
            onChange={(e) => set(["mode"], e.target.value)}
          >
            <option value="image">{t("settings.simulation.mode.image")}</option>
            <option value="zeros">{t("settings.simulation.mode.zeros")}</option>
            <option value="loopback">{t("settings.simulation.mode.loopback")}</option>
          </select>
        </div>
        <NumberField
          label={t("settings.simulation.imageResolution")}
          help={<SettingsHelp topic="simulationResolution" />}
          value={imageResolution}
          onChange={(v) => set(["imageResolution"], v)}
        />
      </div>

      <h4 className="settings-form__group">{t("settings.simulation.group.source")}</h4>

      {/* Source picker is greyed out when mode!="image". We keep the
          current value selected in the JSON regardless - if the user
          flips back to image mode the previous choice is still there. */}
      <div className="field-row">
        <div className="field">
          <FieldLabel label={t("settings.simulation.source")} help={<SettingsHelp topic="simulationSource" />} />
          <select
            className="select"
            value={source}
            disabled={!imageMode}
            onChange={(e) => set(["source"], e.target.value)}
          >
            <option value="pattern">{t("settings.simulation.source.pattern")}</option>
            <option value="file">{t("settings.simulation.source.file")}</option>
            <option value="random">{t("settings.simulation.source.random")}</option>
          </select>
        </div>
      </div>

      {imageMode && source === "pattern" && (
        <div className="field-row">
        <div className="field">
            <FieldLabel label={t("settings.simulation.patternKind")} help={<SettingsHelp topic="simulationPattern" />} />
            <select
              className="select"
              value={patternKind}
              onChange={(e) =>
                set(["patternKind"], e.target.value)
              }
            >
              <option value="ramp">{t("settings.simulation.patternKind.ramp")}</option>
              <option value="checker">{t("settings.simulation.patternKind.checker")}</option>
              <option value="bars">{t("settings.simulation.patternKind.bars")}</option>
              <option value="bullseye">{t("settings.simulation.patternKind.bullseye")}</option>
            </select>
          </div>
        </div>
      )}

      {imageMode && source === "file" && (
        <div className="settings-flags">
          <CheckboxField
            label={t("settings.simulation.invert")}
            help={<SettingsHelp topic="simulationInvert" />}
            value={invert}
            onChange={(v) => set(["invert"], v)}
          />
        </div>
      )}

      {imageMode && source === "random" && (
        <div className="field-row">
          <NumberField
            label={t("settings.simulation.seed")}
            help={<SettingsHelp topic="simulationSeed" />}
            value={seed}
            onChange={(v) => set(["seed"], v)}
          />
        </div>
      )}
    </div>
  );
}

function FtpTab({
  draft,
  disabled = false,
  onChangeDraft,
}: {
  draft: unknown;
  disabled?: boolean;
  onChangeDraft?: (next: unknown) => void;
}) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const [passwordVisible, setPasswordVisible] = useState(false);

  const enabled = boolField(draft, [...FTP_PATH, "enabled"], true);
  const host = stringField(draft, [...FTP_PATH, "host"], "localhost");
  const username = stringField(draft, [...FTP_PATH, "username"], "vboxuser");
  const password = stringField(draft, [...FTP_PATH, "password"], "ionbeam123");
  const folder = stringField(draft, [...FTP_PATH, "folder"], "/tmp/ftp");

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    const next = writePath(draft, p, v);
    if (onChangeDraft) {
      onChangeDraft(next);
      return;
    }
    dispatch(setDraft(next));
  }

  return (
    <div className="settings-form">
      <p className="settings-form__hint">{t("settings.ftp.hint")}</p>
      {disabled && (
        <p className="settings-form__hint" style={{ color: "var(--c-danger)" }}>
          {t("settings.admin.privilegeRequired")}
        </p>
      )}

      <div className="settings-flags">
        <CheckboxField
          label={t("settings.ftp.enabled")}
          value={enabled}
          onChange={(v) => set([...FTP_PATH, "enabled"], v)}
        />
      </div>

      <h4 className="settings-form__group">{t("settings.ftp.group.connection")}</h4>
      <div className="field-row">
        <TextField
          label={t("settings.ftp.host")}
          value={host}
          disabled={disabled || !enabled}
          onChange={(v) => set([...FTP_PATH, "host"], v)}
        />
        <TextField
          label={t("settings.ftp.username")}
          value={username}
          disabled={disabled || !enabled}
          onChange={(v) => set([...FTP_PATH, "username"], v)}
        />
      </div>

      <div className="field-row">
        <PasswordField
          label={t("settings.ftp.password")}
          value={password}
          visible={passwordVisible}
          configured={false}
          revealLabel={t("settings.admin.db.password.show")}
          disabled={disabled || !enabled}
          onReveal={() => setPasswordVisible(true)}
          onHide={() => setPasswordVisible(false)}
          onChange={(v) => set([...FTP_PATH, "password"], v)}
        />
      </div>

      <h4 className="settings-form__group">{t("settings.ftp.group.destination")}</h4>
      <div className="field-row">
        <TextField
          label={t("settings.ftp.folder")}
          value={folder}
          disabled={disabled || !enabled}
          onChange={(v) => set([...FTP_PATH, "folder"], v)}
        />
      </div>
    </div>
  );
}

async function fetchAdminConfig(): Promise<SettingsConfigInfo> {
  const r = await fetch(apiUrl("/api/admin/iobeam/config"));
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`fetch admin config: HTTP ${r.status} ${text}`);
  }
  return await readJsonResponse<SettingsConfigInfo>(r, "fetch admin config");
}

async function saveAdminConfig(data: unknown): Promise<void> {
  const r = await fetch(apiUrl("/api/admin/iobeam/config"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
    body: JSON.stringify({ data }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`save admin config: HTTP ${r.status} ${text}`);
  }
}

async function applyAdminDatabaseSetup(data: unknown): Promise<AdminDatabaseApplyResponse> {
  const r = await fetch(apiUrl("/api/admin/iobeam/db/apply"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
    body: JSON.stringify({ data }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`apply admin database setup: HTTP ${r.status} ${text}`);
  }
  return await readJsonResponse<AdminDatabaseApplyResponse>(r, "apply admin database setup");
}

async function fetchAdminDatabaseConnection(includePassword = false): Promise<AdminDatabaseConnectionResponse> {
  const qs = includePassword ? "?include_password=1" : "";
  const r = await fetch(apiUrl(`/api/admin/iobeam/db/connection${qs}`), {
    headers: scanAuthHeaders(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`fetch admin database connection: HTTP ${r.status} ${text}`);
  }
  return await readJsonResponse<AdminDatabaseConnectionResponse>(r, "fetch admin database connection");
}

async function restoreAdminConfig(): Promise<void> {
  const r = await fetch(apiUrl("/api/admin/iobeam/config/restore"), { method: "POST" });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`restore admin config: HTTP ${r.status} ${text}`);
  }
}

async function fetchStreamConfig(): Promise<SettingsConfigInfo> {
  const r = await fetch(apiUrl("/api/admin/config"));
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`fetch stream config: HTTP ${r.status} ${text}`);
  }
  return await readJsonResponse<SettingsConfigInfo>(r, "fetch stream config");
}

async function saveStreamConfig(data: unknown): Promise<void> {
  const r = await fetch(apiUrl("/api/admin/config"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
    body: JSON.stringify({ data }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`save stream config: HTTP ${r.status} ${text}`);
  }
}

function normalizeStreamConfigDwell(config: unknown): unknown {
  return writePath(
    writePath(config, [...ACTION_DATA_PATH, "rasterScan", "dwell"], 16),
    [...ACTION_DATA_PATH, "vectorScan", "dwell"],
    16,
  );
}

async function restoreStreamConfig(): Promise<void> {
  const r = await fetch(apiUrl("/api/admin/config/restore"), {
    method: "POST",
    headers: scanAuthHeaders(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`restore stream config: HTTP ${r.status} ${text}`);
  }
}

function writeAdminDatabaseConnection(
  data: unknown,
  connection: AdminDatabaseConnectionResponse["connection"],
  includePassword: boolean,
): unknown {
  let next = writePath(data, ["Database", "Host"], connection.host);
  next = writePath(next, ["Database", "Port"], connection.port);
  next = writePath(next, ["Database", "DatabaseName"], connection.database);
  next = writePath(next, ["Database", "User"], connection.user);
  next = writePath(next, ["Database", "SslMode"], connection.sslMode);
  next = writePath(next, ["Database", "ConnectionString"], connection.connectionString);
  next = writePath(next, ["Database", "CommandTimeoutMs"], connection.commandTimeoutMs);
  if (includePassword) {
    next = writePath(next, ["Database", "Password"], connection.password ?? "");
  }
  return next;
}

interface AdminUserRow {
  id: number | null;
  login_name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  company_name: string;
  site: string;
  role: number;
  is_active: boolean;
  session_lifetime_limit_days: number;
}

interface AuditorRow {
  email: string;
  is_active: boolean;
}

interface CurrentAccountResponse {
  ok: boolean;
  user: { role?: number } | null;
}

interface AdminDatabaseApplyResponse {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
}

interface AdminDatabaseConnectionResponse {
  ok: boolean;
  connection: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string | null;
    password_configured: boolean;
    sslMode: string;
    connectionString: string;
    commandTimeoutMs: number;
  };
}

interface AllowedHostsResponse {
  ok: boolean;
  hosts: string[];
  error?: string;
  sync_warning?: string;
}

interface FtpConnectionResponse {
  ok: boolean;
  enabled: boolean;
  reachable: boolean;
  message?: string;
  error?: string;
}

const ADMIN_ROLE_OPTIONS = [
  { value: 4, key: "settings.admin.role.audit" },
  { value: 3, key: "settings.admin.role.admin" },
  { value: 2, key: "settings.admin.role.developer" },
  { value: 1, key: "settings.admin.role.superUser" },
  { value: 0, key: "settings.admin.role.user" },
] satisfies ReadonlyArray<{ value: number; key: TranslationKey }>;

const ADMIN_ROLE = 3;
const AUDITOR_ROLE = 4;
type AdminSubTab = "configuration" | "users" | "equipment" | "calibration" | "allowedHosts" | "ftp";

function emptyAdminUser(nextId: number): AdminUserRow {
  return {
    id: nextId,
    login_name: "",
    first_name: "",
    last_name: "",
    email: "",
    phone_number: "",
    company_name: "",
    site: DEFAULT_SITE,
    role: 0,
    is_active: true,
    session_lifetime_limit_days: 1,
  };
}

function withEquipmentRows(data: unknown, equipment: EquipmentRow[]): unknown {
  const next = writePath(data, ["equipments"], equipment);
  return writePath(next, ["equipment"], equipment[0] ?? emptyEquipment(1));
}

function adminUsersFromDraft(draft: unknown): AdminUserRow[] {
  const users = readPath(draft, ["users"]);
  const rawUsers = Array.isArray(users)
    ? users
    : readPath(draft, ["user"]) && typeof readPath(draft, ["user"]) === "object"
      ? [readPath(draft, ["user"])]
      : [];

  return rawUsers
    .filter((u): u is Record<string, unknown> => Boolean(u) && typeof u === "object")
    .map((u, index) => ({
      id: typeof u.id === "number" ? u.id : index + 1,
      login_name: String(u.login_name ?? ""),
      first_name: String(u.first_name ?? ""),
      last_name: String(u.last_name ?? ""),
      email: String(u.email ?? ""),
      phone_number: String(u.phone_number ?? ""),
      company_name: String(u.company_name ?? ""),
      site: normalizeSiteValue(u.site ?? u.geography ?? u.geo ?? u.geo_site),
      role: typeof u.role === "number" ? u.role : Number(u.role ?? 0),
      is_active: typeof u.is_active === "boolean" ? u.is_active : true,
      session_lifetime_limit_days: positiveIntField(
        u.session_lifetime_limit_days,
        1,
      ),
    }));
}

function auditorsFromDraft(draft: unknown): AuditorRow[] {
  const auditors = readPath(draft, ["auditors"]);
  const rawAuditors = Array.isArray(auditors)
    ? auditors
    : readPath(draft, ["auditor"]) && typeof readPath(draft, ["auditor"]) === "object"
      ? [readPath(draft, ["auditor"])]
      : [];

  return rawAuditors
    .filter((u): u is Record<string, unknown> => Boolean(u) && typeof u === "object")
    .map((u) => ({
      email: String(u.email ?? ""),
      is_active: typeof u.is_active === "boolean" ? u.is_active : true,
    }));
}

const DEFAULT_ALLOWED_HOSTS = ["localhost", "ion.o-0.top"];
const ALLOWED_HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const ALLOWED_IPV4_RE =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function normalizeAllowedHostList(hosts: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const host of hosts) {
    const value = String(host ?? "").trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_ALLOWED_HOSTS];
}

function validateAllowedHostList(hosts: string[]): string[] {
  const invalid: string[] = [];
  for (const host of hosts) {
    if (!isValidAllowedHost(host)) invalid.push(host);
  }
  return invalid;
}

function parseAllowedHostsText(text: string): string[] {
  return normalizeAllowedHostList(
    text
      .split(/[\r\n,]+/)
      .map((host) => host.trim())
      .filter((host) => host.length > 0),
  );
}

function isValidAllowedHost(host: string): boolean {
  const value = String(host ?? "").trim().toLowerCase();
  if (!value || value.length > 253) return false;
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("@") ||
    value.includes("#") ||
    value.includes("?") ||
    value.includes("*") ||
    value.includes(" ")
  ) {
    return false;
  }
  if (value === "localhost") return true;
  if (ALLOWED_IPV4_RE.test(value)) return true;

  const labels = value.split(".");
  if (labels.length === 0) return false;
  return labels.every((label) => label.length > 0 && label.length <= 63 && ALLOWED_HOSTNAME_LABEL_RE.test(label));
}

function adminUserRowKey(user: AdminUserRow, index: number): string {
  if (user.id !== null) return `id:${user.id}`;
  const login = user.login_name.trim().toLowerCase();
  if (login) return `login:${login}`;
  return `index:${index}`;
}

function adminUserRowSignature(user: AdminUserRow): string {
  return JSON.stringify(user);
}

function adminRoleApprovalRecipients(draft: unknown): string[] {
  const emails = new Set<string>();
  auditorsFromDraft(draft)
    .filter((auditor) => auditor.is_active)
    .forEach((auditor) => {
      const email = auditor.email.trim();
      if (email) emails.add(email);
    });
  adminUsersFromDraft(draft)
    .filter((user) => user.is_active && user.role >= AUDITOR_ROLE)
    .forEach((user) => {
      const email = user.email.trim();
      if (email) emails.add(email);
    });
  return [...emails];
}

function adminRoleApprovalRequired(source: unknown, draft: unknown): boolean {
  const previousRoleByKey = new Map(
    adminUsersFromDraft(source).map((user, index) => [
      adminUserRowKey(user, index),
      user.role,
    ] as const),
  );

  return adminUsersFromDraft(draft).some((user, index) => {
    const previousRole = previousRoleByKey.get(adminUserRowKey(user, index)) ?? 0;
    return user.role === ADMIN_ROLE && previousRole < ADMIN_ROLE;
  });
}

function adminRoleRequestLink(user: AdminUserRow): string {
  const url = new URL(`${window.location.origin}/`);
  url.searchParams.set("settings", "admin");
  if (user.id !== null) {
    url.searchParams.set("account_id", String(user.id));
  } else if (user.login_name.trim()) {
    url.searchParams.set("login", user.login_name.trim());
  }
  return url.toString();
}

function composeAdminRoleRequestEmail(user: AdminUserRow, recipients: string[]) {
  const subject = `Admin role approval request: ${user.login_name || user.email || "account"}`;
  const lines = [
    "Please review and approve this account update request.",
    "",
    `Requested role: Admin`,
    `Account: ${user.login_name || "(not set)"}`,
    `Name: ${[user.first_name, user.last_name].filter(Boolean).join(" ") || "(not set)"}`,
    `Email: ${user.email || "(not set)"}`,
    `Site: ${user.site || "(not set)"}`,
    "",
    `Update request link: ${adminRoleRequestLink(user)}`,
  ];
  const mailto = new URL(`mailto:${recipients.join(",")}`);
  mailto.searchParams.set("subject", subject);
  mailto.searchParams.set("body", lines.join("\n"));
  window.location.href = mailto.toString();
}

async function fetchCurrentAccountRole(): Promise<number | null> {
  const r = await fetch(apiUrl("/api/admin/iobeam/auth/current-account"), {
    headers: scanAuthHeaders(),
  });
  if (!r.ok) return null;
  const data = await readJsonResponse<CurrentAccountResponse>(r, "current account");
  return typeof data.user?.role === "number" ? data.user.role : null;
}

function AdminTab({
  targetAccountId,
  targetLogin,
  activeSubTab,
  onSelectSubTab,
  mobilityMode,
}: {
  targetAccountId: number | null;
  targetLogin: string | null;
  activeSubTab: AdminSubTab;
  onSelectSubTab: (tab: AdminSubTab) => void;
  mobilityMode: boolean;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<unknown | null>(null);
  const [draft, setDraftLocal] = useState<unknown | null>(null);
  const [configPath, setConfigPath] = useState("");
  const [hasBackup, setHasBackup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [dbApplying, setDbApplying] = useState(false);
  const [error, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [privilegeNotice, setPrivilegeNotice] = useState<string | null>(null);
  const equipmentCsvInputRef = useRef<HTMLInputElement | null>(null);
  const [equipmentCsvBusy, setEquipmentCsvBusy] = useState(false);
  const [currentAccountRole, setCurrentAccountRole] = useState<number | null>(null);
  const [dbPasswordVisible, setDbPasswordVisible] = useState(false);
  const [dbPasswordConfigured, setDbPasswordConfigured] = useState(false);
  const [ftpSource, setFtpSource] = useState<unknown | null>(null);
  const [ftpDraft, setFtpDraft] = useState<unknown | null>(null);
  const [ftpConfigPath, setFtpConfigPath] = useState("");
  const [ftpHasBackup, setFtpHasBackup] = useState(false);
  const [ftpLoading, setFtpLoading] = useState(false);
  const [ftpSaving, setFtpSaving] = useState(false);
  const [ftpRestoring, setFtpRestoring] = useState(false);
  const [ftpConnectionState, setFtpConnectionState] = useState<"idle" | "checking" | "ok" | "warn" | "error">("idle");
  const [ftpConnectionMessage, setFtpConnectionMessage] = useState<string | null>(null);
  const privilegeNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showPrivilegeNotice() {
    setNotice(null);
    setPrivilegeNotice(t("settings.admin.privilegeRequired"));
    if (privilegeNoticeTimer.current) clearTimeout(privilegeNoticeTimer.current);
    privilegeNoticeTimer.current = setTimeout(() => {
      setPrivilegeNotice(null);
      privilegeNoticeTimer.current = null;
    }, 3500);
  }

  useEffect(() => {
    return () => {
      if (privilegeNoticeTimer.current) clearTimeout(privilegeNoticeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (mobilityMode && (activeSubTab === "configuration" || activeSubTab === "calibration")) {
      onSelectSubTab("users");
    }
  }, [activeSubTab, mobilityMode, onSelectSubTab]);

  useEffect(() => {
    if (activeSubTab !== "ftp" || ftpDraft !== null || ftpLoading) {
      return;
    }
    void loadFtp();
  }, [activeSubTab, ftpDraft, ftpLoading]);

  async function load() {
    setLoading(true);
    setLocalError(null);
    try {
      const info = await fetchAdminConfig();
      const accountRole = await fetchCurrentAccountRole();
      let data = info.data;
      const dbConnection = await fetchAdminDatabaseConnection(false).catch(() => null);
      if (dbConnection?.ok) {
        data = writeAdminDatabaseConnection(data, dbConnection.connection, false);
        setDbPasswordConfigured(dbConnection.connection.password_configured);
      }
      setSource(info.data);
      setDraftLocal(data);
      setConfigPath(info.path);
      setHasBackup(info.has_backup);
      setCurrentAccountRole(accountRole);
      setDbPasswordVisible(false);
      setNotice(info.backup_created ? t("settings.admin.backupCreated") : null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadFtp() {
    setFtpLoading(true);
    setLocalError(null);
    try {
      const info = await fetchStreamConfig();
      const normalized = normalizeStreamConfigDwell(info.data);
      setFtpSource(normalized);
      setFtpDraft(normalized);
      setFtpConfigPath(info.path);
      setFtpHasBackup(info.has_backup);
      if (info.backup_created) {
        setNotice(t("settings.backupCreated"));
      }
      await testFtpConnection();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setFtpLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    if (draft === null) return;
    setDraftLocal(writePath(draft, p, v));
  }

  function setUsers(users: AdminUserRow[]) {
    if (draft === null) return;
    const next = writePath(draft, ["users"], users);
    setDraftLocal(writePath(next, ["user"], users[0] ?? emptyAdminUser(1)));
  }

  function updateUser(index: number, field: keyof AdminUserRow, value: string | number | boolean | null) {
    const users = adminUsersFromDraft(draft);
    const next = users.map((user, rowIndex) =>
      rowIndex === index ? { ...user, [field]: value } : user
    );
    setUsers(next);
  }

  function addUser() {
    const users = adminUsersFromDraft(draft);
    const maxId = users.reduce((max, user) => Math.max(max, user.id ?? 0), 0);
    setUsers([...users, emptyAdminUser(maxId + 1)]);
  }

  function deleteUser(index: number) {
    setUsers(adminUsersFromDraft(draft).filter((_user, rowIndex) => rowIndex !== index));
  }

  function setEquipment(equipment: EquipmentRow[]) {
    if (draft === null) return;
    const next = writePath(draft, ["equipments"], equipment);
    setDraftLocal(writePath(next, ["equipment"], equipment[0] ?? emptyEquipment(1)));
  }

  function updateEquipment(index: number, field: keyof EquipmentRow, value: string | number | null) {
    const equipment = equipmentFromDraft(draft);
    const next = equipment.map((row, rowIndex) =>
      rowIndex === index ? { ...row, [field]: value } : row
    );
    setEquipment(next);
  }

  function addEquipment() {
    const equipment = equipmentFromDraft(draft);
    const maxId = equipment.reduce((max, row) => Math.max(max, row.id ?? 0), 0);
    setEquipment([...equipment, emptyEquipment(maxId + 1)]);
  }

  function deleteEquipment(index: number) {
    setEquipment(equipmentFromDraft(draft).filter((_row, rowIndex) => rowIndex !== index));
  }

  async function exportEquipmentCsv() {
    if (!canManageAdminConfig) {
      showPrivilegeNotice();
      return;
    }
    setEquipmentCsvBusy(true);
    setLocalError(null);
    try {
      const response = await fetch(apiUrl("/api/admin/iobeam/equipment/export.csv"), {
        headers: scanAuthHeaders(),
      });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "equipment.csv";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setLocalError(t("settings.admin.equipment.export.error", {
        detail: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setEquipmentCsvBusy(false);
    }
  }

  async function importEquipmentCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!canManageAdminConfig) {
      showPrivilegeNotice();
      return;
    }
    if (busy || equipmentCsvBusy) return;

    setEquipmentCsvBusy(true);
    setLocalError(null);
    setNotice(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("The CSV exceeds the 10 MB file limit.");
      const imported = parseEquipmentCsv(await file.text());
      const existingEquipment = equipmentFromDraft(draft);
      for (const [index, row] of imported.entries()) {
        const existing = existingEquipment.find((candidate) =>
          (row.id != null && candidate.id === row.id) ||
          candidate.serial_number.trim().toLowerCase() === row.serial_number.trim().toLowerCase(),
        );
        if (!existing && !SITE_OPTIONS.some((option) => option.value === row.site)) {
          throw new Error(`Row ${index + 2} needs a supported Site when adding new equipment.`);
        }
      }
      if (!window.confirm(t("settings.admin.equipment.import.confirm", {
        rows: imported.length,
        file: file.name,
      }))) return;
      const response = await fetch(apiUrl("/api/admin/iobeam/equipment/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
        body: JSON.stringify({ equipment: imported }),
      });
      const result = await readJsonResponse<{
        ok?: boolean;
        equipment?: EquipmentRow[];
        added?: number;
        updated?: number;
        error?: string;
      }>(response, "equipment CSV import");
      if (!response.ok || !Array.isArray(result.equipment)) {
        throw new Error(result.error ?? `HTTP ${response.status}`);
      }
      setEquipment(result.equipment);
      if (source !== null) setSource(withEquipmentRows(source, result.equipment));
      setNotice(t("settings.admin.equipment.import.ok", {
        added: result.added ?? 0,
        updated: result.updated ?? 0,
      }));
    } catch (err) {
      setLocalError(t("settings.admin.equipment.import.error", {
        detail: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setEquipmentCsvBusy(false);
    }
  }

  async function onSave(nextDraft: unknown = draft) {
    if (nextDraft === null || nextDraft === undefined) return;
    setSaving(true);
    setLocalError(null);
    setNotice(null);
    try {
      await saveAdminConfig(nextDraft);
      setSource(nextDraft);
      setNotice(t("settings.admin.save.ok"));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onRestore() {
    setRestoring(true);
    setLocalError(null);
    setNotice(null);
    try {
      await restoreAdminConfig();
      await load();
      setNotice(t("settings.admin.restore.ok"));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(false);
    }
  }

  async function onApplyDatabase() {
    if (draft === null) return;
    setDbApplying(true);
    setLocalError(null);
    setNotice(null);
    try {
      const result = await applyAdminDatabaseSetup(draft);
      setSource(draft);
      setNotice(t("settings.admin.db.apply.ok", { steps: result.steps.map((step) => step.name).join(", ") }));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setDbApplying(false);
    }
  }

  async function onSaveFtp() {
    if (ftpDraft === null) return;
    setFtpSaving(true);
    setLocalError(null);
    setNotice(null);
    try {
      const normalized = normalizeStreamConfigDwell(ftpDraft);
      await saveStreamConfig(normalized);
      setFtpSource(normalized);
      setFtpDraft(normalized);
      setNotice(t("settings.ftp.save.ok"));
      await testFtpConnection();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setFtpSaving(false);
    }
  }

  async function onRestoreFtp() {
    setFtpRestoring(true);
    setLocalError(null);
    setNotice(null);
    try {
      await restoreStreamConfig();
      await loadFtp();
      setNotice(t("settings.ftp.restore.ok"));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setFtpRestoring(false);
    }
  }

  async function testFtpConnection() {
    setFtpConnectionState("checking");
    setFtpConnectionMessage(t("settings.ftp.testing"));
    try {
      const r = await fetch(apiUrl("/api/admin/ftp/test-connection"), {
        headers: scanAuthHeaders(),
      });
      const data = (await r.json().catch(() => null)) as FtpConnectionResponse | null;
      if (!r.ok || !data?.ok) {
        throw new Error(data?.message || data?.error || `HTTP ${r.status}`);
      }
      if (!data.enabled) {
        setFtpConnectionState("idle");
        setFtpConnectionMessage(t("settings.ftp.disabled"));
        return;
      }
      if (data.reachable) {
        setFtpConnectionState("ok");
        setFtpConnectionMessage(data.message || t("settings.ftp.reachable"));
      } else {
        setFtpConnectionState("warn");
        setFtpConnectionMessage(data.message || t("settings.ftp.unreachable"));
      }
    } catch (err) {
      setFtpConnectionState("error");
      setFtpConnectionMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function onRevealDbPassword() {
    if (draft === null) return;
    if (!canManageAdminConfig) {
      showPrivilegeNotice();
      return;
    }
    try {
      const dbConnection = await fetchAdminDatabaseConnection(true);
      setDraftLocal(writeAdminDatabaseConnection(draft, dbConnection.connection, true));
      setDbPasswordVisible(true);
      setDbPasswordConfigured(dbConnection.connection.password_configured);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  }

  function onHideDbPassword() {
    setDbPasswordVisible(false);
  }

  const busy = loading || saving || restoring || dbApplying;
  const dirty = draft !== null && draft !== source;
  const canManageAdminConfig = currentAccountRole !== null && currentAccountRole >= ADMIN_ROLE;
  const adminApprovalRequired =
    currentAccountRole !== null &&
    currentAccountRole < ADMIN_ROLE &&
    adminRoleApprovalRequired(source, draft);
  const ftpBusy = ftpLoading || ftpSaving || ftpRestoring;
  const ftpDirty = ftpDraft !== null && ftpDraft !== ftpSource;
  const ftpNoticeTone =
    ftpConnectionState === "error"
      ? "error"
      : ftpConnectionState === "warn"
        ? "warning"
        : ftpConnectionState === "ok"
          ? "success"
          : "info";

  if (loading && draft === null) {
    return <LoadingSpinner className="settings-loading" label={t("settings.admin.loading")} />;
  }

  if (draft === null) {
    return <div className="settings-loading">{t("settings.admin.empty")}</div>;
  }

  return (
    <div className="settings-form">
      {!mobilityMode && configPath && (
        <div className="settings-path-strip" title={configPath}>
          <span className="settings-path-strip__label">
            {t("settings.admin.boundTo")}
          </span>
          <code className="settings-path-strip__path">{configPath}</code>
        </div>
      )}

      {notice && (
        <SettingsNotice
          tone="success"
          message={notice}
          onDismiss={() => setNotice(null)}
        />
      )}
      {error && (
        <SettingsNotice
          tone="error"
          message={error}
          onDismiss={() => setLocalError(null)}
        />
      )}
      {privilegeNotice && (
        <SettingsNotice
          tone="error"
          volatile
          message={privilegeNotice}
          onDismiss={() => setPrivilegeNotice(null)}
        />
      )}

      <div className="settings-admin-subtabs" role="tablist" aria-label={t("settings.admin.subtabs.aria")}>
        <AdminSubTabButton
          tab="users"
          active={activeSubTab}
          label={t("settings.admin.group.users")}
          onSelect={onSelectSubTab}
        />
        <AdminSubTabButton
          tab="equipment"
          active={activeSubTab}
          label={t("settings.admin.group.equipment")}
          onSelect={onSelectSubTab}
        />
        {!mobilityMode && (
          <AdminSubTabButton
            tab="calibration"
            active={activeSubTab}
            label={t("settings.admin.group.calibration")}
            onSelect={onSelectSubTab}
          />
        )}
        {!mobilityMode && (
          <AdminSubTabButton
            tab="configuration"
            active={activeSubTab}
            label={t("settings.admin.group.configuration")}
            onSelect={onSelectSubTab}
          />
        )}
        <AdminSubTabButton
          tab="allowedHosts"
          active={activeSubTab}
          label={t("settings.admin.group.allowedHosts")}
          onSelect={onSelectSubTab}
        />
        <AdminSubTabButton
          tab="ftp"
          active={activeSubTab}
          label={t("settings.admin.group.ftp")}
          onSelect={onSelectSubTab}
        />
      </div>

      {activeSubTab === "configuration" && !mobilityMode && (
        <>
      <h4 className="settings-form__group">{t("settings.admin.group.header")}</h4>
      <div className="field-row">
        <TextField
          label={t("settings.admin.application")}
          value={stringField(draft, ["Header", "Application"], "")}
          onChange={(v) => set(["Header", "Application"], v)}
        />
        <TextField
          label={t("settings.admin.version")}
          value={stringField(draft, ["Header", "Version"], "")}
          onChange={(v) => set(["Header", "Version"], v)}
        />
      </div>
      <div className="field-row">
        <TextField
          label={t("settings.admin.description")}
          value={stringField(draft, ["Header", "Description"], "")}
          onChange={(v) => set(["Header", "Description"], v)}
        />
      </div>

      <h4 className="settings-form__group">{t("settings.admin.group.database")}</h4>
      <div className="field-row">
        <TextField
          label={t("settings.admin.db.provider")}
          value={stringField(draft, ["Database", "Provider"], "")}
          onChange={(v) => set(["Database", "Provider"], v)}
        />
        <TextField
          label={t("settings.admin.db.name")}
          value={stringField(draft, ["Database", "DatabaseName"], "")}
          onChange={(v) => set(["Database", "DatabaseName"], v)}
        />
      </div>
      <div className="field-row">
        <TextField
          label={t("settings.admin.db.schema")}
          value={stringField(draft, ["Database", "Schema"], "")}
          onChange={(v) => set(["Database", "Schema"], v)}
        />
        <TextField
          label={t("settings.admin.db.host")}
          value={stringField(draft, ["Database", "Host"], "")}
          onChange={(v) => set(["Database", "Host"], v)}
        />
        <NumberField
          label={t("settings.admin.db.port")}
          value={numberField(draft, ["Database", "Port"], 5432)}
          onChange={(v) => set(["Database", "Port"], v)}
        />
      </div>
      <div className="field-row">
        <TextField
          label={t("settings.admin.db.user")}
          value={stringField(draft, ["Database", "User"], "")}
          onChange={(v) => set(["Database", "User"], v)}
        />
        <PasswordField
          label={t("settings.admin.db.password")}
          value={stringField(draft, ["Database", "Password"], "")}
          visible={dbPasswordVisible}
          configured={dbPasswordConfigured}
          revealLabel={t("settings.admin.db.password.show")}
          onReveal={() => void onRevealDbPassword()}
          onHide={onHideDbPassword}
          onChange={(v) => set(["Database", "Password"], v)}
        />
        <TextField
          label={t("settings.admin.db.sslMode")}
          value={stringField(draft, ["Database", "SslMode"], "")}
          onChange={(v) => set(["Database", "SslMode"], v)}
        />
      </div>
      <div className="field-row">
        <TextField
          label={t("settings.admin.db.connectionString")}
          value={stringField(draft, ["Database", "ConnectionString"], "")}
          onChange={(v) => set(["Database", "ConnectionString"], v)}
        />
        <NumberField
          label={t("settings.admin.db.timeout")}
          value={numberField(draft, ["Database", "CommandTimeoutMs"], 30000)}
          onChange={(v) => set(["Database", "CommandTimeoutMs"], v)}
        />
      </div>
      <div className="settings-form__group-row settings-form__group-row--db-apply">
        <span />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            if (!canManageAdminConfig) {
              showPrivilegeNotice();
              return;
            }
            void onApplyDatabase();
          }}
          disabled={busy}
          aria-disabled={!canManageAdminConfig}
          title={t("settings.admin.db.apply.title")}
        >
          <Icon name="tools" />
          {t("settings.admin.db.apply")}
        </button>
      </div>

        </>
      )}

      {activeSubTab === "users" && (
        <>
          <div className="settings-form__group-row">
            <h4 className="settings-form__group">{t("settings.admin.group.users")}</h4>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                if (!canManageAdminConfig) {
                  showPrivilegeNotice();
                  return;
                }
                addUser();
              }}
              disabled={busy}
              aria-disabled={!canManageAdminConfig}
              title={t("settings.admin.user.add.title")}
            >
              <Icon name="upload" tone="accent" />
              {t("settings.admin.user.add")}
            </button>
          </div>
          <UserAccountsGrid
            users={adminUsersFromDraft(draft)}
            sourceUsers={adminUsersFromDraft(source)}
            auditorEmails={adminRoleApprovalRecipients(draft)}
            canApproveAdminRole={currentAccountRole !== null && currentAccountRole >= ADMIN_ROLE}
            disabled={busy || !canManageAdminConfig}
            actionDisabled={busy}
            canManage={canManageAdminConfig}
            siteOptions={SITE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
            roleOptions={ADMIN_ROLE_OPTIONS.map((option) => ({ value: option.value, label: t(option.key) }))}
            onUpdate={updateUser}
            onApplyChanges={async (index, updatedUser) => {
              if (draft === null) return;
              const users = adminUsersFromDraft(draft).map((user, rowIndex) => rowIndex === index ? updatedUser : user);
              const next = writePath(writePath(draft, ["users"], users), ["user"], users[0] ?? emptyAdminUser(1));
              setDraftLocal(next);
              await onSave(next);
            }}
            onDelete={deleteUser}
            onBlockedAction={showPrivilegeNotice}
            onRequestAdminApproval={(user, recipients) => {
              if (recipients.length === 0) {
                setLocalError(t("settings.admin.user.requestAdmin.noAuditors"));
                return;
              }
              composeAdminRoleRequestEmail(user, recipients);
              setNotice(t("settings.admin.user.requestAdmin.composed"));
            }}
          />
        </>
      )}

      {activeSubTab === "equipment" && (
        <>
          <div className="settings-form__group-row">
            <h4 className="settings-form__group">{t("settings.admin.group.equipment")}</h4>
            <div className="button-row">
              <button
                type="button"
                className="btn btn--primary"
                onClick={exportEquipmentCsv}
                disabled={busy || equipmentCsvBusy}
                aria-disabled={!canManageAdminConfig}
                aria-label={t("settings.admin.equipment.export")}
                title={t("settings.admin.equipment.export.title")}
              >
                <Icon name="download" tone="accent" />
                {t("settings.admin.equipment.export.button")}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  if (!canManageAdminConfig) {
                    showPrivilegeNotice();
                    return;
                  }
                  equipmentCsvInputRef.current?.click();
                }}
                disabled={busy || equipmentCsvBusy}
                aria-disabled={!canManageAdminConfig}
                aria-label={t("settings.admin.equipment.import")}
                title={t("settings.admin.equipment.import.title")}
              >
                <Icon name="upload" tone="accent" />
                {t("settings.admin.equipment.import.button")}
              </button>
              <input
                ref={equipmentCsvInputRef}
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={(event) => void importEquipmentCsv(event)}
              />
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  if (!canManageAdminConfig) {
                    showPrivilegeNotice();
                    return;
                  }
                  addEquipment();
                }}
                disabled={busy || equipmentCsvBusy}
                aria-disabled={!canManageAdminConfig}
                title={t("settings.admin.equipment.add.title")}
              >
                <Icon name="upload" tone="accent" />
                {t("settings.admin.equipment.add")}
              </button>
            </div>
          </div>
          <EquipmentGrid
            equipment={equipmentFromDraft(draft)}
            sourceEquipment={equipmentFromDraft(source)}
            disabled={busy || equipmentCsvBusy || !canManageAdminConfig}
            actionDisabled={busy || equipmentCsvBusy}
            canManage={canManageAdminConfig}
            onUpdate={updateEquipment}
            onPersist={() => void onSave()}
            onDelete={deleteEquipment}
            onBlockedAction={showPrivilegeNotice}
          />
        </>
      )}

      {activeSubTab === "calibration" && !mobilityMode && <CalibrationPanel />}

      {activeSubTab === "configuration" && (
        <div className="settings-footer__row">
          <span
            className="scan-busy"
            data-visible={busy ? "true" : "false"}
            aria-hidden={!busy}
          >
            <LoadingSpinner inline size={20} ariaLabel={t("settings.admin.busy")} />
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void load()}
            disabled={busy}
            title={t("settings.admin.reload.title")}
          >
            <Icon name="refresh" tone="accent" />
            {t("settings.reload")}
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--warn"
            disabled={busy || !hasBackup}
            onClick={() => void onRestore()}
            title={t("settings.admin.default.title")}
          >
            <Icon name="refresh" tone="warn" />
            {t("settings.btn.default")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !dirty || adminApprovalRequired}
            aria-disabled={!canManageAdminConfig}
            onClick={() => {
              if (!canManageAdminConfig) {
                showPrivilegeNotice();
                return;
              }
              void onSave();
            }}
            title={t("settings.admin.save.title")}
          >
            <Icon name="download" />
            {t("settings.btn.saveAs")}
          </button>
        </div>
      )}

      {activeSubTab === "allowedHosts" && (
        <AllowedHostsTab
          canManage={canManageAdminConfig}
          onBlockedAction={showPrivilegeNotice}
        />
      )}

      {activeSubTab === "ftp" && (
        <>
          {!mobilityMode && ftpConfigPath && (
            <div className="settings-path-strip" title={ftpConfigPath}>
              <span className="settings-path-strip__label">
                {t("settings.boundTo")}
              </span>
              <code className="settings-path-strip__path">{ftpConfigPath}</code>
            </div>
          )}

          {ftpConnectionMessage && (
            <SettingsNotice
              tone={ftpNoticeTone}
              volatile={ftpConnectionState === "checking"}
              message={ftpConnectionMessage}
              onDismiss={() => {
                setFtpConnectionState("idle");
                setFtpConnectionMessage(null);
              }}
            />
          )}

          {ftpLoading && ftpDraft === null ? (
            <LoadingSpinner className="settings-loading" label={t("settings.loading")} />
          ) : ftpDraft === null ? (
            <div className="settings-loading">{t("settings.empty")}</div>
          ) : (
            <FtpTab
              draft={ftpDraft}
              disabled={!canManageAdminConfig}
              onChangeDraft={setFtpDraft}
            />
          )}

          <div className="settings-footer__row">
            <span
              className="scan-busy"
              data-visible={ftpBusy ? "true" : "false"}
              aria-hidden={!ftpBusy}
            >
              <LoadingSpinner inline size={20} ariaLabel={t("settings.admin.busy")} />
            </span>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void loadFtp()}
              disabled={ftpBusy}
              title={t("settings.reload.title")}
            >
              <Icon name="refresh" tone="accent" />
              {t("settings.reload")}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void testFtpConnection()}
              disabled={ftpBusy}
              title={t("settings.ftp.test.title")}
            >
              <Icon name="check" tone="accent" />
              {t("settings.ftp.test")}
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn--warn"
              disabled={ftpBusy || !ftpHasBackup}
              onClick={() => void onRestoreFtp()}
              title={t("settings.btn.default.title")}
            >
              <Icon name="refresh" tone="warn" />
              {t("settings.btn.default")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={ftpBusy || !ftpDirty}
              aria-disabled={!canManageAdminConfig}
              onClick={() => {
                if (!canManageAdminConfig) {
                  showPrivilegeNotice();
                  return;
                }
                void onSaveFtp();
              }}
              title={t("settings.btn.saveAs.title")}
            >
              <Icon name="download" />
              {t("settings.btn.saveAs")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AllowedHostsTab({
  canManage,
  onBlockedAction,
}: {
  canManage: boolean;
  onBlockedAction: () => void;
}) {
  const { t } = useTranslation();
  const [sourceHosts, setSourceHosts] = useState<string[]>(DEFAULT_ALLOWED_HOSTS);
  const [draft, setDraft] = useState(DEFAULT_ALLOWED_HOSTS.join("\n"));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<"info" | "success">("success");

  const draftHosts = useMemo(() => parseAllowedHostsText(draft), [draft]);
  const invalidHosts = useMemo(() => validateAllowedHostList(draftHosts), [draftHosts]);
  const dirty = draftHosts.join("\n") !== sourceHosts.join("\n");

  async function loadHosts(cancelledRef: { current: boolean }): Promise<boolean> {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(apiUrl("/api/admin/iobeam/hosts"), { headers: scanAuthHeaders() });
      const data = (await r.json().catch(() => null)) as AllowedHostsResponse | null;
      if (!r.ok || !data?.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      const hosts = normalizeAllowedHostList(Array.isArray(data.hosts) ? data.hosts : []);
      if (cancelledRef.current) return false;
      setSourceHosts(hosts);
      setDraft(hosts.join("\n"));
      return true;
    } catch (err) {
      if (cancelledRef.current) return false;
      const fallback = [...DEFAULT_ALLOWED_HOSTS];
      setSourceHosts(fallback);
      setDraft(fallback.join("\n"));
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    const cancelled = { current: false };
    void loadHosts(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, []);

  async function onSave() {
    if (!canManage) {
      onBlockedAction();
      return;
    }
    if (invalidHosts.length > 0) {
      setNotice(null);
      setError(t("settings.admin.allowedHosts.validation.error", { hosts: invalidHosts.join(", ") }));
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    setNoticeTone("success");
    try {
      const r = await fetch(apiUrl("/api/admin/iobeam/hosts"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
        body: JSON.stringify({ hosts: draftHosts }),
      });
      const data = (await r.json().catch(() => null)) as AllowedHostsResponse | null;
      if (!r.ok || !data?.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      const hosts = normalizeAllowedHostList(Array.isArray(data.hosts) ? data.hosts : draftHosts);
      setSourceHosts(hosts);
      setDraft(hosts.join("\n"));
      setNoticeTone(data.sync_warning ? "info" : "success");
      setNotice(
        data.sync_warning
          ? t("settings.admin.allowedHosts.save.warning", { warning: data.sync_warning })
          : t("settings.admin.allowedHosts.save.ok"),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function reloadHosts() {
    setNotice(null);
    const cancelled = { current: false };
    void loadHosts(cancelled).then((loaded) => {
      if (!cancelled.current && loaded) {
        setNoticeTone("success");
        setNotice(t("settings.admin.allowedHosts.reload.ok"));
      }
    });
  }

  return (
    <div className="settings-form">
      {notice && (
        <SettingsNotice tone={noticeTone} message={notice} onDismiss={() => setNotice(null)} />
      )}
      {error && (
        <SettingsNotice tone="error" message={error} onDismiss={() => setError(null)} />
      )}

      <h4 className="settings-form__group">{t("settings.admin.group.allowedHosts")}</h4>
      <p className="settings-form__hint">{t("settings.admin.allowedHosts.hint")}</p>
      {loading && <LoadingSpinner label={t("settings.admin.allowedHosts.loading")} />}

      <div className="field-row">
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="allowed-hosts-input">{t("settings.admin.allowedHosts.label")}</label>
          <textarea
            id="allowed-hosts-input"
            className="input settings-admin-hosts__textarea"
            rows={6}
            value={draft}
            disabled={loading || saving}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={DEFAULT_ALLOWED_HOSTS.join("\n")}
          />
        </div>
      </div>

      <div className="settings-form__group-row settings-form__group-row--db-apply">
        <span />
        <button
          type="button"
          className="btn btn--ghost"
          onClick={reloadHosts}
          disabled={loading || saving}
          title={t("settings.admin.allowedHosts.reload.title")}
        >
          <Icon name="refresh" tone="accent" />
          {t("settings.reload")}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={onSave}
          disabled={loading || saving || !dirty}
          aria-disabled={!canManage}
          title={t("settings.admin.allowedHosts.save.title")}
        >
          <Icon name="download" />
          {t("settings.admin.allowedHosts.save.label")}
        </button>
      </div>

      <p className="settings-form__hint">{t("settings.admin.allowedHosts.note")}</p>
      <p className="settings-form__hint">{t("settings.admin.allowedHosts.help")}</p>
    </div>
  );
}

function AdminSubTabButton({
  tab,
  active,
  label,
  onSelect,
}: {
  tab: AdminSubTab;
  active: AdminSubTab;
  label: string;
  onSelect: (tab: AdminSubTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      className="settings-admin-subtabs__tab"
      aria-selected={active === tab}
      onClick={() => onSelect(tab)}
    >
      {label}
    </button>
  );
}

function AdminUsersTable({
  users,
  sourceUsers,
  auditorEmails,
  canApproveAdminRole,
  disabled,
  actionDisabled,
  canManage,
  onUpdate,
  onPersist,
  onDelete,
  onBlockedAction,
  onRequestAdminApproval,
  targetAccountId,
  targetLogin,
}: {
  users: AdminUserRow[];
  sourceUsers: AdminUserRow[];
  auditorEmails: string[];
  canApproveAdminRole: boolean;
  disabled: boolean;
  actionDisabled: boolean;
  canManage: boolean;
  onUpdate: (index: number, field: keyof AdminUserRow, value: string | number | boolean | null) => void;
  onPersist: (index: number) => void;
  onDelete: (index: number) => void;
  onBlockedAction: () => void;
  onRequestAdminApproval: (user: AdminUserRow, recipients: string[]) => void;
  targetAccountId: number | null;
  targetLogin: string | null;
}) {
  const { t } = useTranslation();
  const highlightedRowRef = useRef<HTMLDivElement | null>(null);
  const sourceRoleById = new Map(sourceUsers.map((user) => [user.id, user.role] as const));
  const sourceSignatureByKey = new Map(
    sourceUsers.map((user, index) => [
      adminUserRowKey(user, index),
      adminUserRowSignature(user),
    ] as const),
  );

  useEffect(() => {
    const row = highlightedRowRef.current;
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [targetAccountId, targetLogin, users.length]);

  return (
    <div
      className="settings-admin-table-wrap"
      onPointerDownCapture={(event) => {
        if (canManage) return;
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target?.closest("input, select, button")) return;
        onBlockedAction();
      }}
    >
      <div className="settings-admin-table" role="table">
        <div className="settings-admin-table__head" role="row">
          <span role="columnheader">{t("settings.admin.user.id")}</span>
          <span role="columnheader">{t("settings.admin.user.login")}</span>
          <span role="columnheader">{t("settings.admin.user.firstName")}</span>
          <span role="columnheader">{t("settings.admin.user.lastName")}</span>
          <span role="columnheader">{t("settings.admin.user.email")}</span>
          <span role="columnheader">{t("settings.admin.user.phone")}</span>
          <span role="columnheader">{t("settings.admin.user.company")}</span>
          <span role="columnheader">{t("settings.admin.user.site")}</span>
          <span role="columnheader">{t("settings.admin.user.role")}</span>
          <span role="columnheader">{t("settings.admin.user.sessionLifetimeDays")}</span>
          <span role="columnheader">{t("settings.admin.user.active")}</span>
          <span role="columnheader">{t("settings.admin.user.actions")}</span>
        </div>
        {users.map((user, index) => {
          const previousRole = sourceRoleById.get(user.id) ?? 0;
          const needsAdminApproval =
            !canApproveAdminRole && user.role === ADMIN_ROLE && previousRole < ADMIN_ROLE;
          const persistedSignature = sourceSignatureByKey.get(adminUserRowKey(user, index));
          const rowExistsInDb = persistedSignature !== undefined;
          const rowDirty = persistedSignature !== adminUserRowSignature(user);
          const isHighlighted =
            (targetAccountId !== null && user.id === targetAccountId) ||
            (!!targetLogin && user.login_name.trim().toLowerCase() === targetLogin.trim().toLowerCase());
          const rowRef = isHighlighted ? highlightedRowRef : undefined;

          return (
          <div
            className="settings-admin-table__row"
            data-highlighted={isHighlighted ? "true" : "false"}
            role="row"
            key={`${user.id ?? "new"}-${index}`}
            ref={rowRef}
          >
            <NumberStepperInput
              value={user.id ?? ""}
              disabled={disabled}
              onValueChange={(value) =>
                onUpdate(index, "id", value === "" ? null : Number(value))
              }
              step={1}
              min={0}
              inputMode="numeric"
              ariaLabel={t("settings.admin.user.id")}
            />
            <input
              aria-label={t("settings.admin.user.login")}
              className="input"
              value={user.login_name}
              disabled={disabled}
              onChange={(e) => onUpdate(index, "login_name", e.target.value)}
            />
            <input
              aria-label={t("settings.admin.user.firstName")}
              className="input"
              value={user.first_name}
              disabled={disabled}
              onChange={(e) => onUpdate(index, "first_name", e.target.value)}
            />
            <input
              aria-label={t("settings.admin.user.lastName")}
              className="input"
              value={user.last_name}
              disabled={disabled}
              onChange={(e) => onUpdate(index, "last_name", e.target.value)}
            />
            <input
              aria-label={t("settings.admin.user.email")}
              className="input"
              type="email"
              value={user.email}
              disabled={disabled}
              onChange={(e) => onUpdate(index, "email", e.target.value)}
            />
            <input
              aria-label={t("settings.admin.user.phone")}
              className="input"
              type="tel"
              value={user.phone_number}
              disabled={disabled}
              onChange={(e) => onUpdate(index, "phone_number", e.target.value)}
            />
            <input
              aria-label={t("settings.admin.user.company")}
              className="input"
              value={user.company_name}
              disabled={disabled}
              onChange={(e) => onUpdate(index, "company_name", e.target.value)}
            />
            <select
              aria-label={t("settings.admin.user.site")}
              className="select"
              value={user.site}
              disabled={disabled}
              onChange={(e) => onUpdate(index, "site", e.target.value)}
            >
              {SITE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("settings.admin.user.role")}
              className="select"
              value={user.role}
              disabled={disabled}
              onChange={(e) => onUpdate(index, "role", Number(e.target.value))}
            >
              {ADMIN_ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.key)}
                </option>
              ))}
            </select>
            <NumberStepperInput
              value={user.session_lifetime_limit_days}
              disabled={disabled}
              onValueChange={(value) =>
                onUpdate(
                  index,
                  "session_lifetime_limit_days",
                  Math.max(1, Math.trunc(Number(value) || 1)),
                )
              }
              step={1}
              min={1}
              inputMode="numeric"
              ariaLabel={t("settings.admin.user.sessionLifetimeDays")}
            />
            <label className="settings-admin-table__check vacuum-switch settings-switch">
              <input
                aria-label={t("settings.admin.user.active")}
                type="checkbox"
                checked={user.is_active}
                disabled={disabled}
                onChange={(e) => onUpdate(index, "is_active", e.target.checked)}
              />
              <span className="vacuum-switch__track">
                <span className="vacuum-switch__thumb" />
              </span>
            </label>
            <div className="settings-admin-table__actions">
              {rowExistsInDb ? (
                <button
                  type="button"
                  className="modal__close"
                  onClick={() => {
                    if (!canManage) {
                      onBlockedAction();
                      return;
                    }
                    onPersist(index);
                  }}
                  disabled={actionDisabled || !rowDirty || needsAdminApproval}
                  aria-disabled={!canManage}
                  aria-label={t("settings.admin.user.update")}
                  title={t("settings.admin.user.update")}
                >
                  <Icon name="refresh" tone="accent" />
                </button>
              ) : (
                <button
                  type="button"
                  className="modal__close"
                  onClick={() => {
                    if (!canManage) {
                      onBlockedAction();
                      return;
                    }
                    onPersist(index);
                  }}
                  disabled={actionDisabled || needsAdminApproval}
                  aria-disabled={!canManage}
                  aria-label={t("settings.admin.user.save")}
                  title={t("settings.admin.user.save")}
                >
                  <Icon name="save" tone="success" />
                </button>
              )}
              {needsAdminApproval && (
                <button
                  type="button"
                  className="modal__close"
                  onClick={() => onRequestAdminApproval(user, auditorEmails)}
                  disabled={disabled}
                  aria-label={t("settings.admin.user.requestAdmin")}
                  title={t("settings.admin.user.requestAdmin.title")}
                >
                  <Icon name="mail" tone="accent" />
                </button>
              )}
              <button
                type="button"
                className="modal__close"
                onClick={() => {
                  if (!canManage) {
                    onBlockedAction();
                    return;
                  }
                  onDelete(index);
                }}
                disabled={actionDisabled || users.length <= 1}
                aria-disabled={!canManage}
                aria-label={t("settings.admin.user.delete")}
                title={t("settings.admin.user.delete")}
              >
                <Icon name="trash" tone="danger" />
              </button>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

type SettingsHelpTopic =
  | "generalVoltage"
  | "generalBuffer"
  | "generalAdcHalfPeriod"
  | "generalAdcSettleCycles"
  | "generalAdcLatchCycles"
  | "generalBusTurnaroundCycles"
  | "generalDacDataSetupCycles"
  | "generalDacLatchCycles"
  | "rasterPixels"
  | "rasterResolution"
  | "rasterAdcLatency"
  | "rasterDwell"
  | "rasterFrameBlank"
  | "vectorResolution"
  | "vectorDwell"
  | "vectorLatency"
  | "vectorAdcLatency"
  | "vectorLineShift"
  | "vectorDrainFloor"
  | "simulationEnabled"
  | "simulationMode"
  | "simulationResolution"
  | "simulationSource"
  | "simulationPattern"
  | "simulationInvert"
  | "simulationSeed";

function SettingsHelp({ topic }: { topic: SettingsHelpTopic }) {
  const { t } = useTranslation();
  const meta = SETTINGS_HELP_META[topic];
  return (
    <HelpPopover
      title={t(meta.title)}
      ariaLabel={t("settings.help.aria")}
    >
      {meta.body ? <p>{t(meta.body)}</p> : SETTINGS_HELP_BODY[topic]}
    </HelpPopover>
  );
}

function configDefaultsPreview(config: unknown): {
  simulation?: Record<string, unknown>;
  is_production?: boolean;
  version?: string;
} {
  const simulation = readPath(config, SIMULATION_PATH);
  const isProduction = readPath(config, ["IsProduction"]);
  const version = readPath(config, ["Version"]);
  return {
    simulation:
      simulation && typeof simulation === "object" && !Array.isArray(simulation)
        ? (simulation as Record<string, unknown>)
        : undefined,
    is_production: typeof isProduction === "boolean" ? isProduction : undefined,
    version: typeof version === "string" ? version : undefined,
  };
}

const SETTINGS_HELP_META: Record<SettingsHelpTopic, {
  title: TranslationKey;
  body?: TranslationKey;
}> = {
  generalVoltage: { title: "settings.help.generalVoltage.title" },
  generalBuffer: { title: "settings.help.generalBuffer.title" },
  generalAdcHalfPeriod: {
    title: "settings.help.generalAdcHalfPeriod.title",
    body: "settings.help.generalAdcHalfPeriod.body",
  },
  generalAdcSettleCycles: {
    title: "settings.help.generalAdcSettleCycles.title",
    body: "settings.help.generalAdcSettleCycles.body",
  },
  generalAdcLatchCycles: {
    title: "settings.help.generalAdcLatchCycles.title",
    body: "settings.help.generalAdcLatchCycles.body",
  },
  generalBusTurnaroundCycles: {
    title: "settings.help.generalBusTurnaroundCycles.title",
    body: "settings.help.generalBusTurnaroundCycles.body",
  },
  generalDacDataSetupCycles: {
    title: "settings.help.generalDacDataSetupCycles.title",
    body: "settings.help.generalDacDataSetupCycles.body",
  },
  generalDacLatchCycles: {
    title: "settings.help.generalDacLatchCycles.title",
    body: "settings.help.generalDacLatchCycles.body",
  },
  rasterPixels: { title: "settings.help.rasterPixels.title" },
  rasterResolution: { title: "settings.help.rasterResolution.title" },
  rasterAdcLatency: { title: "settings.help.rasterAdcLatency.title" },
  rasterDwell: { title: "settings.help.rasterDwell.title" },
  rasterFrameBlank: { title: "settings.help.rasterFrameBlank.title" },
  vectorResolution: { title: "settings.help.vectorResolution.title" },
  vectorDwell: { title: "settings.help.vectorDwell.title" },
  vectorLatency: { title: "settings.help.vectorLatency.title" },
  vectorAdcLatency: { title: "settings.help.vectorAdcLatency.title" },
  vectorLineShift: { title: "settings.help.vectorLineShift.title" },
  vectorDrainFloor: { title: "settings.help.vectorDrainFloor.title" },
  simulationEnabled: { title: "settings.help.simulationEnabled.title" },
  simulationMode: { title: "settings.help.simulationMode.title" },
  simulationResolution: { title: "settings.help.simulationResolution.title" },
  simulationSource: { title: "settings.help.simulationSource.title" },
  simulationPattern: { title: "settings.help.simulationPattern.title" },
  simulationInvert: { title: "settings.help.simulationInvert.title" },
  simulationSeed: { title: "settings.help.simulationSeed.title" },
};

const SETTINGS_HELP_BODY: Partial<Record<SettingsHelpTopic, JSX.Element>> = {
  generalVoltage: (
    <>
      <p>
        Beam energy in electron-volts from <code>actionData.ev</code>.
        This is not the Glasgow I/O port voltage. It is stored with the
        rest of <code>streamData.json</code> and should match the beam
        energy expected by the microscope configuration.
      </p>
    </>
  ),
  generalBuffer: (
    <>
      <p>
        Host-side buffer expression from <code>actionData.bufferSize</code>.
        Existing configs use expressions such as <code>1024*1024</code>;
        keep the expression form if downstream code evaluates it rather
        than treating it as a plain byte count.
      </p>
    </>
  ),
  rasterPixels: (
    <>
      <p>
        Number of raster pixels sent per macro command batch. Larger values
        reduce command overhead; smaller values give the host more frequent
        stop points. It is independent of the final image resolution.
      </p>
    </>
  ),
  rasterResolution: (
    <>
      <p>
        Raster output grid size, <code>N x N</code>. The scan covers the
        configured DAC range and samples it at this density. Prefer powers
        of two so DAC stepping and image reshaping stay exact.
      </p>
    </>
  ),
  rasterAdcLatency: (
    <>
      <p>
        ADC pipeline latency compensation for raster mode. Increase this
        when the sampled intensity appears shifted relative to the commanded
        beam position; decrease it if the correction overshoots.
      </p>
    </>
  ),
  rasterDwell: (
    <>
      <p>
        A dwell of N accumulates N + 1 ADC samples (125 ns each with the current
        revC3 timing configuration) per raster pixel.
        Higher dwell improves noise averaging but increases frame time
        linearly. Practical values are 2^k − 1 (1, 3, 7, 15, 31, 63…) so that
        every sample is used.
      </p>
    </>
  ),
  rasterFrameBlank: (
    <>
      <p>
        When enabled, the macro blanks the beam at frame boundaries and
        during abort cleanup. Leave it off for fastest live preview; enable
        it for beam-sensitive samples.
      </p>
    </>
  ),
  vectorResolution: (
    <>
      <p>
        Default-vector sweep resolution. The scan still covers the full
        DAC range, but this value controls how many evenly spaced sample
        sites are visited on each axis. Presets are common powers of two;
        custom values allow finer control from <code>1..2048</code>.
      </p>
    </>
  ),
  vectorDwell: (
    <>
      <p>
        Default-vector dwell: a dwell of N takes N + 1 ADC samples of 125 ns
        each (revC3). This only affects
        the built-in default sweep. Custom point lists already carry a
        per-point <code>dwell</code> value in each <code>x, y, dwell</code>
        triple.
      </p>
    </>
  ),
  vectorLatency: (
    <>
      <p>
        Vector command chunk size in bytes. Each vector point is encoded as
        an explicit <code>x, y, dwell</code> command, so this value controls
        how many point commands are sent per host/device transfer chunk.
      </p>
    </>
  ),
  vectorAdcLatency: (
    <>
      <p>
        ADC pipeline latency compensation for vector mode. It aligns the
        returned ADC samples with the explicit point list sent to the
        device.
      </p>
    </>
  ),
  vectorLineShift: (
    <>
      <p>
        Per-X-row line shift used to deskew default vector sweep rendering.
        The live UI applies this correction after a vector stream finishes;
        the backend figure renderer uses the same value for saved figures.
      </p>
    </>
  ),
  vectorDrainFloor: (
    <>
      <p>
        Minimum number of extra pixels drained at the end of a vector scan.
        This protects the tail of the ADC pipeline so the last real points
        are not left behind in device buffers.
      </p>
    </>
  ),
  simulationEnabled: (
    <>
      <p>
        Enables fake ADC data when the system is not in production mode.
        Production mode still routes to real hardware regardless of this
        switch.
      </p>
    </>
  ),
  simulationMode: (
    <>
      <p>
        <code>image</code> bakes grayscale bytes into BRAM and drives ADC
        data from that image. <code>zeros</code> ties the data line low.
        <code>loopback</code> echoes DAC code data for coordinate-path
        diagnostics.
      </p>
    </>
  ),
  simulationResolution: (
    <>
      <p>
        Size of the generated or loaded simulation image. The source image
        is converted to a square grayscale buffer at this resolution before
        FakeAdcSimulator uses it.
      </p>
    </>
  ),
  simulationSource: (
    <>
      <p>
        Only used when mode is <code>image</code>. Pattern uses built-in
        deterministic images, file loads a PNG/BMP/JPG path, and random
        fills the image with seeded pseudo-random grayscale values.
      </p>
    </>
  ),
  simulationPattern: (
    <>
      <p>
        Built-in image pattern. <code>bullseye</code> is useful for
        verifying vector/raster alignment because geometric distortion is
        easy to see after a live scan finishes.
      </p>
    </>
  ),
  simulationInvert: (
    <>
      <p>
        Inverts loaded file pixels as <code>255 - pixel</code> before they
        are written into the fake ADC image buffer. This only affects file
        sources.
      </p>
    </>
  ),
  simulationSeed: (
    <>
      <p>
        Seed for the random image source. Keeping the same seed makes the
        generated simulation image reproducible across service restarts.
      </p>
    </>
  ),
};

/* -------- form atoms --------------------------------------------------- */

function TextField({
  label,
  help,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  help?: JSX.Element;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <FieldLabel label={label} help={help} />
      <input
        type="text"
        className="input"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function PasswordField({
  label,
  value,
  visible,
  configured,
  revealLabel,
  disabled = false,
  onReveal,
  onHide,
  onChange,
}: {
  label: string;
  value: string;
  visible: boolean;
  configured: boolean;
  revealLabel: string;
  disabled?: boolean;
  onReveal: () => void;
  onHide: () => void;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <FieldLabel label={label} />
      <div className="settings-password-field">
        <input
          type={visible ? "text" : "password"}
          className="input"
          value={visible ? value : configured ? "********" : value}
          disabled={disabled}
          readOnly={!visible && configured}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="modal__close settings-password-field__reveal"
          disabled={disabled}
          onPointerDown={(event) => {
            event.preventDefault();
            onReveal();
          }}
          onPointerUp={onHide}
          onPointerLeave={onHide}
          onPointerCancel={onHide}
          onBlur={onHide}
          aria-label={revealLabel}
          title={revealLabel}
        >
          <Icon name="eye" tone="accent" />
        </button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  help,
  value,
  step,
  min,
  max,
  invalid,
  warning,
  onChange,
}: {
  label: string;
  help?: JSX.Element;
  value: number;
  step?: string;
  min?: number;
  max?: number;
  invalid?: boolean;
  warning?: JSX.Element | string;
  onChange: (v: number) => void;
}) {
  // Mirror the input as a string so the user can briefly hold "-" / "."
  // mid-typing without us snapping the live value back to 0.
  const [local, setLocal] = useState(String(value));
  useEffect(() => {
    setLocal(String(value));
  }, [value]);
  return (
    <div className="field">
      <FieldLabel label={label} help={help} />
      <NumberStepperInput
        value={local}
        onValueChange={(next) => {
          setLocal(next);
          const n = Number(next);
          if (Number.isFinite(n)) onChange(n);
        }}
        step={step === "any" ? 1 : Number(step ?? 1)}
        min={min}
        max={max}
        invalid={invalid}
        warning={warning}
      />
    </div>
  );
}

function validAdcTiming(config: unknown): boolean {
  const half = numberField(config, [...ACTION_DATA_PATH, "adcHalfPeriod"], 3);
  const settle = numberField(config, [...ACTION_DATA_PATH, "adcSettleCycles"], 1);
  const latch = numberField(config, [...ACTION_DATA_PATH, "adcLatchCycles"], 1);
  const turnaround = numberField(config, [...ACTION_DATA_PATH, "busTurnaroundCycles"], 0);
  const setup = numberField(config, [...ACTION_DATA_PATH, "dacDataSetupCycles"], 1);
  const dacLatch = numberField(config, [...ACTION_DATA_PATH, "dacLatchCycles"], 1);
  const values = [half, settle, latch, turnaround, setup, dacLatch];
  return values.every((value) => Number.isInteger(value) && value <= 255)
    && half >= 2 && settle >= 1 && latch >= 1 && turnaround >= 0
    && setup >= 1 && dacLatch >= 1
    && latch + settle <= half
    && 2 * half >= settle + latch + turnaround + 2 * (setup + dacLatch);
}

function CheckboxField({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help?: JSX.Element;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="settings-checkbox vacuum-switch settings-switch">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="vacuum-switch__track">
        <span className="vacuum-switch__thumb" />
      </span>
      <span>{label}</span>
      {help}
    </label>
  );
}

function RadioField({
  name,
  label,
  help,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  help?: JSX.Element;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="settings-checkbox">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
      />
      <span>{label}</span>
      {help}
    </label>
  );
}

function FieldLabel({ label, help }: { label: string; help?: JSX.Element }) {
  return (
    <label className="settings-field-label">
      <span>{label}</span>
      {help}
    </label>
  );
}

/* -------- notices + confirm row ---------------------------------------- */

function SettingsNotice({
  tone,
  volatile = false,
  message,
  onDismiss,
}: {
  tone: "info" | "success" | "warning" | "error";
  volatile?: boolean;
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className={`settings-notice settings-notice--${tone}`} data-volatile={volatile ? "true" : "false"}>
      <span className="settings-notice__message">{message}</span>
      <button
        type="button"
        className="modal__close"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

function ConfirmRow({
  message,
  confirmLabel,
  disabled,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-confirm">
      <span className="settings-confirm__message">{message}</span>
      <span className="spacer" />
      <button
        type="button"
        className="btn btn--cancel"
        onClick={onCancel}
        disabled={disabled}
      >
        {t("settings.confirm.cancel")}
      </button>
      <button
        type="button"
        className="btn btn--orange"
        onClick={onConfirm}
        disabled={disabled}
      >
        {confirmLabel}
      </button>
    </div>
  );
}

/* -------- typed accessors --------------------------------------------- */

function stringField(
  root: unknown,
  path: ReadonlyArray<string | number>,
  fallback: string
): string {
  const v = readPath(root, path);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function numberField(
  root: unknown,
  path: ReadonlyArray<string | number>,
  fallback: number
): number {
  const v = readPath(root, path);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function positiveIntField(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.trunc(n));
}

function boolField(
  root: unknown,
  path: ReadonlyArray<string | number>,
  fallback: boolean
): boolean {
  const v = readPath(root, path);
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}
