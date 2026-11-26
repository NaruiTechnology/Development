import { useId } from "react";
import { useTranslation } from "../i18n";
import { useAppDispatch, useAppSelector } from "../store";
import { useExposureRun } from "../hooks/useExposureRun";
import { useOtherWorkspaceBusy } from "../hooks/useScanWorkspace";
import { exposureBusy, setMillingChangeThresholdPercent, setMillingRegistrationResolution, setMillingDriftLimitUm,
  setExposureMode, setExposureParallel, setExposureViewZoom, setExposureViewPauseSeconds, setExposurePauseAfterView } from "../store/exposureSlice";
import { applyMillingPassDefaults } from "../store/processingSlice";
import { NumberStepperInput } from "./NumberStepperField";
import { MAX_SCAN_ZOOM } from "../lib/scanRegions";
import { Icon } from "./Icon";
import { HelpPopover } from "./HelpPopover";

export function ExposureReviewPauseToggle() {
  const {t} = useTranslation(), dispatch = useAppDispatch();
  const enabled = useAppSelector(s => s.exposure.pauseAfterView);
  const phase = useAppSelector(s => s.exposure.phase);
  if (phase !== "running" && phase !== "paused") return null;
  return <button type="button" className={`image-panel-pause-toggle${enabled ? " image-panel-pause-toggle--active" : ""}`}
    aria-label={t("processing.exposure.pauseAtView")}
    aria-pressed={enabled}
    title={t("processing.exposure.pauseAtViewHelp")}
    onClick={() => dispatch(setExposurePauseAfterView(!enabled))}>
    <Icon name="pause" />
  </button>;
}

function useExposureScanLocks() {
  const scanBusy = useAppSelector(s => ["running", "stopping"].includes(s.scan.phase) || s.scan.streamRestarting || s.scan.infiniteActive || s.scan.roiTargetGrayRun.status === "running");
  const otherBusy = useOtherWorkspaceBusy();
  return { scanBusy, otherBusy };
}

export function MillingRegistrationPanel({ resolutions, resolution, driftLimitInvalid, onDriftLimitInvalidChange }: {
  resolutions: number[];
  resolution: number | undefined;
  driftLimitInvalid: boolean;
  onDriftLimitInvalidChange: (invalid: boolean) => void;
}) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const limit = useAppSelector(s => s.exposure.millingDriftLimitUm);
  const exposureLocked = useAppSelector(s => exposureBusy(s.exposure.phase) || s.exposure.viewPhase === "queued" || s.exposure.viewPhase === "scanning");
  const { scanBusy, otherBusy } = useExposureScanLocks();
  const disabled = exposureLocked || scanBusy || otherBusy;
  return <div className="milling-registration-panel">
    <label className="milling-registration-panel__row">
      <span>{t("processing.advanced.resolution")}</span>
      <select className="select milling-registration-panel__resolution"
        value={resolution ?? ""} disabled={disabled || resolution === undefined}
        onChange={event => dispatch(setMillingRegistrationResolution(Number(event.target.value)))}>
        {resolution === undefined && <option value="">{t("processing.advanced.resolutionUnavailableOption")}</option>}
        {resolutions.map(size => <option key={size} value={size}>{size} × {size}</option>)}
      </select>
    </label>
    <label className="milling-registration-panel__row">
      <span>{t("processing.advanced.driftLimit")}</span>
      <NumberStepperInput value={limit} min={0} step={0.1}
        ariaLabel={t("processing.advanced.driftLimit")} disabled={disabled} invalid={driftLimitInvalid}
        onValueChange={value => {
          const limitUm = Number(value);
          const valid = value.trim() !== "" && Number.isFinite(limitUm) && limitUm >= 0;
          onDriftLimitInvalidChange(!valid);
          if (valid) dispatch(setMillingDriftLimitUm(limitUm));
        }} />
    </label>
    {driftLimitInvalid && <p className="scan-inline-error" role="status">{t("processing.advanced.driftLimitInvalid")}</p>}
  </div>;
}

export function ExposureControls({disabled = false, showView = true, advancedMilling = false,
  registrationUnavailable = false, driftLimitInvalid = false}: {
  disabled?: boolean;
  showView?: boolean;
  advancedMilling?: boolean;
  registrationUnavailable?: boolean;
  driftLimitInvalid?: boolean;
}) {
  const {t} = useTranslation(), dispatch = useAppDispatch();
  const {state, start, stop, view, resume} = useExposureRun();
  const tab = state.mode;
  const setTab = (mode: "auto" | "milling") => {
    if (exposureBusy(state.phase)) return;
    dispatch(setExposureMode(mode));
    if (mode === "milling") dispatch(applyMillingPassDefaults());
  };
  const tabId = useId();
  const defaultsReady = useAppSelector(s => Boolean(s.status.defaults));
  const patterns = useAppSelector(s => s.processing);
  const { scanBusy, otherBusy } = useExposureScanLocks();
  const viewBusy = state.viewPhase === "queued" || state.viewPhase === "scanning";
  const busy = exposureBusy(state.phase) || viewBusy;
  const enabled = patterns.specs.filter(spec => (tab !== "milling" || spec.key === patterns.activeKey) && patterns.instances[spec.key]?.enabled && patterns.instances[spec.key]?.roi);
  const serialRequired = tab === "auto" && state.parallel && enabled.some(spec => spec.model === "CleaningLineModel");
  const startDisabled = disabled || !defaultsReady || registrationUnavailable || driftLimitInvalid || busy || scanBusy || otherBusy || patterns.status !== "ready" || !patterns.lensLookup || !enabled.length || serialRequired;
  return <div className="patterns-exposure" role="group" aria-label={t("processing.exposure.card")}>
      <div className="patterns-exposure__tabs" role="tablist" aria-label={t("processing.exposure.card")}>
        {(["milling", "auto"] as const).map(name => <button type="button" role="tab" key={name}
          id={`${tabId}-${name}`} aria-controls={`${tabId}-panel`} aria-selected={tab === name}
          disabled={exposureBusy(state.phase)} tabIndex={tab === name ? 0 : -1}
          onClick={() => setTab(name)}
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "milling" : event.key === "End" ? "auto" : tab === "auto" ? "milling" : "auto";
            setTab(next); document.getElementById(`${tabId}-${next}`)?.focus();
          }}>{t(name === "auto" ? "processing.exposure.autoTab" : "processing.exposure.millingTab")}</button>)}
      </div>
      <div className="patterns-exposure__body" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
        <div className="patterns-exposure__controls">
          {tab === "auto" && <label className="checkbox vacuum-switch app-switch" title={t("processing.exposure.parallelHelp")}>
            <input type="checkbox" role="switch" aria-label={t("processing.exposure.parallelLabel")}
              checked={state.parallel} disabled={busy || disabled} onChange={e => dispatch(setExposureParallel(e.target.checked))} />
            <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
            <span>{t("scan.parallel")}</span>
          </label>}
          <label className="patterns-exposure__zoom"
            title={t("processing.exposure.viewZoomHelp")}>
            <Icon name="zoomIn" />
            <NumberStepperInput value={state.viewZoom} min={1} max={MAX_SCAN_ZOOM} step={1}
              inputMode="numeric" ariaLabel={t("scan.zoom")} disabled={disabled || viewBusy}
              onValueChange={value => {
                const zoom = Number(value);
                if (Number.isInteger(zoom) && zoom >= 1 && zoom <= MAX_SCAN_ZOOM)
                  dispatch(setExposureViewZoom(zoom));
              }} />
          </label>
          <button type="button" className="btn btn--stop" disabled={!busy || state.phase === "stopping"}
            onClick={() => void stop()}><Icon name="hand" />{t("scan.stop")}</button>
          {state.phase === "paused"
            ? <button type="button" className="btn btn--primary" disabled={viewBusy} title={t("processing.exposure.resumeHelp")}
                onClick={resume}><Icon name="play" tone="success" />{t("processing.exposure.resume")}</button>
            : <button type="button" className="btn btn--primary" disabled={startDisabled}
                title={serialRequired ? t("processing.exposure.serialRequired") : registrationUnavailable
                  ? t("processing.advanced.serviceError") : driftLimitInvalid
                    ? t("processing.advanced.driftLimitInvalid") : t("processing.exposure.startHelp")}
                onClick={() => void start({registerMilling: advancedMilling})}><Icon name="play" tone="success" />{t("processing.exposure.start")}</button>}
        </div>
        {tab === "milling" && <div className="patterns-exposure__view-row patterns-exposure__change-row">
          <div className="patterns-exposure__pause">
            <div className="patterns-exposure__change-label">
              <span id={`${tabId}-change-threshold-label`}>{t("processing.exposure.changeThreshold")} <output>{state.millingChangeThresholdPercent}%</output></span>
              <HelpPopover title={t("processing.exposure.changeThreshold")} ariaLabel={t("processing.exposure.changeThresholdHelp.aria")}>
                <p>{t("processing.exposure.changeThresholdHelp")}</p>
              </HelpPopover>
            </div>
            <div className="patterns-exposure__pause-shell">
            <div className="patterns-exposure__pause-slider" onClick={event=>{
              if(event.button!==0||event.target instanceof HTMLInputElement)return;
              const rect=event.currentTarget.getBoundingClientRect();
              const ratio=Math.max(0,Math.min(1,(event.clientX-rect.left-4)/Math.max(1,rect.width-8)));
              const next=state.millingChangeThresholdPercent+(ratio<state.millingChangeThresholdPercent/100?-1:1);
              dispatch(setMillingChangeThresholdPercent(Math.max(0,Math.min(100,next))));
            }}>
                <div className="patterns-exposure__pause-track" />
                <div className="patterns-exposure__pause-ticks" aria-hidden="true">
                  {Array.from({length: 21}, (_, index) => {
                  const value = index * 5;
                    const major = index % 5 === 0;
                    return <span key={index} className={major ? "patterns-exposure__pause-tick--major" : ""}
                      style={{left:`${value}%`}}>{major && <i>{value}%</i>}</span>;
                  })}
                </div>
                <input type="range" min={0} max={100} step={1} value={state.millingChangeThresholdPercent}
                  aria-labelledby={`${tabId}-change-threshold-label`} aria-valuetext={`${state.millingChangeThresholdPercent}%`}
                  onChange={event=>dispatch(setMillingChangeThresholdPercent(Number(event.target.value)))} />
              </div>
            </div>
          </div>
        </div>}
        {tab === "auto" && <div className="patterns-exposure__view-row">
          {showView && <span className="patterns-exposure__view-tooltip" title={t("processing.exposure.viewHelp")}>
            <button type="button"
              className={`patterns-exposure__view${state.viewPauseSeconds > 0 ? " patterns-exposure__view--automatic" : viewBusy ? " patterns-exposure__view--busy" : ""}`}
              aria-label={t("processing.exposure.view")}
              aria-busy={viewBusy}
              disabled={!defaultsReady || scanBusy || otherBusy || ["preparing", "stopping"].includes(state.phase) || viewBusy}
              onClick={() => void view()}>
              <Icon name="eye" />
            </button>
          </span>}
          <label className={`patterns-exposure__pause${state.viewPauseSeconds === 0 ? " patterns-exposure__pause--zero" : ""}`}>
            <span>{t("processing.exposure.pause")}</span>
            <div className="patterns-exposure__pause-shell">
              <div className="patterns-exposure__pause-slider">
                <div className="patterns-exposure__pause-track" />
                <div className="patterns-exposure__pause-ticks" aria-hidden="true">
                  {Array.from({length: 16}, (_, value) => {
                    const major = value % 3 === 0 || value === 15;
                    return <span key={value} className={major ? "patterns-exposure__pause-tick--major" : ""}
                      style={{left: `${value / 15 * 100}%`}}>{major && <i>{value}</i>}</span>;
                  })}
                </div>
                <input type="range" min={0} max={15} step={1} value={state.viewPauseSeconds}
                  aria-label={t("processing.exposure.pause")}
                  aria-valuetext={`${state.viewPauseSeconds} ${t("processing.exposure.seconds")}`}
                  onChange={event => dispatch(setExposureViewPauseSeconds(Number(event.target.value)))} />
              </div>
            </div>
          </label>
        </div>}
        {state.phase === "paused" && !state.millingProgress && <p className="scan-inline-note" role="status">{t("processing.exposure.paused").replace("{step}", state.progress.find(n => n.id === state.pausedAfterId)?.caption ?? "")}</p>}
        {serialRequired && <p className="scan-inline-error">{t("processing.exposure.serialRequired")}</p>}
      </div>
  </div>;
}
