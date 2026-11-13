import { useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../store";
import { setStairStepField, setStairSteps, type PatternInstance } from "../store/processingSlice";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  defaultStairStep, parseStairStepsImport, resolveStairSteps, stairStepsError, stairStepsToCsv,
  STAIR_AFTER_VALUES, type StairAfter, type StairStep, type StairStepOverride,
} from "../lib/stairRecipe";

type NumericField = "depth" | "dwell" | "overlap" | "passes" | "removalRate";

/** One recipe cell. Empty = inherit the card-level default (shown as the placeholder). */
function Cell({ label, value, placeholder, disabled, integer, title, onCommit }: {
  label: string; value: number | undefined; placeholder: number; disabled: boolean; integer?: boolean; title?: string;
  onCommit: (value: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => { setText(cur => (cur !== "" && Number(cur) === value) || (cur === "" && value === undefined) ? cur : value === undefined ? "" : String(value)); }, [value]);
  const invalid = text.trim() !== "" && (!Number.isFinite(Number(text)) || (integer && !Number.isInteger(Number(text))));
  return (
    <input className="input stair-steps__input" type="text" inputMode={integer ? "numeric" : "decimal"} aria-label={label} title={title ?? label}
      aria-invalid={invalid} data-invalid={invalid || undefined} disabled={disabled} value={text} placeholder={String(placeholder)}
      onChange={e => {
        const v = e.target.value;
        setText(v);
        if (v.trim() === "") onCommit(undefined);
        else if (Number.isFinite(Number(v)) && (!integer || Number.isInteger(Number(v)))) onCommit(Number(v));
      }} />
  );
}

/** Per-step recipe for Stair cut: each step may remove a different layer, so it has its own parameters. */
export function StairStepsTable({ patternKey, caption, instance, disabled }: {
  patternKey: string; caption: string; instance: PatternInstance; disabled: boolean;
}) {
  const dispatch = useAppDispatch();
  const materials = useAppSelector(state => state.processing.materials);
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => { const x = t(key as TranslationKey); return x === key ? fallback : x; };
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const overrides: ReadonlyArray<StairStepOverride | undefined> = instance.stairSteps ?? [];
  const defaultMaterial = materials[0]?.name ?? "";
  const resolved = resolveStairSteps(instance.parameters, overrides).map(step => ({
    ...step,
    material: step.material || defaultMaterial,
  }));
  const problem = stairStepsError(resolved);
  const set = (index: number, field: keyof StairStep, value: number | string | boolean | undefined) =>
    dispatch(setStairStepField({ key: patternKey, index, field, value }));
  const num = (index: number, field: NumericField, label: string, integer = false) => {
    const step = resolved[index];
    const material = materials.find(item => item.name === step?.material);
    const value = field === "removalRate"
      ? (overrides[index]?.removalRate && overrides[index]!.removalRate! > 0
        ? overrides[index]!.removalRate : material?.removalRateUM3PerNC)
      : overrides[index]?.[field];
    return <Cell label={`${caption} ${tr("processing.stair.step", "Step")} ${index + 1}: ${label}`}
      title={field === "removalRate" ? material?.removalRateSource : undefined} value={value}
      placeholder={field === "removalRate" ? 0 : defaultStairStep(instance.parameters, index)[field]} disabled={disabled} integer={integer}
      onCommit={v => set(index, field, v)} />
  };

  return (
    <fieldset className="stair-steps" disabled={disabled} data-stair-steps={patternKey}>
      <legend>{tr("processing.stair.title", "Step recipe")}</legend>
      <p className="stair-steps__help">{tr("processing.stair.help",
        "Each step removes its own layer. Leave a cell empty to use the card value above. Depth is cumulative. With a calibrated Sr, passes follow the layer this step adds; otherwise Passes is used. Beam current is not per step: set the instrument current before starting.")}</p>
      <div className="stair-steps__scroll">
        <table className="stair-steps__table">
          <thead><tr>
            <th>#</th><th>{tr("processing.stair.on", "On")}</th><th>{tr("processing.stair.depth", "Depth (µm)")}</th>
            <th>{tr("processing.stair.material", "Material")}</th><th>{tr("processing.stair.sr", "Sr (µm³/nC)")}</th>
            <th>{tr("processing.stair.dwell", "Dwell (µs)")}</th><th>{tr("processing.stair.overlap", "Overlap (%)")}</th>
            <th>{tr("processing.stair.passes", "Passes")}</th>
            <th>{tr("processing.stair.after", "After step")}</th>
          </tr></thead>
          <tbody>
            {resolved.map((step, i) => (
              <tr key={i} data-step={i + 1}>
                <td>{i + 1}</td>
                <td><input type="checkbox" checked={step.enabled} disabled={disabled}
                  aria-label={`${caption} ${tr("processing.stair.step", "Step")} ${i + 1}: ${tr("processing.stair.on", "On")}`}
                  onChange={e => set(i, "enabled", e.target.checked ? undefined : false)} /></td>
                <td>{num(i, "depth", tr("processing.stair.depth", "Depth (µm)"))}</td>
                <td><select className="select stair-steps__input stair-steps__material" value={resolved[i].material} disabled={disabled}
                  aria-label={`${caption} ${tr("processing.stair.step", "Step")} ${i + 1}: ${tr("processing.stair.material", "Material")}`}
                  onChange={e => set(i, "material", e.target.value === "" ? undefined : e.target.value)}>
                  {materials.map(material => <option key={material.name} value={material.name}>{material.caption ?? material.name}</option>)}
                </select></td>
                <td>{num(i, "removalRate", tr("processing.stair.sr", "Sr (µm³/nC)"))}</td>
                <td>{num(i, "dwell", tr("processing.stair.dwell", "Dwell (µs)"))}</td>
                <td>{num(i, "overlap", tr("processing.stair.overlap", "Overlap (%)"))}</td>
                <td>{num(i, "passes", tr("processing.stair.passes", "Passes"), true)}</td>
                <td><select className="select stair-steps__after" value={step.after} disabled={disabled}
                  aria-label={`${caption} ${tr("processing.stair.step", "Step")} ${i + 1}: ${tr("processing.stair.after", "After step")}`}
                  title={tr("processing.stair.afterHelp", "View takes one full-field frame after the step. View + pause then waits for Resume. Nothing is paused after the last step.")}
                  onChange={e => set(i, "after", e.target.value === "none" ? undefined : (e.target.value as StairAfter))}>
                  {STAIR_AFTER_VALUES.map(v => <option key={v} value={v}>{tr(`processing.stair.after.${v}`, v === "none" ? "Continue" : v === "view" ? "View" : "View + pause")}</option>)}
                </select></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(problem || message) && <p className="stair-steps__message" role="alert">{message ?? problem}</p>}
      <div className="stair-steps__actions">
        <button type="button" className="btn btn--small" disabled={disabled} onClick={() => fileInput.current?.click()}>{tr("processing.stair.import", "Import")}</button>
        <button type="button" className="btn btn--small" onClick={() => {
          const url = URL.createObjectURL(new Blob([stairStepsToCsv(resolved)], { type: "text/csv" }));
          const a = document.createElement("a");
          a.href = url; a.download = `${patternKey}-steps.csv`; a.click();
          URL.revokeObjectURL(url);
        }}>{tr("processing.stair.export", "Export")}</button>
        <button type="button" className="btn btn--small" disabled={disabled || !instance.stairSteps} onClick={() => { setMessage(null); dispatch(setStairSteps({ key: patternKey, steps: null })); }}>
          {tr("processing.stair.reset", "Reset")}</button>
        <input ref={fileInput} type="file" accept=".csv,.json,text/csv,application/json" hidden aria-label={`${caption}: ${tr("processing.stair.import", "Import")}`}
          onChange={async e => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              const steps = parseStairStepsImport(await file.text());
              const error = stairStepsError(resolveStairSteps({ ...instance.parameters, steps: Math.max(2, steps.length) }, steps));
              if (error) throw new Error(error);
              setMessage(null);
              dispatch(setStairSteps({ key: patternKey, steps }));
            } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
          }} />
      </div>
    </fieldset>
  );
}
