import { useTranslation } from "../i18n";
import { useAppDispatch, useAppSelector } from "../store";
import { useExposureRun } from "../hooks/useExposureRun";
import { useOtherWorkspaceBusy } from "../hooks/useScanWorkspace";
import { exposureBusy, setExposureParallel } from "../store/exposureSlice";
import { Icon } from "./Icon";

export function ExposureControls({disabled = false, showView = true}: {disabled?: boolean; showView?: boolean}) {
  const {t} = useTranslation(), dispatch = useAppDispatch();
  const {state, start, stop, view} = useExposureRun();
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
          {showView && <button type="button" className="btn btn--primary"
            disabled={disabled || !defaultsReady || scanBusy || otherBusy || state.phase === "preparing" || state.phase === "stopping" || viewBusy}
            aria-busy={state.viewPhase === "queued" || state.viewPhase === "scanning"}
            title={t("processing.exposure.viewHelp")} onClick={view}><Icon name="eye" />{t("processing.exposure.view")}</button>}
          <button type="button" className="btn btn--stop" disabled={!busy || state.phase === "stopping"}
            onClick={() => void stop()}><Icon name="hand" />{t("scan.stop")}</button>
          <button type="button" className="btn btn--primary" disabled={startDisabled}
            title={serialRequired ? t("processing.exposure.serialRequired") : t("processing.exposure.startHelp")}
            onClick={() => void start()}><Icon name="play" tone="success" />{t("processing.exposure.start")}</button>
        </div>
        {serialRequired && <p className="scan-inline-error">{t("processing.exposure.serialRequired")}</p>}
  </div>;
}
