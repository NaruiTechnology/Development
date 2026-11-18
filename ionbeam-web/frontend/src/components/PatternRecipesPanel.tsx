import { selectedEquipmentId } from "../lib/adminActivity";
import { Icon } from "./Icon";
import { RecipeStepsGrid } from "./RecipeStepsGrid";
import { NumberStepperInput } from "./NumberStepperField";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { apiUrl } from "../lib/backendUrl";
import { readJsonResponse } from "../lib/readJsonResponse";
import { normalizeRecipeImport, patternRecipeApi, type RecipeDocument } from "../lib/patternRecipeApi";
import { type StairRecipeDefaults } from "../lib/stairRecipe";
import type { EquipmentRow } from "../lib/equipmentModel";
import { useAppDispatch } from "../store";
import { fetchProcessingPatterns } from "../store/processingSlice";

const newStep = (index: number): StairRecipeDefaults => ({enabled: true, depthUM: (index + 1) * 0.2,
  material: "Si", removalRateUM3PerNC: 0, dwellUS: 1, overlapPercent: 50, passes: 1, after: "none"});
const newDocument = (): RecipeDocument => [{SMProcess: {model: "StairRecipeDefaults", caption: "",
  stepDefaults: {dwellUS: 1, overlapPercent: 50, passes: 1, after: "none"}, nodes: [{name: "Default", steps: [newStep(0), newStep(1)]}]}}];

export function PatternRecipesPanel({equipment, initialEquipmentId, canManage, onSaved}: {
  equipment: EquipmentRow[]; initialEquipmentId: number | null; canManage: boolean; onSaved: () => void;
}) {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const [equipmentId, setEquipmentId] = useState<number | null>(initialEquipmentId ?? (equipment.find(row => row.id === selectedEquipmentId())?.id) ?? equipment[0]?.id ?? null);
  const [patternKey, setPatternKey] = useState("stairCut");
  const [patterns, setPatterns] = useState<Array<{key: string; caption: string}>>([]);
  const [draft, setDraft] = useState<RecipeDocument>([]);
  const [collectionIndex, setCollectionIndex] = useState(0);
  const [nodeIndex, setNodeIndex] = useState(0);
  const [nodeEditor, setNodeEditor] = useState<{index: number | null; name: string} | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const blocked = !canManage || !loaded || loading || saving;
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/processing/patterns")).then(async response => {
      const data = await readJsonResponse<{patterns?: Array<{key: string; caption: string}>; error?: string}>(response, "patterns");
      if (!response.ok) throw new Error(data.error ?? "Cannot load patterns");
      if (!cancelled) setPatterns(data.patterns ?? []);
    }).catch(e => { if (!cancelled) setError(String(e.message ?? e)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setNodeEditor(null); setLoaded(false); setDraft([]); setDirty(false); setError(null); setNotice(null); setCollectionIndex(0); setNodeIndex(0);
    if (!equipmentId) {setLoading(false); return;}
    setLoading(true);
    patternRecipeApi.get(equipmentId, patternKey).then(({recipe}) => {
      if (cancelled) return;
      setDraft(recipe?.collections ?? []); setRevision(recipe?.revision ?? 0); setLoaded(true);
    }).catch(e => { if (!cancelled) setError(String(e.message ?? e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [equipmentId, patternKey, reload]);
  const entry = draft[collectionIndex];
  const collectionName = entry ? Object.keys(entry)[0] : "";
  const collection = entry?.[collectionName];
  const node = collection?.nodes[nodeIndex];
  function edit(change: (next: RecipeDocument) => void) {
    const next = structuredClone(draft); change(next); setDraft(next); setDirty(true); setNotice(null);
  }
  function editDefault(field: "dwellUS" | "overlapPercent" | "passes" | "after", value: number | string) {
    edit(next => {
      const target = next[collectionIndex][collectionName];
      const previous = target.stepDefaults[field];
      for (const item of target.nodes) for (const step of item.steps) {
        if (step[field] === previous) Object.assign(step, {[field]: value});
      }
      Object.assign(target.stepDefaults, {[field]: value});
    });
  }
  async function createRecipe() {
    if (blocked) return;
    setLoading(true); setError(null);
    try {
      const defaults = patternKey === "stairCut" ? await patternRecipeApi.defaults(patternKey) : newDocument();
      setDraft(defaults); setNodeIndex(0); setCollectionIndex(0); setDirty(true);
    } catch (e) {setError(e instanceof Error ? e.message : String(e));}
    finally {setLoading(false);}
  }
  async function save() {
    if (!equipmentId || blocked) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const {recipe} = await patternRecipeApi.save(equipmentId, patternKey, draft, revision);
      setDraft(recipe.collections); setRevision(recipe.revision); setDirty(false); setNotice(t("recipes.saved"));
      onSaved(); void dispatch(fetchProcessingPatterns());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  return <section className="pattern-recipes" aria-label={t("recipes.title")}>
    <h4>{t("recipes.title")}</h4>
    <div className="button-row">
      <label>{t("recipes.equipment")} <select className="select" aria-label={t("recipes.equipment")} value={equipmentId ?? ""}
        disabled={loading || saving || dirty} onChange={e => setEquipmentId(Number(e.target.value))}>
        {!equipment.length && <option value="">{t("recipes.noEquipment")}</option>}
        {equipment.map(row => <option key={row.id} value={row.id ?? ""}>#{row.id} {row.name} · {row.site} · {row.serial_number}</option>)}
      </select></label>
      <label>{t("recipes.pattern")} <select className="select" aria-label={t("recipes.pattern")} value={patternKey}
        disabled={loading || saving || dirty} onChange={e => setPatternKey(e.target.value)}>
        {patterns.map(pattern => <option key={pattern.key} value={pattern.key}>{pattern.caption}</option>)}
      </select></label>
      {!dirty && <button type="button" className="btn" disabled={loading || saving} onClick={() => setReload(n => n + 1)}>{t("recipes.reload")}</button>}
      <button type="button" className="btn" disabled={blocked || !equipmentId} onClick={() => fileInput.current?.click()}>{t("recipes.import")}</button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        try { if (file.size > 1000000) throw new Error(t("recipes.fileTooLarge"));
          setDraft(normalizeRecipeImport(JSON.parse(await file.text()))); setCollectionIndex(0); setNodeIndex(0); setDirty(true); setNotice(null); setError(null);
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      }}/>
    </div>
    {loading && <p role="status">{t("recipes.loading")}</p>}
    {error && <p role="alert" className="pattern-recipes__error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!canManage && <p>{t("recipes.readOnly")}</p>}
    {dirty && <p>{t("recipes.unsaved")}</p>}
    {!loading && !draft.length && equipmentId && !error && <p>{t("recipes.empty")} <button type="button" className="btn" disabled={blocked}
      onClick={() => void createRecipe()}>{t("recipes.create")}</button></p>}
    {collection && <>
      <div className="button-row">
        <label>{t("recipes.collection")} <select className="select" value={collectionIndex} onChange={e => {setCollectionIndex(Number(e.target.value)); setNodeIndex(0);}}>
          {draft.map((item, index) => <option key={index} value={index}>{Object.keys(item)[0]}</option>)}
        </select></label>
        <label>{t("recipes.caption")} <input className="input" value={collection.caption} disabled={blocked}
          onChange={e => edit(next => {next[collectionIndex][collectionName].caption = e.target.value;})}/></label>
      </div>
      <fieldset disabled={blocked}><legend>{t("recipes.defaults")}</legend><div className="button-row">
        {(["dwellUS", "overlapPercent", "passes"] as const).map(field => <label key={field}>{t(`recipes.${field}`)}
          <NumberStepperInput value={collection.stepDefaults[field]} disabled={blocked} ariaLabel={t(`recipes.${field}`)}
            step={field === "dwellUS" ? 0.125 : 1} min={field === "dwellUS" ? 0.125 : field === "passes" ? 1 : 0}
            max={field === "dwellUS" ? 8192 : field === "passes" ? 10000 : 99}
            onValueChange={value => editDefault(field, Number(value))}/></label>)}
        <label>{t("recipes.after")} <select className="select" value={collection.stepDefaults.after} onChange={e => editDefault("after", e.target.value)}>
          {(["none", "view", "viewPause"] as const).map(value => <option key={value} value={value}>{t(`recipes.after.${value}`)}</option>)}
        </select></label>
      </div></fieldset>
      <div className="button-row">
        <label>{t("recipes.node")} <select className="select" aria-label={t("recipes.node")} value={nodeIndex} onChange={e => setNodeIndex(Number(e.target.value))}>
          {collection.nodes.map((item, i) => <option key={i} value={i}>{item.name}</option>)}
        </select></label>
        <button type="button" className="btn" disabled={blocked} onClick={() => {
          setNodeError(null); setNodeEditor({index: null, name: ""});
        }}>{t("recipes.addNode")}</button>
        <button type="button" className="btn btn--ghost" disabled={blocked || !node} aria-label={t("recipes.editNode")}
          title={t("recipes.editNode")} onClick={() => {setNodeError(null); setNodeEditor({index: nodeIndex, name: node.name});}}>
          <Icon name="edit" tone="accent" />
        </button>
        <button type="button" className="btn" disabled={blocked || collection.nodes.length <= 1} onClick={() => {
          edit(next => {next[collectionIndex][collectionName].nodes.splice(nodeIndex, 1);}); setNodeIndex(0);
        }}>{t("recipes.removeNode")}</button>
      </div>
      {node && <div key={`${collectionIndex}:${nodeIndex}`}>
        <RecipeStepsGrid steps={node.steps} defaults={collection.stepDefaults} disabled={blocked}
          onChange={steps => edit(next => {next[collectionIndex][collectionName].nodes[nodeIndex].steps = steps;})} />
      </div>}
      {nodeEditor && <div className="equipment-edit-backdrop" role="presentation"
        onKeyDown={event => {if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); setNodeEditor(null);}}}>
        <div className="modal equipment-edit-dialog recipe-node-dialog" role="dialog" aria-modal="true" aria-labelledby="recipe-node-title">
          <div className="modal__header"><div className="modal__title" id="recipe-node-title">{t(nodeEditor.index === null ? "recipes.addNode" : "recipes.editNode")}</div></div>
          <div className="modal__body"><label>{t("recipes.nodeName")}<input className="input" autoFocus aria-label={t("recipes.nodeName")}
            value={nodeEditor.name} onChange={event => setNodeEditor({...nodeEditor, name: event.target.value})}/></label>
            {nodeError && <p role="alert" className="pattern-recipes__error">{nodeError}</p>}
          </div>
          <div className="modal__footer equipment-edit-dialog__footer">
            <button type="button" className="btn btn--cancel" onClick={() => setNodeEditor(null)}>{t("recipes.cancel")}</button>
            <button type="button" className="btn btn--primary" disabled={blocked} onClick={() => {
              const name = nodeEditor.name.trim();
              if (!name || collection.nodes.some((item, i) => i !== nodeEditor.index && item.name === name)) {
                setNodeError(t("recipes.uniqueNode")); return;
              }
              edit(next => {
                const nodes = next[collectionIndex][collectionName].nodes;
                if (nodeEditor.index === null) nodes.push({name, steps: [0, 1].map(i => ({...newStep(i), ...collection.stepDefaults}))});
                else nodes[nodeEditor.index].name = name;
              });
              if (nodeEditor.index === null) setNodeIndex(collection.nodes.length);
              setNodeEditor(null);
            }}>{t("recipes.update")}</button>
          </div>
        </div>
      </div>}
      <div className="pattern-recipes__save-actions">
        <button type="button" className="btn btn--cancel" disabled={saving || !dirty} onClick={() => {setReload(n => n + 1);}}>{t("recipes.cancelChanges")}</button>
        <button type="button" className="btn btn--primary" disabled={blocked || !dirty} onClick={() => void save()}>{t(saving ? "recipes.saving" : "recipes.save")}</button>
      </div>
      <p className="settings-form__hint">{t("recipes.revision", {revision})}</p>
    </>}
  </section>;
}
