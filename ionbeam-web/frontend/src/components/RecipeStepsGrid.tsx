import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useTranslation } from "../i18n";
import { adminGridTheme } from "../lib/agGridTheme";
import { stairStepsError, type StairRecipeCollection, type StairRecipeDefaults } from "../lib/stairRecipe";
import { NumberStepperInput } from "./NumberStepperField";
import { Icon } from "./Icon";

type StepRow = StairRecipeDefaults & { index: number };
type GridContext = {
  disabled: boolean; count: number; editLabel: string; deleteLabel: string;
  edit: (index: number) => void; remove: (index: number) => void;
};
function StepActionsCell({ data, context }: ICellRendererParams<StepRow, unknown, GridContext>) {
  if (!data) return null;
  return <div className="settings-admin-table__actions">
    <button type="button" className="modal__close" disabled={context.disabled}
      aria-label={`${context.editLabel} ${data.index + 1}`} title={context.editLabel} onClick={() => context.edit(data.index)}>
      <Icon name="edit" tone="accent" />
    </button>
    <button type="button" className="modal__close" disabled={context.disabled || context.count <= 2}
      aria-label={`${context.deleteLabel} ${data.index + 1}`} title={context.deleteLabel} onClick={() => context.remove(data.index)}>
      <Icon name="trash" tone="danger" />
    </button>
  </div>;
}

export function RecipeStepsGrid({ steps, defaults, disabled, onChange }: {
  steps: StairRecipeDefaults[]; defaults: StairRecipeCollection["stepDefaults"];
  disabled: boolean; onChange: (steps: StairRecipeDefaults[]) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{index: number; step: StairRecipeDefaults} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo<StepRow[]>(() => steps.map((step, index) => ({...step, index})), [steps]);
  const columns = useMemo<ColDef<StepRow>[]>(() => [
    {field: "index", headerName: "#", width: 55, valueFormatter: p => String(Number(p.value) + 1)},
    {field: "enabled", headerName: t("recipes.enabled"), width: 85, cellDataType: false,
      cellRenderer: (p: ICellRendererParams<StepRow>) => <input type="checkbox" checked={Boolean(p.value)} readOnly disabled aria-label={`${t("recipes.enabled")} ${(p.data?.index ?? 0) + 1}`} />},
    {field: "depthUM", headerName: t("recipes.depthUM"), minWidth: 100, flex: 1},
    {field: "material", headerName: t("recipes.material"), minWidth: 90, flex: 1},
    {field: "removalRateUM3PerNC", headerName: t("recipes.removalRateUM3PerNC"), minWidth: 115, flex: 1},
    {field: "dwellUS", headerName: t("recipes.dwellUS"), minWidth: 100, flex: 1},
    {field: "overlapPercent", headerName: t("recipes.overlapPercent"), minWidth: 110, flex: 1},
    {field: "passes", headerName: t("recipes.passes"), minWidth: 85, flex: 1},
    {field: "after", headerName: t("recipes.after"), minWidth: 125, flex: 1,
      valueFormatter: p => t(`recipes.after.${p.value as StairRecipeDefaults["after"]}`)},
    {colId: "actions", headerName: t("recipes.actions"), width: 94, pinned: "right", resizable: false, cellRenderer: StepActionsCell},
  ], [t]);
  const context: GridContext = {
    disabled, count: steps.length, editLabel: t("recipes.editStep"), deleteLabel: t("recipes.removeStep"),
    edit: index => { if (!disabled) {setError(null); setEditing({index, step: {...steps[index]}});} },
    remove: index => { if (!disabled && steps.length > 2) onChange(steps.filter((_, i) => i !== index)); },
  };
  function update(step: StairRecipeDefaults) {
    if (!editing || disabled) return;
    const next = steps.map(item => ({...item}));
    if (editing.index === steps.length) next.push(step); else next[editing.index] = step;
    const problem = stairStepsError(next.map(item => ({enabled: item.enabled, depth: item.depthUM,
      material: item.material, removalRate: item.removalRateUM3PerNC, dwell: item.dwellUS,
      overlap: item.overlapPercent, passes: item.passes, after: item.after})));
    if (problem || !step.material.trim() || next.some((item, i) => i > 0 && item.depthUM <= next[i - 1].depthUM)) {
      setError(problem ?? t(!step.material.trim() ? "recipes.materialRequired" : "recipes.depthOrder")); return;
    }
    onChange(next); setEditing(null); setError(null);
  }
  return <>
    <div className="pattern-recipes__grid-toolbar">
      <span>{t("recipes.steps")}</span>
      <button type="button" className="btn btn--ghost" disabled={disabled || steps.length >= 50}
        aria-label={t("recipes.addStep")} title={t("recipes.addStep")} onClick={() => {
          setError(null); setEditing({index: steps.length, step: {...defaults, enabled: true,
            depthUM: (steps.at(-1)?.depthUM ?? 0) + 0.2, material: "Si", removalRateUM3PerNC: 0}});
        }}><Icon name="plus" tone="accent" /></button>
    </div>
    <div className="pattern-recipes__grid" style={{height: Math.min(400, Math.max(154, 36 * steps.length + 58))}}>
      <AgGridReact<StepRow> theme={adminGridTheme} rowData={rows} columnDefs={columns}
        defaultColDef={{editable: false, sortable: false, filter: false, resizable: true, suppressMovable: true}}
        getRowId={p => String(p.data.index)} context={context} rowHeight={36} domLayout="normal" />
    </div>
    {editing && <StepEditDialog key={editing.index} step={editing.step} index={editing.index} adding={editing.index === steps.length}
      disabled={disabled} error={error} onCancel={() => {setEditing(null); setError(null);}} onUpdate={update} />}
  </>;
}

function StepEditDialog({step, index, adding, disabled, error, onCancel, onUpdate}: {
  step: StairRecipeDefaults; index: number; adding: boolean; disabled: boolean; error: string | null;
  onCancel: () => void; onUpdate: (step: StairRecipeDefaults) => void;
}) {
  const {t} = useTranslation();
  const [draft, setDraft] = useState({...step});
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = typeof document === "undefined" ? null : document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("input:not(:disabled)")?.focus();
    return () => previous?.focus?.();
  }, []);
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); onCancel();}
    if (event.key === "Tab") {
      const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)");
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
    }
  }
  return <div className="equipment-edit-backdrop" role="presentation" onKeyDown={onKeyDown}
    onMouseDown={e => {if (e.target === e.currentTarget) onCancel();}}>
    <div ref={dialog} className="modal equipment-edit-dialog recipe-step-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal__header"><div id={titleId} className="modal__title">{t(adding ? "recipes.addStep" : "recipes.editStep")} {index + 1}</div>
        <button type="button" className="modal__close" aria-label={t("recipes.cancel")} onClick={onCancel}><Icon name="x" /></button>
      </div>
      <div className="modal__body equipment-edit-dialog__body">
        <label>{t("recipes.enabled")}<input type="checkbox" checked={draft.enabled} disabled={disabled} aria-label={t("recipes.enabled")}
          onChange={e => setDraft({...draft, enabled: e.target.checked})}/></label>
        <label>{t("recipes.material")}<input className="input" value={draft.material} disabled={disabled} aria-label={t("recipes.material")}
          onChange={e => setDraft({...draft, material: e.target.value})}/></label>
        {(["depthUM", "removalRateUM3PerNC", "dwellUS", "overlapPercent", "passes"] as const).map(field => <label key={field}>{t(`recipes.${field}`)}
          <NumberStepperInput value={draft[field]} disabled={disabled} ariaLabel={t(`recipes.${field}`)}
            step={field === "depthUM" ? 0.1 : field === "removalRateUM3PerNC" ? 0.01 : field === "dwellUS" ? 0.125 : 1}
            min={field === "depthUM" ? 0.001 : field === "dwellUS" ? 0.125 : field === "passes" ? 1 : 0}
            max={field === "dwellUS" ? 8192 : field === "passes" ? 10000 : field === "overlapPercent" ? 99 : undefined}
            onValueChange={value => setDraft({...draft, [field]: Number(value)})}/>
        </label>)}
        <label>{t("recipes.after")}<select className="select" value={draft.after} disabled={disabled} aria-label={t("recipes.after")}
          onChange={e => setDraft({...draft, after: e.target.value as StairRecipeDefaults["after"]})}>
          {(["none", "view", "viewPause"] as const).map(value => <option key={value} value={value}>{t(`recipes.after.${value}`)}</option>)}
        </select></label>
        {error && <p role="alert" className="pattern-recipes__error recipe-step-dialog__error">{error}</p>}
      </div>
      <div className="modal__footer equipment-edit-dialog__footer">
        <button type="button" className="btn btn--cancel" onClick={onCancel}>{t("recipes.cancel")}</button>
        <button type="button" className="btn btn--primary" disabled={disabled} onClick={() => onUpdate(draft)}>{t("recipes.update")}</button>
      </div>
    </div>
  </div>;
}
