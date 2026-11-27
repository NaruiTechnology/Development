/**
 * Content of the Processing tab: the (not collapsible) "Patterns" card with one icon per pattern, followed by one
 * collapsible card per pattern (ProcessingPatternCards). Both use the catalogue the backend serves from processingPatterns.json
 * (entries marked skip never arrive), and every card is bound to its pattern instance in the processing slice.
 *
 * Picking an icon arms drawing on the image canvas (PatternOverlay); picking it again disarms.
 * The active icon also controls which pattern card is expanded, keeping both selections aligned.
 */
import { useEffect, useMemo, useState } from "react";

import { useTranslation, type TranslationKey } from "../i18n";
import { materialTargetGrayLevel } from "../lib/processingWorkflows";
import {
  MODEL_REGISTRY,
  patternParameterError,
  lineEndpoints,
  type CircleRoi,
  type ParameterSpec,
  type ParameterValue,
  type PatternRoi,
  type PatternSpec,
  type PolygonRoi,
  type RectRoi,
  type RingRoi,
} from "../lib/processingPatterns";
import { useAppDispatch, useAppSelector } from "../store";
import { fetchProcessingPatterns, setPatternMaterial, setPatternWorkflow, selectPattern, setPatternEnabled, setPatternParameter, type PatternInstance } from "../store/processingSlice";
import { Icon } from "./Icon";
import { NumberStepperField } from "./NumberStepperField";
import { StairRecipeCard } from "./StepRecipe";
import { PatternTableCustom, PatternTableTabs, usePatternTableTab } from "./PatternTable";
import { DefaultPatternWedges } from "./DefaultPatternWedges";
import { PatternRuntimeReadouts } from "./PatternRuntimeReadouts";
import { plannedPatternExposureMetrics } from "../lib/patternExposure";
import { ProcessingWorkflowPanel } from "./ProcessingWorkflowPanel";
import { VectorScanPathPreview } from "./VectorScanPathPreview";
import { unitLabel } from "./ROIEditor";
import { prepareExposureSequence, maxLatticeSpotsPerRequest, MAX_LATTICE_SPOTS_PER_REQUEST } from "../lib/exposureSequence";

import { ExposureControls, MillingRegistrationPanel } from "./ExposureControls";
import { millingRegistrationOptions, millingRegistrationSelection } from "../lib/millingRegistration";
import { LoadingSpinner } from "./LoadingSpinner";

const MATERIAL_WORKFLOW = "MaterialLinelCut";

/** Translation with the JSON's English text as fallback for keys the locale tables do not know. */
function useTr() {
  const { t, fmt } = useTranslation();
  const tr = (key: string, fallback: string) => {
    const text = t(key as TranslationKey);
    return text === key ? fallback : text;
  };
  return { t, fmt, tr };
}

export function ProcessingPatternsPanel({ disabled, exposureDisabled = disabled, visible = true, imageAvailable = false }: {
  disabled: boolean;
  exposureDisabled?: boolean;
  visible?: boolean;
  imageAvailable?: boolean;
}) {
  const dispatch = useAppDispatch();
  const { t, tr } = useTr();
  const processing = useAppSelector((s) => s.processing);
  const { status, error, entryErrors, specs, activeKey } = processing;
  const patternsLoading = visible && (status === "idle" || status === "loading");
  const field = useAppSelector(s => s.scan.roi);
  const defaults = useAppSelector(s => s.status.defaults);
  const simulation = defaults?.is_production === false;
  const selectedSpotCount = useMemo(() => {
    if (!processing.lensLookup) return null;
    try {
      const active = activeKey && processing.instances[activeKey]?.enabled ? activeKey
        : specs.find(spec => processing.instances[spec.key]?.enabled && processing.instances[spec.key]?.roi)?.key;
      const selected = {...processing, instances: Object.fromEntries(Object.entries(processing.instances).map(([key,instance]) => [key,{...instance,enabled:instance.enabled && key===active}]))};
      return maxLatticeSpotsPerRequest(prepareExposureSequence(selected, field, simulation));
    }
    catch { return null; }
  }, [processing, field, simulation, activeKey, specs]);
  const countValidationFailed = selectedSpotCount !== null && selectedSpotCount > MAX_LATTICE_SPOTS_PER_REQUEST;
  const exposurePhase = useAppSelector(s => s.exposure.phase);
  const exposureActive = ["preparing", "running", "stopping"].includes(exposurePhase);
  const tableTab = usePatternTableTab();
  const exposureMode = useAppSelector(s => s.exposure.mode);
  const preferredResolution = useAppSelector(s => s.exposure.millingRegistrationResolution);
  const advancedMilling = tableTab === "custom" && exposureMode === "milling";
  const registrationResolutions = millingRegistrationOptions(defaults);
  const registrationResolution = millingRegistrationSelection(registrationResolutions, preferredResolution);
  const [invalidDriftLimit, setInvalidDriftLimit] = useState(false);
  const driftLimitInvalid = advancedMilling && invalidDriftLimit;

  useEffect(() => {
    if (!advancedMilling) setInvalidDriftLimit(false);
  }, [advancedMilling]);

  useEffect(() => {
    if (visible && status === "idle") void dispatch(fetchProcessingPatterns());
  }, [visible, status, dispatch]);

  const messages: string[] = [];
  if (status === "error") messages.push(t("processing.configError").replace("{error}", error ?? ""));
  else if (status === "ready" && specs.length === 0) messages.push(t("processing.noPatterns"));
  if (entryErrors.length) messages.push(t("processing.entryErrors").replace("{errors}", entryErrors.join("; ")));

  return (
    <div hidden={!visible}>
      <div className="card patterns-card" aria-busy={exposureActive || patternsLoading}>
        <div className="card__header patterns-card__header">
          <span className="patterns-card__heading">
            <span className="card__title">{t("processing.actions")}</span>
            {exposureActive && !patternsLoading && <LoadingSpinner inline size={18} className="patterns-card__spinner"
              ariaLabel={t("processing.exposure.status.current")} />}
          </span>
        </div>
        <ExposureControls advancedMilling={advancedMilling}
          registrationUnavailable={advancedMilling && registrationResolution === undefined}
          driftLimitInvalid={driftLimitInvalid}
          disabled={patternsLoading || exposureDisabled || countValidationFailed} />
        {patternsLoading && <LoadingSpinner label={t("processing.loading")} />}
        <PatternTableTabs />
        {tableTab === "custom" && <PatternTableCustom imageAvailable={imageAvailable}
          onResetPatternCards={() => dispatch(selectPattern(null))}
          hasCanvasRoi={Boolean(activeKey && processing.instances[activeKey]?.roi)}
          registrationPanel={advancedMilling && <MillingRegistrationPanel resolutions={registrationResolutions}
            resolution={registrationResolution} driftLimitInvalid={driftLimitInvalid}
            onDriftLimitInvalidChange={setInvalidDriftLimit} />}
          defaultWedges={<DefaultPatternWedges specs={specs} instances={processing.instances} activeKey={activeKey}
            disabled={patternsLoading || disabled} imageAvailable={imageAvailable}
            onSelect={key => dispatch(selectPattern(key))} />} />}
        {tableTab === "default" && <DefaultPatternWedges specs={specs} instances={processing.instances} activeKey={activeKey}
          disabled={patternsLoading || disabled} imageAvailable={imageAvailable}
          onSelect={key => dispatch(selectPattern(key))} />}
        {specs.find(s => s.key === activeKey)?.model === "LineModel" && <p className="patterns-card__status">{t("processing.hint.line")}</p>}
        {specs.find(s => s.key === activeKey)?.model === "PolygonModel" && <p className="patterns-card__status">{t("processing.hint.vertices")}</p>}
        {messages.length > 0 && (
          <p className={`patterns-card__status${status === "error" ? " patterns-card__status--error" : ""}`}>{messages.join("\n")}</p>
        )}
      </div>
    </div>
  );
}

export function ProcessingPatternCards({ disabled, enableDisabled = disabled }: { disabled: boolean; enableDisabled?: boolean }) {
  const dispatch = useAppDispatch();
  const processing = useAppSelector((s) => s.processing);
  const { specs, instances, activeKey } = processing;
  const field = useAppSelector(s => s.scan.roi);
  const simulation = useAppSelector(s => s.status.defaults?.is_production === false);
  const exposure = useAppSelector(s => s.exposure);
  const viewLocked = exposure.viewPhase === "queued" || exposure.viewPhase === "scanning" || exposure.phase === "paused";
  const { t, fmt, tr } = useTr();
  const [limitMessage, setLimitMessage] = useState("");
  const selectedSpotCount = useMemo(() => {
    if (!processing.lensLookup) return null;
    try {
      const active = activeKey && processing.instances[activeKey]?.enabled ? activeKey
        : specs.find(spec => processing.instances[spec.key]?.enabled && processing.instances[spec.key]?.roi)?.key;
      const selected = {...processing, instances: Object.fromEntries(Object.entries(processing.instances).map(([key,instance]) => [key,{...instance,enabled:instance.enabled && key===active}]))};
      return maxLatticeSpotsPerRequest(prepareExposureSequence(selected, field, simulation));
    }
    catch { return null; }
  }, [processing, field, simulation, activeKey, specs]);
  const totalLimitMessage = selectedSpotCount !== null && selectedSpotCount > MAX_LATTICE_SPOTS_PER_REQUEST
    ? t("processing.exposure.totalLimit", { count: fmt(selectedSpotCount), limit: fmt(MAX_LATTICE_SPOTS_PER_REQUEST) })
    : "";
  const setEnabled = (key: string, enabled: boolean) => {
    if (enabled && processing.lensLookup) {
      const instance = instances[key];
      if (instance) {
        const candidate = { ...processing, instances: { ...instances, [key]: { ...instance, enabled: true } } };
        try {
          const total = maxLatticeSpotsPerRequest(prepareExposureSequence(candidate, field, simulation));
          if (total > MAX_LATTICE_SPOTS_PER_REQUEST) {
            setLimitMessage(t("processing.exposure.selectionLimit", { count: fmt(total), limit: fmt(MAX_LATTICE_SPOTS_PER_REQUEST) }));
            return;
          }
        } catch {
          // Keep enablement available while a recipe is incomplete; Start performs the same guard.
        }
      }
    }
    setLimitMessage("");
    dispatch(setPatternEnabled({ key, enabled }));
  };
  // Only presentation order changes. Catalogue order still determines acquisition/execution order.
  const promotedKey = activeKey && instances[activeKey]?.roi ? activeKey : null;
  const enabledSpecs = specs.filter(spec => instances[spec.key]?.enabled && instances[spec.key]?.roi);
  const disabledSpecs = specs.filter(spec => !instances[spec.key]?.enabled || !instances[spec.key]?.roi);
  const promoteWithinGroup = (group: typeof specs) => {
    const index = group.findIndex(spec => spec.key === promotedKey);
    return index > 0 ? [group[index], ...group.slice(0, index), ...group.slice(index + 1)] : group;
  };
  const ordered = [...promoteWithinGroup(enabledSpecs), ...promoteWithinGroup(disabledSpecs)];
  const groups = new Map<string, PatternSpec[]>();
  for (const spec of ordered) {
    const typeKey = instances[spec.key]?.typeKey ?? spec.key;
    const group = groups.get(typeKey) ?? [];
    group.push(spec);
    groups.set(typeKey, group);
  }
  return <>
    {limitMessage && <p className="patterns-card__status patterns-card__status--error" role="alert">{limitMessage}</p>}
    {totalLimitMessage && <p className="patterns-card__status patterns-card__status--error" role="alert">{totalLimitMessage}</p>}
    {[...groups.entries()].map(([typeKey, group]) => <PatternInstanceCards key={typeKey}
      typeKey={typeKey} specs={group} instances={instances} activeKey={activeKey}
      countInvalid={Boolean(totalLimitMessage)} disabled={disabled || viewLocked}
      enableDisabled={enableDisabled || viewLocked} onEnabledChange={setEnabled} />)}
  </>;
}

/** A single card becomes a numbered tab group as soon as its type has multiple ROIs. */
function PatternInstanceCards({typeKey, specs, instances, activeKey, countInvalid, disabled, enableDisabled, onEnabledChange}: {
  typeKey: string; specs: PatternSpec[]; instances: Record<string, PatternInstance>; activeKey: string | null;
  countInvalid: boolean; disabled: boolean; enableDisabled: boolean;
  onEnabledChange: (key: string, enabled: boolean) => void;
}) {
  const dispatch = useAppDispatch();
  const {tr} = useTr();
  const [selectedKey, setSelectedKey] = useState(specs[0].key);
  const sorted = [...specs].sort((a, b) => instances[a.key].index - instances[b.key].index);
  const activeSpec = specs.find(spec => spec.key === activeKey);
  const selected = activeSpec ?? specs.find(spec => spec.key === selectedKey) ?? sorted[0];
  useEffect(() => { if (activeSpec) setSelectedKey(activeSpec.key); }, [activeSpec?.key]);
  const caption = tr(`processing.pattern.${typeKey}`, sorted[0].caption);
  const select = (key: string) => { setSelectedKey(key); dispatch(selectPattern(key)); };
  const card = <PatternCard key={selected.key} spec={selected} instance={instances[selected.key]}
    active={activeKey === selected.key && Boolean(instances[selected.key]?.roi)}
    indexed={specs.length > 1} countInvalid={Boolean(countInvalid && instances[selected.key]?.enabled && instances[selected.key]?.roi)}
    disabled={disabled || !instances[selected.key]?.roi} enableDisabled={enableDisabled || !instances[selected.key]?.roi}
    onEnabledChange={onEnabledChange} />;
  if (specs.length === 1) return card;
  return <section className="pattern-instance-group" aria-label={caption}>
    <div className="pattern-instance-group__heading">{caption}</div>
    <div className="pattern-instance-tabs" role="tablist" aria-label={caption}>
      {sorted.map((spec, i) => <button key={spec.key} type="button" role="tab"
        id={`pattern-instance-tab-${encodeURIComponent(spec.key)}`}
        aria-controls={`pattern-instance-panel-${encodeURIComponent(spec.key)}`}
        aria-selected={selected.key === spec.key} tabIndex={selected.key === spec.key ? 0 : -1}
        disabled={disabled} onClick={() => select(spec.key)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (i + 1) % sorted.length
            : event.key === "ArrowLeft" ? (i + sorted.length - 1) % sorted.length
            : event.key === "Home" ? 0 : event.key === "End" ? sorted.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          select(sorted[next].key);
          (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
        }}>{instances[spec.key].index}</button>)}
    </div>
    <div role="tabpanel" id={`pattern-instance-panel-${encodeURIComponent(selected.key)}`}
      aria-labelledby={`pattern-instance-tab-${encodeURIComponent(selected.key)}`}>
      {card}
    </div>
  </section>;
}

function PatternCard({ spec, instance, active, indexed = false, countInvalid = false, disabled, enableDisabled, onEnabledChange }: {
  spec: PatternSpec; instance: PatternInstance | undefined; active: boolean; indexed?: boolean; countInvalid?: boolean; disabled: boolean; enableDisabled: boolean;
  onEnabledChange: (key: string, enabled: boolean) => void;
}) {
  const dispatch = useAppDispatch();
  const { t, tr } = useTr();
  const unit = unitLabel(useAppSelector((s) => s.scan.roi.scale_unit));
  const workflows = useAppSelector(s => s.processing.workflows);
  const materials = useAppSelector(s => s.processing.materials);
  const stairRecipeAssigned = useAppSelector(s => Boolean(s.processing.stairReceipes.SMProcess));
  const stairRecipes = useAppSelector(s => s.processing.stairReceipes.SMProcess);
  const scanField = useAppSelector(s => s.scan.roi);
  const lensLookup = useAppSelector(s => s.processing.lensLookup);
  const simulation = useAppSelector(s => s.status.defaults?.is_production === false);
  const exposureState = useAppSelector(s => s.exposure);
  const [parametersOpen, setParametersOpen] = useState(false);
  const viewBusy = exposureState.viewPhase === "queued" || exposureState.viewPhase === "scanning";
  const exposing = exposureState.activeStepIds.some(id => id.startsWith(`${spec.key}:`));
  const activeExposureNode = exposureState.progress.find(node => node.status === "current")
    ?? (viewBusy ? [...exposureState.progress]
      .filter(node => node.status === "completed" && node.finishedAt !== undefined)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0] : undefined);
  const isActiveExposurePattern = activeExposureNode?.id.startsWith(`${spec.key}:`) ?? false;
  const typeCaption = tr(`processing.pattern.${instance?.typeKey ?? spec.key}`, spec.caption);
  const caption = indexed ? `${typeCaption} - ${instance?.index}` : typeCaption;
  const label = active ? t("processing.collapse") : t("processing.expand");
  const activeMaterialName = instance?.material || materials[0]?.name;
  const selectedMaterial = activeMaterialName ? materials.find(material => material.name === activeMaterialName) : undefined;
  const materialRemovalRates = useMemo(() => Object.fromEntries(materials
    .filter(material => material.removalRateUM3PerNC !== undefined)
    .map(material => [material.name, material.removalRateUM3PerNC!])), [materials]);
  const stairPresets = (stairRecipes?.nodes.find(node => node.name === instance?.stairRecipeNode) ?? stairRecipes?.nodes[0])?.steps;
  const planned = useMemo((): { passes: number | null; error: string } => {
    if (!instance?.roi || !lensLookup) return { passes: null, error: "" };
    try {
      return { error: "", passes: plannedPatternExposureMetrics(spec, instance.roi, instance.parameters, lensLookup, scanField, {
        simulation, stairPresets, stairOverrides: instance.stairSteps,
        defaultMaterial: spec.model === "StairCutModel" ? materials[0]?.name : activeMaterialName,
        materialRemovalRates,
      }).passes };
    } catch (error) { return { passes: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [spec, instance, lensLookup, scanField, simulation, stairPresets, materials, materialRemovalRates]);
  const plannedPasses = planned.passes;
  if (!instance) return null;
  const materialBrightness = selectedMaterial?.brightness;
  const parametersId = `pattern-parameters-${encodeURIComponent(spec.key)}`;
  const targetGrayLevel = instance.AvgGray !== null && materialBrightness !== undefined
    ? materialTargetGrayLevel(instance.AvgGray, materialBrightness)
    : null;

  return (
    <div id={`processing-pattern-${encodeURIComponent(spec.key)}`} tabIndex={-1} role="region" aria-label={caption} aria-disabled={disabled}
      className={`card pattern-card${active ? " pattern-card--active" : ""}${exposing ? " pattern-card--exposing" : ""}${countInvalid ? " pattern-card--count-invalid" : ""}`} data-pattern={spec.key}
      aria-invalid={countInvalid || undefined}>
      <div className="card__header">
        <span className="card__title">{indexed ? <>{typeCaption} - <strong className="pattern-card__instance-index">{instance.index}</strong></> : caption}</span>
        <span className="pattern-card__header-actions">
          {viewBusy && isActiveExposurePattern && <span className="pattern-card__pause-indicator pattern-card__pause-indicator--blink" title="Exposure paused for View scan" aria-label="Exposure paused">
            <Icon name="pause" />
          </span>}
          <label className="checkbox vacuum-switch app-switch pattern-card__enable">
            <input type="checkbox" checked={Boolean(instance.roi) && instance.enabled !== false} disabled={enableDisabled}
              aria-label={`${caption}: ${t("processing.enable")}`}
              onChange={(event) => {
                onEnabledChange(spec.key, event.target.checked);
              }} />
            <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
            <span>{t("processing.enable")}</span>
          </label>
        </span>
        <button
          type="button"
          className="card__collapse-btn"
          aria-expanded={active}
          aria-label={`${caption}: ${label}`}
          data-tooltip={`${caption}: ${label}`}
          data-styled-tooltip="true"
          disabled={disabled}
          onClick={() => dispatch(selectPattern(active ? null : spec.key))}
        >
          <Icon name="chevronDown" />
        </button>
      </div>
      <div className="pattern-card__body" hidden={!active}>
        {workflows.some(workflow => workflow.name !== "default") && <details className="pattern-image-guided" open={instance.workflowEnabled && instance.workflow !== "default"}>
          <summary>{tr("processing.imageGuided.title", "Image-guided removal (Scan only)")}</summary>
          <p className="pattern-image-guided__note">{tr("processing.imageGuided.note", "These gray-level workflow settings act on the Scan image path. Exposure Start uses the step recipe and ignores them.")}</p>
        <div className="pattern-workflow-controls">
          <label className="field">Workflow
            <select className="select" aria-label={`${caption}: Workflow`} value={instance.workflow} disabled={disabled}
              onChange={e => dispatch(setPatternWorkflow({ key: spec.key, workflow: e.target.value }))}>
              {workflows.map(w => <option key={w.name} value={w.name}>{w.caption}</option>)}
            </select>
          </label>
          <label className="field pattern-workflow-toggle">
            <span>Use workflow</span>
            <span className="checkbox vacuum-switch app-switch">
              <input type="checkbox" aria-label={`${caption}: Use selected workflow`} checked={instance.workflowEnabled} disabled={disabled}
                onChange={e => dispatch(setPatternWorkflow({ key: spec.key, enabled: e.target.checked }))} />
              <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
            </span>
          </label>
        </div>
        {instance.workflow === MATERIAL_WORKFLOW && (
          <div className="pattern-target-gray-row">
            <span>{t("roi.targetGray")}</span>
            <output className="pattern-target-gray-value" aria-label={`${caption}: ${t("roi.targetGray")}`}>
              {targetGrayLevel === null ? "—" : targetGrayLevel.toFixed(2)}
            </output>
            <small>AvgGray × {materials.find(material => material.name === instance.material)?.caption ?? instance.material}</small>
          </div>
        )}
        </details>}
        <ProcessingWorkflowPanel patternKey={spec.key} />
        <section className="pattern-parameters-card">
          <div className="pattern-parameters-card__header" onClick={event => {
            const target = event.target as HTMLElement;
            if (target.closest("button, input, select, label, fieldset")) return;
            setParametersOpen(open => !open);
          }}>
            <span className="pattern-parameters-card__title">{t("processing.parameters")}</span>
            <div className="pattern-parameters-card__controls">
            {[...spec.parameters.filter(p => p.name === "direction"), ...spec.parameters.filter(p => p.name === "loops" || p.name === "passes")].map(p => (
              <div className={p.name === "direction" ? "pattern-parameters-card__choice" : `pattern-parameters-card__step${p.name === "loops" ? " pattern-parameters-card__step--loops" : ""}`} key={p.name}>
                {p.name === "passes" ? <div className="field pattern-parameters-card__pass-readout">
                  <label>{tr(`processing.param.common.${p.name}`, tr(`processing.param.${spec.key}.${p.name}`, p.label))}</label>
                  <output aria-label={`${caption}: ${p.label}`} title={planned.error || "Planned passes from the current pattern and calibrated depth settings."}>
                    {plannedPasses === null ? "—" : plannedPasses.toLocaleString()}
                  </output>
                </div> : <ParameterField spec={p} label={tr(`processing.param.common.${p.name}`, tr(`processing.param.${spec.key}.${p.name}`, p.label))}
                  value={instance.parameters[p.name]} unit={p.unit === "world" ? unit : p.unit === "us" ? "µs" : p.unit === "um" ? "µm" : p.unit}
                  pattern={spec} roi={instance.roi} disabled={disabled}
                  onChange={value => dispatch(setPatternParameter({ key: spec.key, name: p.name, value }))} />}
              </div>
            ))}
            <fieldset className="pattern-axis-field pattern-card__axis pattern-parameters-card__direction" disabled={disabled}>
              <legend>{t("processing.exposureAxis")}</legend>
              {(["x", "y"] as const).map((axis) => {
                const path = axis === "x" ? "horizontal_triangle" : "vertical_serpentine";
                const label = t(axis === "x" ? "processing.exposureAxis.x" : "processing.exposureAxis.y");
                return <label className="pattern-axis-option" key={axis}>
                  <input type="radio" name={`pattern-axis-${spec.key}`} value={axis}
                    checked={String(instance.parameters.axis ?? "x") === axis}
                    onChange={() => dispatch(setPatternParameter({ key: spec.key, name: "axis", value: axis }))} />
                  <VectorScanPathPreview path={path} label={label} />
                  <span>{label}</span>
                </label>;
              })}
            </fieldset>
            </div>
            <button type="button" className="pattern-parameters-card__toggle" aria-expanded={parametersOpen}
              aria-label={t(parametersOpen ? "processing.collapse" : "processing.expand")}
              aria-controls={parametersId} onClick={() => setParametersOpen(open => !open)}>
              <span className="pattern-parameters-card__chevron" aria-hidden="true"><Icon name="chevronDown" /></span>
            </button>
          </div>
          <div className="pattern-parameters-card__body" id={parametersId} hidden={!parametersOpen}>
        <div className="pattern-card__parameters">
        {spec.parameters.filter((p) => p.name !== "axis" && p.name !== "steps" && p.name !== "loops" && p.name !== "passes" && p.name !== "direction"
          && !(spec.model !== "StairCutModel" && p.name.toLowerCase() === "dose")
          && !(spec.model === "StairCutModel" && stairRecipeAssigned && (p.name === "depth" || p.name === "overlap"))).map((p) => (
          <ParameterField
            key={p.name}
            spec={p}
            label={tr(`processing.param.common.${p.name}`, tr(`processing.param.${spec.key}.${p.name}`, p.label))}
            value={instance.parameters[p.name]}
            unit={p.unit === "world" ? unit : p.unit === "us" ? "µs" : p.unit === "um" ? "µm" : p.unit}
            pattern={spec}
            roi={instance.roi}
            disabled={disabled}
            onChange={(value) => dispatch(setPatternParameter({ key: spec.key, name: p.name, value }))}
          />
        ))}
        {spec.model !== "StairCutModel" && (
          <>
            <label className="field">
              {tr("processing.material", "Material")}
              <select className="select" aria-label={`${caption}: ${tr("processing.material", "Material")}`}
                value={instance.material} disabled={disabled || materials.length === 0}
                onChange={e => dispatch(setPatternMaterial({ key: spec.key, material: e.target.value }))}>
                {materials.length ? materials.map(material =>
                  <option key={material.name} value={material.name}>{material.caption ?? material.name}</option>)
                  : <option value="">{tr("processing.material.empty", "No materials configured")}</option>}
              </select>
            </label>
            <div className="field pattern-material-sr" title={selectedMaterial?.removalRateSource ?? "No Sr configured"}>
              <span>Sr (µm³/nC)</span>
              <output className="pattern-target-gray-value" aria-label={`${caption}: Sr`}>
                {selectedMaterial?.removalRateUM3PerNC?.toLocaleString(undefined, { maximumSignificantDigits: 4 }) ?? "—"}
              </output>
            </div>
          </>
        )}
        </div>
          </div>
        </section>
        {spec.model === "StairCutModel" && <StairRecipeCard patternKey={spec.key} caption={caption} instance={instance} disabled={disabled} />}
        <PatternRuntimeReadouts spec={spec} roi={instance.roi} parameters={instance.parameters}
          stairSteps={instance.stairSteps}
          defaultMaterial={spec.model === "StairCutModel" ? materials[0]?.name : activeMaterialName} simulation={simulation} />
        <p className="pattern-card__readout">{roiReadout(spec, instance.roi, unit)}{`\nAvgGray: ${instance.AvgGray == null ? "—" : instance.AvgGray.toFixed(2)}`}</p>
      </div>
    </div>
  );

  function roiReadout(s: PatternSpec, roi: PatternRoi | null, u: string): string {
    if (!roi) return t("processing.roi.none");
    const n = (v: number) => String(Math.round(v * 100) / 100);
    let text: string;
    if (s.model === "LineModel") {
      const [a, b] = lineEndpoints(roi as PolygonRoi);
      text = `(${n(a[0])}, ${n(a[1])}) → (${n(b[0])}, ${n(b[1])}) ${u}`;
    } else if (s.roi === "rect") {
      const r = roi as RectRoi;
      text = t("processing.roi.rect").replace("{x0}", n(r.x_start)).replace("{x1}", n(r.x_end)).replace("{y0}", n(r.y_start)).replace("{y1}", n(r.y_end)).replace("{unit}", u);
    } else if (s.roi === "circle") {
      const r = roi as CircleRoi;
      text = t("processing.roi.circle").replace("{cx}", n(r.cx)).replace("{cy}", n(r.cy)).replace("{radius}", n(r.radius)).replace("{unit}", u);
    } else if (s.roi === "ring") {
      const r = roi as RingRoi;
      text = t("processing.roi.ring").replace("{cx}", n(r.cx)).replace("{cy}", n(r.cy)).replace("{ri}", n(r.r_inner)).replace("{ro}", n(r.r_outer)).replace("{unit}", u);
    } else {
      text = t("processing.roi.polygon").replace("{n}", String((roi as PolygonRoi).points.length));
    }
    const area = MODEL_REGISTRY[s.model].area(roi);
    return `${text}\n${t("processing.area").replace("{area}", n(area)).replace("{unit}", u)}`;
  }
}

function ParameterField({
  spec, label, value, unit, pattern, roi, disabled, onChange,
}: { spec: ParameterSpec; label: string; value: ParameterValue; unit: string; pattern: PatternSpec; roi: PatternRoi | null;
  disabled: boolean; onChange: (value: ParameterValue | string) => void }) {
  const { tr } = useTr();
  const [text, setText] = useState(String(value));
  // follow external changes (reload, another view of the same instance) without fighting half-typed input
  useEffect(() => {
    if (spec.type === "int" || spec.type === "float") setText((cur) => (Number(cur) === value ? cur : String(value)));
  }, [value, spec.type]);

  const withUnit = unit ? `${label} (${unit})` : label;
  const error = patternParameterError(spec, text, pattern, roi);
  if (spec.type === "bool") {
    return (
      <label className="checkbox">
        <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {withUnit}
      </label>
    );
  }
  if (spec.type === "choice") {
    return (
      <div className="field">
        <label>{withUnit}</label>
        <select className="select" value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {spec.choices.map((c) => (
            <option key={c} value={c}>{tr(`processing.choice.${c}`, c)}</option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <NumberStepperField
      label={<>{label}{unit && <span className="pattern-card__unit"> ({unit})</span>}</>}
      value={text}
      disabled={disabled}
      step={spec.step}
      fractionDigits={spec.type === "float" ? 2 : 0}
      min={spec.min ?? undefined}
      max={spec.max ?? undefined}
      inputMode={spec.type === "int" ? "numeric" : "decimal"}
      invalid={error !== null}
      warning={error}
      title={spec.name === "beamCurrent" ? "Used to look up the exposure spot size; this field does not set the instrument beam current."
        : spec.name === "depth" ? "Requested depth stored in the recipe; current workflows do not control physical milling depth."
        : spec.name === "overlap" ? "Applied to exposure-lattice spacing; image Scan keeps its own Controls settings."
        : spec.name === "dwell" ? "Used by pattern exposure Run. Image Scan uses the Controls dwell." : undefined}
      ariaLabel={withUnit}
      onValueChange={(v) => {
        setText(v);
        if (!patternParameterError(spec, v, pattern, roi)) onChange(v);
      }}
    />
  );
}
