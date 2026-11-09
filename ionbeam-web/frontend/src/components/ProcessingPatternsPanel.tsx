/**
 * Content of the Processing tab: the (not collapsible) "Patterns" card with one icon per pattern, followed by one
 * collapsible card per pattern (ProcessingPatternCards). Both use the catalogue the backend serves from processingPatterns.json
 * (entries marked skip never arrive), and every card is bound to its pattern instance in the processing slice.
 *
 * Picking an icon arms drawing on the image canvas (PatternOverlay); picking it again disarms.
 * Cards start collapsed and expand when their ROI is drawn or edited.
 */
import { useEffect, useState } from "react";

import { useTranslation, type TranslationKey } from "../i18n";
import { materialTargetGrayLevel } from "../lib/processingWorkflows";
import {
  MODEL_REGISTRY,
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
import { PatternIcon } from "./PatternIcon";
import { ProcessingWorkflowPanel } from "./ProcessingWorkflowPanel";
import { unitLabel } from "./ROIEditor";

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

export function ProcessingPatternsPanel({ disabled }: { disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t, tr } = useTr();
  const { status, error, entryErrors, specs, activeKey } = useAppSelector((s) => s.processing);

  useEffect(() => {
    if (status === "idle") void dispatch(fetchProcessingPatterns());
  }, [status, dispatch]);

  const messages: string[] = [];
  if (status === "error") messages.push(t("processing.configError").replace("{error}", error ?? ""));
  else if (status === "ready" && specs.length === 0) messages.push(t("processing.noPatterns"));
  if (entryErrors.length) messages.push(t("processing.entryErrors").replace("{errors}", entryErrors.join("; ")));

  return (
    <>
      <div className="card patterns-card">
        <div className="card__header">
          <span className="card__title">{t("processing.patterns")}</span>
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
    </>
  );
}

export function ProcessingPatternCards({ disabled }: { disabled: boolean }) {
  const { specs, instances, activeKey } = useAppSelector((s) => s.processing);
  return <>{specs.map((spec) => (
    <PatternCard key={spec.key} spec={spec} instance={instances[spec.key]} active={activeKey === spec.key}
      disabled={disabled || !instances[spec.key]?.roi} />
  ))}</>;
}

function PatternCard({ spec, instance, active, disabled }: { spec: PatternSpec; instance: PatternInstance | undefined; active: boolean; disabled: boolean }) {
  const dispatch = useAppDispatch();
  const { t, tr } = useTr();
  const unit = unitLabel(useAppSelector((s) => s.scan.roi.scale_unit));
  const workflows = useAppSelector(s => s.processing.workflows);
  const materials = useAppSelector(s => s.processing.materials);
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    setCollapsed(!active || !instance?.roi);
  }, [active, instance?.roi]);
  const caption = tr(`processing.pattern.${spec.key}`, spec.caption);
  const label = collapsed ? t("processing.expand") : t("processing.collapse");
  if (!instance) return null;
  const materialBrightness = materials.find(material => material.name === instance.material)?.brightness;
  const targetGrayLevel = instance.AvgGray !== null && materialBrightness !== undefined
    ? materialTargetGrayLevel(instance.AvgGray, materialBrightness)
    : null;

  return (
    <div id={`processing-pattern-${encodeURIComponent(spec.key)}`} tabIndex={-1} role="region" aria-label={caption} aria-disabled={disabled}
      className={`card pattern-card${active ? " pattern-card--active" : ""}`} data-pattern={spec.key}>
      <div className="card__header">
        <span className="card__title">{caption}</span>
        <label className="checkbox vacuum-switch app-switch pattern-card__enable">
          <input type="checkbox" checked={Boolean(instance.roi) && instance.enabled !== false} disabled={disabled || !instance.roi}
            aria-label={`${caption}: ${t("processing.enable")}`}
            onChange={(event) => dispatch(setPatternEnabled({ key: spec.key, enabled: event.target.checked }))} />
          <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
          <span>{t("processing.enable")}</span>
        </label>
        <button
          type="button"
          className="card__collapse-btn"
          aria-expanded={!collapsed}
          aria-label={`${caption}: ${label}`}
          data-tooltip={`${caption}: ${label}`}
          data-styled-tooltip="true"
          disabled={false}
          onClick={() => {
            setCollapsed((value) => !value);
            if (collapsed) dispatch(selectPattern(spec.key));
          }}
        >
          <Icon name="chevronDown" />
        </button>
      </div>
      <div className="pattern-card__body" hidden={collapsed}>
        <div className="pattern-workflow-controls">
          <label className="field">Workflow
            <select className="select" aria-label={`${caption}: Workflow`} value={instance.workflow} disabled={disabled}
              onChange={e => dispatch(setPatternWorkflow({ key: spec.key, workflow: e.target.value }))}>
              {workflows.map(w => <option key={w.name} value={w.name}>{w.caption}</option>)}
            </select>
          </label>
          {instance.workflow === MATERIAL_WORKFLOW && (
            <label className="field">Material
              <select className="select" aria-label={`${caption}: Material`} value={instance.material} disabled={disabled}
                onChange={e => dispatch(setPatternMaterial({ key: spec.key, material: e.target.value }))}>
                {materials.map(m => <option key={m.name} value={m.name}>{m.caption ?? m.name}</option>)}
              </select>
            </label>
          )}
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
        <ProcessingWorkflowPanel patternKey={spec.key} />
        <div className="pattern-card__parameters">
        {spec.parameters.map((p) => (
          <ParameterField
            key={p.name}
            spec={p}
            label={tr(`processing.param.${spec.key}.${p.name}`, p.label)}
            value={instance.parameters[p.name]}
            disabled={disabled}
            onChange={(value) => dispatch(setPatternParameter({ key: spec.key, name: p.name, value }))}
          />
        ))}
        </div>
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
  spec, label, value, disabled, onChange,
}: { spec: ParameterSpec; label: string; value: ParameterValue; disabled: boolean; onChange: (value: ParameterValue | string) => void }) {
  const { tr } = useTr();
  const [text, setText] = useState(String(value));
  // follow external changes (reload, another view of the same instance) without fighting half-typed input
  useEffect(() => {
    if (spec.type === "int" || spec.type === "float") setText((cur) => (Number(cur) === value ? cur : String(value)));
  }, [value, spec.type]);

  const withUnit = spec.unit ? `${label} (${spec.unit})` : label;
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
      label={withUnit}
      value={text}
      disabled={disabled}
      step={spec.step}
      min={spec.min ?? undefined}
      max={spec.max ?? undefined}
      inputMode={spec.type === "int" ? "numeric" : "decimal"}
      invalid={text.trim() === "" || !Number.isFinite(Number(text))}
      onValueChange={(v) => {
        setText(v);
        onChange(v);
      }}
    />
  );
}
