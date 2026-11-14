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
import { StairStepsTable } from "./StairStepsTable";
import { PatternIcon } from "./PatternIcon";
import { PatternRuntimeReadouts } from "./PatternRuntimeReadouts";
import { VectorScanPathPreview } from "./VectorScanPathPreview";
import { ProcessingWorkflowPanel } from "./ProcessingWorkflowPanel";
import { unitLabel } from "./ROIEditor";
import { prepareExposureSequence, totalExposureSpots, MAX_EXPOSURE_SPOTS } from "../lib/exposureSequence";

import { ExposureControls } from "./ExposureControls";
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

export function ProcessingPatternsPanel({ disabled, exposureDisabled = disabled, visible = true }: {
  disabled: boolean;
  exposureDisabled?: boolean;
  visible?: boolean;
}) {
  const dispatch = useAppDispatch();
  const { t, tr } = useTr();
  const processing = useAppSelector((s) => s.processing);
  const { status, error, entryErrors, specs, activeKey } = processing;
  const field = useAppSelector(s => s.scan.roi);
  const simulation = useAppSelector(s => s.status.defaults?.is_production === false);
  const selectedSpotCount = useMemo(() => {
    if (!processing.lensLookup) return null;
    try { return totalExposureSpots(prepareExposureSequence(processing, field, simulation)); }
    catch { return null; }
  }, [processing, field, simulation]);
  const countValidationFailed = selectedSpotCount !== null && selectedSpotCount > MAX_EXPOSURE_SPOTS;
  const exposurePhase = useAppSelector(s => s.exposure.phase);
  const exposureActive = ["preparing", "running", "stopping"].includes(exposurePhase);

  useEffect(() => {
    if (visible && status === "idle") void dispatch(fetchProcessingPatterns());
  }, [visible, status, dispatch]);

  const messages: string[] = [];
  if (status === "error") messages.push(t("processing.configError").replace("{error}", error ?? ""));
  else if (status === "ready" && specs.length === 0) messages.push(t("processing.noPatterns"));
  if (entryErrors.length) messages.push(t("processing.entryErrors").replace("{errors}", entryErrors.join("; ")));

  return (
    <div hidden={!visible}>
      <div className="card patterns-card" aria-busy={exposureActive}>
        <div className="card__header patterns-card__header">
          <span className="patterns-card__heading">
            <span className="card__title">{t("processing.patterns")}</span>
            {exposureActive && <LoadingSpinner inline size={18} className="patterns-card__spinner"
              ariaLabel={t("processing.exposure.status.current")} />}
          </span>
          <ExposureControls disabled={exposureDisabled || countValidationFailed} />
        </div>
        <div className="pattern-strip" role="toolbar" aria-label={t("processing.patterns")}>
          {specs.map((spec) => {
            const caption = tr(`processing.pattern.${spec.key}`, spec.caption);
            return (
              <button
                key={spec.key}
                type="button"
                className="pattern-strip__btn"
                aria-pressed={activeKey === spec.key}
                aria-controls={`processing-pattern-${encodeURIComponent(spec.key)}`}
                data-tooltip={caption}
                data-styled-tooltip="true"
                aria-label={caption}
                disabled={disabled}
                onClick={() => dispatch(selectPattern(activeKey === spec.key ? null : spec.key))}
              >
                <PatternIcon name={spec.icon} />
              </button>
            );
          })}
        </div>
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
  const { tr } = useTr();
  const [limitMessage, setLimitMessage] = useState("");
  const selectedSpotCount = useMemo(() => {
    if (!processing.lensLookup) return null;
    try { return totalExposureSpots(prepareExposureSequence(processing, field, simulation)); }
    catch { return null; }
  }, [processing, field, simulation]);
  const totalLimitMessage = selectedSpotCount !== null && selectedSpotCount > MAX_EXPOSURE_SPOTS
    ? tr("processing.exposure.totalLimit", `Count validation failed: enabled patterns require ${selectedSpotCount.toLocaleString()} spots including passes; the maximum is ${MAX_EXPOSURE_SPOTS.toLocaleString()}. Select a smaller ROI area before starting.`)
    : "";
  const setEnabled = (key: string, enabled: boolean) => {
    if (enabled && processing.lensLookup) {
      const instance = instances[key];
      if (instance) {
        const candidate = { ...processing, instances: { ...instances, [key]: { ...instance, enabled: true } } };
        try {
          const total = totalExposureSpots(prepareExposureSequence(candidate, field, simulation));
          if (total > MAX_EXPOSURE_SPOTS) {
            setLimitMessage(tr("processing.exposure.selectionLimit", `Cannot enable this pattern: the selected patterns would require ${total.toLocaleString()} spots including passes; the limit is ${MAX_EXPOSURE_SPOTS.toLocaleString()}. Reduce the ROI, increase pitch, or reduce passes.`));
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
  return <>
    {limitMessage && <p className="patterns-card__status patterns-card__status--error" role="alert">{limitMessage}</p>}
    {totalLimitMessage && <p className="patterns-card__status patterns-card__status--error" role="alert">{totalLimitMessage}</p>}
    {ordered.map((spec) => (
      <PatternCard key={spec.key} spec={spec} instance={instances[spec.key]} active={activeKey === spec.key}
        countInvalid={Boolean(totalLimitMessage && instances[spec.key]?.enabled && instances[spec.key]?.roi)}
        disabled={disabled || viewLocked || !instances[spec.key]?.roi} enableDisabled={enableDisabled || viewLocked || !instances[spec.key]?.roi}
        onEnabledChange={setEnabled}
      />
    ))}
  </>;
}

function PatternCard({ spec, instance, active, countInvalid = false, disabled, enableDisabled, onEnabledChange }: {
  spec: PatternSpec; instance: PatternInstance | undefined; active: boolean; countInvalid?: boolean; disabled: boolean; enableDisabled: boolean;
  onEnabledChange: (key: string, enabled: boolean) => void;
}) {
  const dispatch = useAppDispatch();
  const { t, tr } = useTr();
  const unit = unitLabel(useAppSelector((s) => s.scan.roi.scale_unit));
  const workflows = useAppSelector(s => s.processing.workflows);
  const materials = useAppSelector(s => s.processing.materials);
  const simulation = useAppSelector(s => s.status.defaults?.is_production === false);
  const exposureState = useAppSelector(s => s.exposure);
  const exposing = exposureState.activeStepIds.some(id => id.startsWith(`${spec.key}:`));
  const activeExposureNode = exposureState.progress.find(node => node.status === "current");
  const isActiveExposurePattern = activeExposureNode?.id.startsWith(`${spec.key}:`) ?? false;
  const viewBusy = exposureState.viewPhase === "queued" || exposureState.viewPhase === "scanning";
  const caption = tr(`processing.pattern.${spec.key}`, spec.caption);
  const label = active ? t("processing.collapse") : t("processing.expand");
  if (!instance) return null;
  const selectedMaterial = materials.find(material => material.name === instance.material);
  const materialBrightness = selectedMaterial?.brightness;
  const targetGrayLevel = instance.AvgGray !== null && materialBrightness !== undefined
    ? materialTargetGrayLevel(instance.AvgGray, materialBrightness)
    : null;

  return (
    <div id={`processing-pattern-${encodeURIComponent(spec.key)}`} tabIndex={-1} role="region" aria-label={caption} aria-disabled={disabled}
      className={`card pattern-card${active ? " pattern-card--active" : ""}${exposing ? " pattern-card--exposing" : ""}${countInvalid ? " pattern-card--count-invalid" : ""}`} data-pattern={spec.key}
      aria-invalid={countInvalid || undefined}>
      <div className="card__header">
        <span className="card__title">{caption}</span>
        <span className="pattern-card__header-actions">
          {viewBusy && isActiveExposurePattern && <span className="pattern-card__pause-indicator" title="Exposure paused for View scan" aria-label="Exposure paused">
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
        <details className="pattern-image-guided" open={instance.workflowEnabled && instance.workflow !== "default"}>
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
        </details>
        <ProcessingWorkflowPanel patternKey={spec.key} />
        <div className="pattern-card__parameters">
        {spec.parameters.filter((p) => p.name !== "axis").map((p) => (
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
        <fieldset className="pattern-axis-field pattern-card__axis" disabled={disabled}>
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
        {spec.model === "StairCutModel" && <StairStepsTable patternKey={spec.key} caption={caption} instance={instance} disabled={disabled} />}
        <PatternRuntimeReadouts spec={spec} roi={instance.roi} parameters={instance.parameters}
          stairSteps={instance.stairSteps} defaultMaterial={materials[0]?.name} simulation={simulation} />
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
