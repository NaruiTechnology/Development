import { useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { lookupSpotSize } from "../lib/lensLookup";
import { useAppDispatch, useAppSelector } from "../store";
import { fetchProcessingPatterns } from "../store/processingSlice";
import { HelpPopover } from "./HelpPopover";
import { NumberStepperField } from "./NumberStepperField";

export function ProcessingPatternsHelp() {
  const {t}=useTranslation();
  const dispatch=useAppDispatch();
  const {lensLookup:table,status,error,entryErrors}=useAppSelector(s=>s.processing);
  const [voltage,setVoltage]=useState(30), [current,setCurrent]=useState("150"), [interpolate,setInterpolate]=useState(false);
  useEffect(()=>{ if(status === "idle") void dispatch(fetchProcessingPatterns()); },[status,dispatch]);
  const voltages=table ? [...new Set(table.rows.map(r=>r.beamVoltageKV))].sort((a,b)=>b-a) : [];
  const voltageKey=voltages.join(",");
  useEffect(()=>{ if(voltages.length && !voltages.includes(voltage)) setVoltage(voltages[0]); },[voltageKey,voltage]);
  let result: ReturnType<typeof lookupSpotSize> | null=null;
  if(table && current.trim() !== "" && Number.isFinite(Number(current)) && Number(current)>0) result=lookupSpotSize(table,voltage,Number(current),interpolate);
  const selected=new Set(result?.sourceRows ?? []);
  return <HelpPopover title={t("help.patterns.title")} ariaLabel={t("help.patterns.aria")} size="fit">
    <p>{t("help.patterns.intro")}</p>
    <h3>{t("help.patterns.material")}</h3>
    <p>{t("help.patterns.materialText")}</p>
    <h3>{t("help.patterns.latticeFit")}</h3>
    <p>{t("help.patterns.latticeFitText")}</p>
    {status === "loading" && <p role="status">{t("help.patterns.loading")}</p>}
    {status === "error" && <p role="alert">{error}</p>}
    {!table && status !== "loading" && <><p>{entryErrors.find(e=>e.startsWith("LensLookup:")) ?? t("help.patterns.noData")}</p>
      <button className="btn" type="button" onClick={()=>void dispatch(fetchProcessingPatterns())}>{t("help.patterns.retry")}</button></>}
    {table && <>
      <p><strong>{table.source.file}</strong> · {table.source.sheet} · {table.source.range}</p>
      <h3>{t("help.patterns.lookup")}</h3>
      <div className="lens-lookup-controls">
        <label className="field">{t("help.patterns.voltage")} (kV)
          <select className="select" value={voltage} aria-label={t("help.patterns.voltage")} onChange={e=>setVoltage(Number(e.target.value))}>
            {voltages.map(v=><option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <NumberStepperField label={`${t("processing.param.common.beamCurrent")} (pA)`} ariaLabel={`${t("processing.param.common.beamCurrent")} (pA)`}
          value={current} onValueChange={setCurrent} step={1} min={0.001} fractionDigits={2} invalid={!result} />
      </div>
      <label className="checkbox"><input type="checkbox" checked={interpolate} onChange={e=>setInterpolate(e.target.checked)} />{t("help.patterns.interpolate")}</label>
      <p className="muted">{t("help.patterns.range")}</p>
      <p role="status" className="lens-lookup-result">
        {t("help.patterns.spotSize")}: <output aria-label={t("help.patterns.spotSize")}>{result?.spotSizeNM != null
          ? `${result.spotSizeNM.toFixed(2)} nm (${result.spotSizeUM!.toFixed(4)} µm)` : "—"}</output>
        {` · ${t(result?.status === "exact" ? "help.patterns.exact" : result?.status === "interpolated" ? "help.patterns.interpolated" : "help.patterns.unavailable")}`}
        {!!result?.sourceRows.length && <span> · {t("help.patterns.rows")}: {result.sourceRows.join(", ")}</span>}
      </p>
      {result?.requiresSLF && <p>{t("help.patterns.slf")}</p>}
      <h3>{t("help.patterns.table")}</h3>
      <p>1 Å = 0.1 nm = 0.0001 µm</p>
      <div className="lens-reference-table" tabIndex={0} role="region" aria-label={t("help.patterns.table")}>
        <table>
          <caption>{table.name}</caption>
          <thead><tr><th>{t("help.patterns.rows")}</th><th>{t("help.patterns.steps")}</th><th>kV</th><th>{t("help.patterns.aperture")} (µm)</th><th>pA</th><th>Lens 1 (kV)</th><th>Spot (Å)</th><th>Spot (nm)</th></tr></thead>
          <tbody>{table.rows.map(row=><tr key={row.sourceRow} data-source-row={row.sourceRow} className={selected.has(row.sourceRow) ? "lens-reference-row--selected" : undefined}>
            <td>{row.sourceRow}</td><td>{row.stepsBetweenApertures ?? "—"}</td><td>{row.beamVoltageKV}</td><td>{row.apertureDiameterUM}</td>
            <td>{row.beamCurrentPA}</td><td>{row.lens1KV}</td><td>{row.spotSizeAngstrom}</td><td>{row.spotSizeAngstrom/10}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <h3>{t("help.patterns.notes")}</h3>
      <ul>{table.notes.map(note=><li key={note.sourceRow}>{note.text}</li>)}</ul>
      <h3>{t("help.patterns.depth")}</h3>
      <p>{t("help.patterns.depthText")}</p>
      <p className="lens-depth-formula">Depth (µm) = I (pA) × exposure (s) × rate (µm³/nC) / (1000 × area (µm²))</p>
    </>}
  </HelpPopover>;
}
