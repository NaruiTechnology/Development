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
 * (b) is simpler: every input dispatches `setDraft(writePath(...))`
 * with an immutably updated copy, and the dialog reads `draft` for
 * every render. The Redux DevTools timeline becomes the edit history
 * for free.
 */
import { useEffect, useRef, useState } from "react";

import { useTranslation, type TranslationKey } from "../i18n";
import { useAppDispatch, useAppSelector, type AppDispatch } from "../store";
import { fetchDefaults, previewConfigDefaults } from "../store/statusSlice";
import {
  ACTION_DATA_PATH,
  PINS_PATH,
  RASTER_PATH,
  SIMULATION_PATH,
  VECTOR_PATH,
  clearError,
  clearLastRestart,
  closeDialog,
  consumeBackupNotice,
  fetchSettingsConfig,
  readPath,
  restoreSettingsConfig,
  saveSettingsConfig,
  setActiveTab,
  setDraft,
  setError,
  writePath,
  type SettingsTab,
} from "../store/settingsSlice";
import { HelpPopover } from "./HelpPopover";
import { Icon } from "./Icon";

export function SettingsDialog() {
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.settings.dialogOpen);

  useEffect(() => {
    if (!open) return;
    dispatch(fetchSettingsConfig());
  }, [dispatch, open]);

  // Scroll lock while the settings modal is open. The dialog closes
  // only from the explicit header close button so restart results stay
  // visible until the operator dismisses them.
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
      <SettingsModalShell />
    </div>
  );
}

async function refreshDefaultsForSettings(dispatch: AppDispatch) {
  const result = await dispatch(fetchDefaults());
  if (fetchDefaults.rejected.match(result)) {
    dispatch(
      setError(
        result.error.message ??
          "Service restart completed, but refreshed defaults could not be loaded.",
      ),
    );
  }
}

/* -------- modal shell -------------------------------------------------- */

function SettingsModalShell() {
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
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const titleIdRef = useRef(
    `settings-modal-title-${Math.random().toString(36).slice(2, 9)}`,
  );

  useEffect(() => {
    const focusTimer = window.setTimeout(() => closeBtnRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, []);

  // "Save As" and "Default" both fire a confirm-then-action flow. We
  // use local component state for the confirm row rather than a nested
  // modal - a second modal layer is heavy for a yes/no prompt.
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDefault, setConfirmDefault] = useState(false);

  const busy = loading || saving || restoring;

  function onSelectTab(tab: SettingsTab) {
    if (confirmSave) setConfirmSave(false);
    if (confirmDefault) setConfirmDefault(false);
    dispatch(setActiveTab(tab));
  }

  async function onConfirmSave() {
    if (draft === null) return;
    setConfirmSave(false);
    const result = await dispatch(saveSettingsConfig(draft));
    if (saveSettingsConfig.fulfilled.match(result)) {
      dispatch(previewConfigDefaults(configDefaultsPreview(draft)));
      await refreshDefaultsForSettings(dispatch);
    }
    // The restart result is surfaced via `lastRestart`; we don't
    // auto-close the dialog so the operator can see whether it
    // succeeded.
  }

  async function onConfirmDefault() {
    setConfirmDefault(false);
    const result = await dispatch(restoreSettingsConfig());
    if (restoreSettingsConfig.fulfilled.match(result)) {
      // Pull the restored values back into the dialog so the tabs
      // show the freshly-installed defaults instead of the pre-restore
      // draft.
      const config = await dispatch(fetchSettingsConfig());
      if (fetchSettingsConfig.fulfilled.match(config)) {
        dispatch(previewConfigDefaults(configDefaultsPreview(config.payload.data)));
      }
      await refreshDefaultsForSettings(dispatch);
    }
  }

  // Render gate. We keep the shell mounted even during loading so the
  // close button and the dimmed backdrop work the moment the dialog
  // opens - only the body switches to a spinner. Once `draft` arrives
  // we light up the tabs.
  return (
    <div
      className="modal settings-modal"
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

      {configPath && (
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
              ? t("settings.restart.ok", { command: lastRestart.command })
              : t("settings.restart.fail", {
                  command: lastRestart.command,
                  detail: lastRestart.error || lastRestart.stderr || "",
                })
          }
          onDismiss={() => dispatch(clearLastRestart())}
        />
      )}

      <div className="settings-tabs" role="tablist" aria-label={t("settings.tabs.aria")}>
        <SettingsTabButton tab="general" active={activeTab} onSelect={onSelectTab} />
        <SettingsTabButton tab="raster" active={activeTab} onSelect={onSelectTab} />
        <SettingsTabButton tab="vector" active={activeTab} onSelect={onSelectTab} />
        <SettingsTabButton tab="pins" active={activeTab} onSelect={onSelectTab} />
        <SettingsTabButton tab="simulation" active={activeTab} onSelect={onSelectTab} />
      </div>

      <div className="modal__body settings-modal__body">
        {loading && draft === null ? (
          <div className="settings-loading">{t("settings.loading")}</div>
        ) : draft === null ? (
          <div className="settings-loading">{t("settings.empty")}</div>
        ) : (
          <SettingsTabBody tab={activeTab} draft={draft} />
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
        ) : (
          <div className="settings-footer__row">
            <span
              className="scan-busy"
              data-visible={busy ? "true" : "false"}
              aria-hidden={!busy}
            >
              <span className="scan-busy__spinner" />
            </span>

            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => dispatch(fetchSettingsConfig())}
              disabled={busy}
              title={t("settings.reload.title")}
            >
              <Icon name="refresh" tone="accent" />
              {t("settings.reload")}
            </button>

            <span className="spacer" />

            <button
              type="button"
              className="btn btn--settings-action"
              disabled={busy || !hasBackup}
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
              className="btn btn--settings-action"
              disabled={busy || draft === null || draft === source}
              onClick={() => setConfirmSave(true)}
              title={t("settings.btn.saveAs.title")}
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

function SettingsTabBody({ tab, draft }: { tab: SettingsTab; draft: unknown }) {
  switch (tab) {
    case "general":
      return <GeneralTab draft={draft} />;
    case "raster":
      return <RasterTab draft={draft} />;
    case "vector":
      return <VectorTab draft={draft} />;
    case "pins":
      return <PinsTab draft={draft} />;
    case "simulation":
      return <SimulationTab draft={draft} />;
  }
}

/* General tab: top-level flags plus the basic actionData scalars that
 * aren't raster- or vector-specific. */
function GeneralTab({ draft }: { draft: unknown }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();

  // Top-level scalars.
  const version = stringField(draft, ["Version"], "");
  const logName = stringField(draft, ["LogName"], "");
  const verbose = boolField(draft, ["Verbose"], false);
  const isProduction = boolField(draft, ["IsProduction"], false);
  const dumpData = boolField(draft, ["DumpData"], false);

  // Glasgow / Device0 id.
  const deviceId = stringField(draft, ["Glasgow", "Device0", "Id"], "");

  // actionData scalars.
  const voltage = numberField(draft, [...ACTION_DATA_PATH, "voltage"], 0);
  const bufferSize = stringField(draft, [...ACTION_DATA_PATH, "bufferSize"], "");

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    dispatch(setDraft(writePath(draft, p, v)));
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
          label={t("settings.general.verbose")}
          value={verbose}
          onChange={(v) => set(["Verbose"], v)}
        />
        <CheckboxField
          label={t("settings.general.isProduction")}
          value={isProduction}
          onChange={(v) => set(["IsProduction"], v)}
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
          label={t("settings.general.voltage")}
          help={<SettingsHelp topic="generalVoltage" />}
          value={voltage}
          step="any"
          onChange={(v) => set([...ACTION_DATA_PATH, "voltage"], v)}
        />
        <TextField
          label={t("settings.general.bufferSize")}
          help={<SettingsHelp topic="generalBuffer" />}
          value={bufferSize}
          onChange={(v) => set([...ACTION_DATA_PATH, "bufferSize"], v)}
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
  const resolution = numberField(draft, [...RASTER_PATH, "resolution"], 0);
  const adcLatency = numberField(draft, [...RASTER_PATH, "adcLatency"], 0);
  const dwell = numberField(draft, [...RASTER_PATH, "dwell"], 0);

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
        <NumberField
          label={t("settings.raster.resolution")}
          help={<SettingsHelp topic="rasterResolution" />}
          value={resolution}
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
        <NumberField
          label={t("settings.raster.dwell")}
          help={<SettingsHelp topic="rasterDwell" />}
          value={dwell}
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

  const latency = numberField(draft, [...VECTOR_PATH, "latency"], 0);
  const adcLatency = numberField(draft, [...VECTOR_PATH, "adcLatency"], 0);
  const lineShift = numberField(draft, [...VECTOR_PATH, "lineShiftPerXRow"], 0);
  const drainFloor = numberField(draft, [...VECTOR_PATH, "drainFloorPixels"], 0);

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    dispatch(setDraft(writePath(draft, p, v)));
  }

  return (
    <div className="settings-form">
      <h4 className="settings-form__group">{t("settings.vector.group.scan")}</h4>

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
 * as a checkbox.
 *
 * Adding rows is intentionally NOT supported: build_iobeam_resources()
 * silently skips entries whose `name` isn't on the catalogue. Removing
 * them would just shift the maintenance burden onto the JSON without
 * any UI benefit. Operators who need an extra strobe edit the file
 * directly.
 * --------------------------------------------------------------------- */
function PinsTab({ draft }: { draft: unknown }) {
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
              onChange={(e) => setSubsignalField(i, "pin", e.target.value)}
            />
            <select
              className="select"
              role="cell"
              value={typeof row?.direction === "string" ? row.direction : "o"}
              onChange={(e) => setSubsignalField(i, "direction", e.target.value)}
            >
              <option value="o">{t("settings.pins.dir.o")}</option>
              <option value="i">{t("settings.pins.dir.i")}</option>
              <option value="io">{t("settings.pins.dir.io")}</option>
              <option value="oe">{t("settings.pins.dir.oe")}</option>
            </select>
            <input
              type="checkbox"
              role="cell"
              checked={Boolean(row?.invert)}
              onChange={(e) => setSubsignalField(i, "invert", e.target.checked)}
            />
          </div>
        ))}
      </div>

      <div className="field-row">
        <TextField
          label={t("settings.pins.control.attrs.ioStandard")}
          value={controlIoStd}
          onChange={(v) => set([...PINS_PATH, "control", "attrs", "IO_STANDARD"], v)}
        />
      </div>

      <h4 className="settings-form__group">{t("settings.pins.group.data")}</h4>
      <p className="settings-form__hint">{t("settings.pins.group.dataHint")}</p>

      <div className="field-row">
        <TextField
          label={t("settings.pins.data.pins")}
          value={dataPins}
          onChange={(v) => set([...PINS_PATH, "data", "pins"], v)}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label>{t("settings.pins.data.direction")}</label>
          <select
            className="select"
            value={dataDirection}
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
function SimulationTab({ draft }: { draft: unknown }) {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();

  const enabled = boolField(draft, [...SIMULATION_PATH, "enabled"], true);
  const mode = stringField(draft, [...SIMULATION_PATH, "mode"], "image");
  const imageResolution = numberField(
    draft, [...SIMULATION_PATH, "imageResolution"], 64
  );
  const source = stringField(draft, [...SIMULATION_PATH, "source"], "pattern");
  const patternKind = stringField(
    draft, [...SIMULATION_PATH, "patternKind"], "bullseye"
  );
  const invert = boolField(draft, [...SIMULATION_PATH, "invert"], false);
  const seed = numberField(draft, [...SIMULATION_PATH, "seed"], 0);

  function set(p: ReadonlyArray<string | number>, v: unknown) {
    dispatch(setDraft(writePath(draft, p, v)));
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
          onChange={(v) => set([...SIMULATION_PATH, "enabled"], v)}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <FieldLabel label={t("settings.simulation.mode")} help={<SettingsHelp topic="simulationMode" />} />
          <select
            className="select"
            value={mode}
            onChange={(e) => set([...SIMULATION_PATH, "mode"], e.target.value)}
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
          onChange={(v) => set([...SIMULATION_PATH, "imageResolution"], v)}
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
            onChange={(e) => set([...SIMULATION_PATH, "source"], e.target.value)}
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
                set([...SIMULATION_PATH, "patternKind"], e.target.value)
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
            onChange={(v) => set([...SIMULATION_PATH, "invert"], v)}
          />
        </div>
      )}

      {imageMode && source === "random" && (
        <div className="field-row">
          <NumberField
            label={t("settings.simulation.seed")}
            help={<SettingsHelp topic="simulationSeed" />}
            value={seed}
            onChange={(v) => set([...SIMULATION_PATH, "seed"], v)}
          />
        </div>
      )}
    </div>
  );
}

type SettingsHelpTopic =
  | "generalVoltage"
  | "generalBuffer"
  | "rasterPixels"
  | "rasterResolution"
  | "rasterAdcLatency"
  | "rasterDwell"
  | "rasterFrameBlank"
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
  return (
    <HelpPopover
      title={t(SETTINGS_HELP_META[topic].title)}
      ariaLabel={t("settings.help.aria")}
    >
      {SETTINGS_HELP_BODY[topic]}
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

const SETTINGS_HELP_META: Record<SettingsHelpTopic, { title: TranslationKey }> = {
  generalVoltage: { title: "settings.help.generalVoltage.title" },
  generalBuffer: { title: "settings.help.generalBuffer.title" },
  rasterPixels: { title: "settings.help.rasterPixels.title" },
  rasterResolution: { title: "settings.help.rasterResolution.title" },
  rasterAdcLatency: { title: "settings.help.rasterAdcLatency.title" },
  rasterDwell: { title: "settings.help.rasterDwell.title" },
  rasterFrameBlank: { title: "settings.help.rasterFrameBlank.title" },
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

const SETTINGS_HELP_BODY: Record<SettingsHelpTopic, JSX.Element> = {
  generalVoltage: (
    <>
      <p>
        Default beam-control voltage from <code>actionData.voltage</code>.
        It is loaded with the rest of <code>streamData.json</code> and
        should match the analog range expected by the connected scan
        electronics.
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
        Number of ADC sample periods accumulated per raster pixel. Higher
        dwell improves noise averaging but increases frame time linearly.
        Practical values are usually powers of two.
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
  onChange,
}: {
  label: string;
  help?: JSX.Element;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <FieldLabel label={label} help={help} />
      <input
        type="text"
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function NumberField({
  label,
  help,
  value,
  step,
  onChange,
}: {
  label: string;
  help?: JSX.Element;
  value: number;
  step?: string;
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
      <input
        type="number"
        step={step ?? "1"}
        className="input"
        value={local}
        onChange={(e) => {
          setLocal(e.target.value);
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </div>
  );
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
    <label className="settings-checkbox">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
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
  message,
  onDismiss,
}: {
  tone: "info" | "success" | "error";
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className={`settings-notice settings-notice--${tone}`}>
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
        className="btn btn--ghost"
        onClick={onCancel}
        disabled={disabled}
      >
        {t("settings.confirm.cancel")}
      </button>
      <button
        type="button"
        className="btn btn--settings-action"
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
