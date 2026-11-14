import { useTranslation } from "../i18n";
import { useAppDispatch, useAppSelector } from "../store";
import { useExposureRun } from "../hooks/useExposureRun";
import { useOtherWorkspaceBusy } from "../hooks/useScanWorkspace";
import { exposureBusy, setExposureParallel, setExposureViewPauseSeconds } from "../store/exposureSlice";
import { Icon } from "./Icon";

export function ExposureControls({disabled = false, showView = true}: {disabled?: boolean; showView?: boolean}) {
  const {t} = useTranslation(), dispatch = useAppDispatch();
  const {state, start, stop, view, resume} = useExposureRun();
  const defaultsReady = useAppSelector(s => Boolean(s.status.defaults));
  const patterns = useAppSelector(s => s.processing);
  const scanBusy = useAppSelector(s => ["running", "stopping"].includes(s.scan.phase) || s.scan.streamRestarting || s.scan.infiniteActive || s.scan.roiTargetGrayRun.status === "running");
  const viewBusy = state.viewPhase === "queued" || state.viewPhase === "scanning";
  const otherBusy = useOtherWorkspaceBusy(), busy = exposureBusy(state.phase) || viewBusy;
  const enabled = patterns.specs.filter(spec => patterns.instances[spec.key]?.enabled && patterns.instances[spec.key]?.roi);
  const serialRequired = state.parallel && enabled.some(spec => spec.model === "CleaningLineModel");
  const startDisabled = disabled || !defaultsReady || busy || scanBusy || otherBusy || patterns.status !== "ready" || !patterns.lensLookup || !enabled.length || serialRequired;
  return <div className="patterns-exposure" role="group" aria-label={t("processing.exposure.card")}>
        <div className="patterns-exposure__controls">
          <label className="checkbox vacuum-switch app-switch" title={t("processing.exposure.parallelHelp")}>
            <input type="checkbox" role="switch" aria-label={t("processing.exposure.parallelLabel")}
              checked={state.parallel} disabled={busy || disabled} onChange={e => dispatch(setExposureParallel(e.target.checked))} />
            <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
            <span>{t("scan.parallel")}</span>
          </label>
          <button type="button" className="btn btn--stop" disabled={!busy || state.phase === "stopping"}
            onClick={() => void stop()}><Icon name="hand" />{t("scan.stop")}</button>
          {state.phase === "paused"
            ? <button type="button" className="btn btn--primary" disabled={viewBusy} title={t("processing.exposure.resumeHelp")}
                onClick={resume}><Icon name="play" tone="success" />{t("processing.exposure.resume")}</button>
            : <button type="button" className="btn btn--primary" disabled={startDisabled}
                title={serialRequired ? t("processing.exposure.serialRequired") : t("processing.exposure.startHelp")}
                onClick={() => void start()}><Icon name="play" tone="success" />{t("processing.exposure.start")}</button>}
        </div>
        <div className="patterns-exposure__view-row">
          {showView && <label className={`checkbox vacuum-switch app-switch patterns-exposure__view${viewBusy ? " patterns-exposure__view--busy" : ""}`}>
            <input type="checkbox" role="switch" checked={viewBusy}
              disabled={!defaultsReady || scanBusy || otherBusy || state.phase !== "running" || viewBusy}
              aria-label={t("processing.exposure.view")}
              aria-busy={viewBusy}
              title={t("processing.exposure.viewHelp")}
              onChange={event => { if (event.target.checked) void view(); }} />
            <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
            <span>{t("processing.exposure.view")}</span>
          </label>}
          <label className="patterns-exposure__pause">
            <span>{t("processing.exposure.pause")}</span>
            <div className="patterns-exposure__pause-shell">
              <div className="patterns-exposure__pause-slider">
                <div className="patterns-exposure__pause-track" />
                <div className="patterns-exposure__pause-ticks" aria-hidden="true">
                  {Array.from({length: 13}, (_, index) => {
                    const value = index + 3;
                    const major = value % 3 === 0 || value === 15;
                    return <span key={value} className={major ? "patterns-exposure__pause-tick--major" : ""}
                      style={{left: `${index / 12 * 100}%`}}>{major && <i>{value}</i>}</span>;
                  })}
                </div>
                <input type="range" min={3} max={15} step={1} value={state.viewPauseSeconds}
                  aria-label={t("processing.exposure.pause")}
                  aria-valuetext={`${state.viewPauseSeconds} ${t("processing.exposure.seconds")}`}
                  onChange={event => dispatch(setExposureViewPauseSeconds(Number(event.target.value)))} />
              </div>
            </div>
          </label>
        </div>
        {state.phase === "paused" && <p className="scan-inline-note" role="status">{t("processing.exposure.paused").replace("{step}", state.progress.find(n => n.id === state.pausedAfterId)?.caption ?? "")}</p>}
        {serialRequired && <p className="scan-inline-error">{t("processing.exposure.serialRequired")}</p>}
  </div>;
}
