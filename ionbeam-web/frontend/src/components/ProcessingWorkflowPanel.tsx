import { useEffect, useMemo, useRef, useState } from "react";
import { workflowElapsedMs, formatWorkflowElapsed, type WorkflowProgress } from "../lib/processingWorkflows";
import { plannedPatternExposureMetrics } from "../lib/patternExposure";
import { formatPatternTime } from "../lib/processingPatterns";
import { useTranslation } from "../i18n";
import { useAppSelector } from "../store";

/** Orbit's numbered timeline, adapted to scan stream completion events. */
export function ProcessingWorkflowPanel({ patternKey }: { patternKey: string }) {
  const { t } = useTranslation();
  const { workflowProgress, specs, instances, workflows, materials, lensLookup, stairReceipes } = useAppSelector(s => s.processing);
  const {progress: exposureProgress, phase: exposurePhase} = useAppSelector(s => s.exposure);
  const field = useAppSelector(s => s.scan.roi);
  const simulation = useAppSelector(s => s.status.defaults?.is_production === false);
  const adcHalfPeriod = useAppSelector(s => Number(s.status.defaults?.adc?.adcHalfPeriod ?? 3));
  const instance = instances[patternKey];
  const stairPresets = (stairReceipes.SMProcess?.nodes.find(n => n.name === instance?.stairRecipeNode)
    ?? stairReceipes.SMProcess?.nodes[0])?.steps;
  const selectedWorkflow = workflows.find(w => w.name === (instance?.workflowEnabled ? instance.workflow : "default"));
  const exposureNodes = exposureProgress.filter(step => step.id.startsWith(`${patternKey}:`));
  const recordedNodes = exposureNodes.length ? exposureNodes : workflowProgress.filter(step => step.id.startsWith(`${patternKey}:`));
  const nodes: WorkflowProgress[] = recordedNodes.length ? recordedNodes : specs.filter(spec => spec.key === patternKey).flatMap(spec => {
    const inst = instances[spec.key];
    if (!inst) return [];
    const workflow = workflows.find(w => w.name === (inst.workflowEnabled ? inst.workflow : "default"));
    return (workflow?.steps ?? []).map((step, i) => ({ id: `${spec.key}:${i}`, pattern: spec.caption,
      caption: step.caption, action: step.actions[0].caption, status: "upcoming" as const, threshold: null, spot: 0, total: 0 }));
  });
  const [now, setNow] = useState(Date.now);
  const running = exposurePhase !== "paused" && nodes.some(node => node.status === "current" && node.startedAt !== undefined);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);
  const estimateSeconds = useMemo(() => {
    const preparedNodes = exposureProgress.filter(node => node.id.startsWith(`${patternKey}:`) && node.exposure);
    if (preparedNodes.length && exposurePhase !== "idle" && exposurePhase !== "preparing") return preparedNodes.reduce((sum, node) => sum + (node.exposure?.latticeBeamOnS ?? node.exposure?.plan.beamOnS ?? 0), 0);
    const spec = specs.find(item => item.key === patternKey);
    if (!spec || !instance?.roi || !lensLookup) return 0;
    const materialRemovalRates = Object.fromEntries(materials
      .filter(material => material.removalRateUM3PerNC !== undefined)
      .map(material => [material.name, material.removalRateUM3PerNC!]));
    try {
      return plannedPatternExposureMetrics(spec, instance.roi, instance.parameters, lensLookup, field,
        {simulation, adcHalfPeriod, stairPresets, stairOverrides: instance.stairSteps, materialRemovalRates,
          // Same material the run uses: the pattern's own for plain patterns, the first for Stair cut recipes.
          defaultMaterial: spec.model === "StairCutModel" ? materials[0]?.name : instance.material || materials[0]?.name}).beamOnS;
    } catch { return 0; }
  }, [exposureProgress, exposurePhase, patternKey, specs, instance, lensLookup, field, simulation, adcHalfPeriod, materials, stairPresets]);
  const timeLeftMs = useMemo(() => {
    if (exposurePhase === "completed" || exposurePhase === "stopped" || exposurePhase === "error") return 0;
    const planned = exposureProgress.filter(node => node.id.startsWith(`${patternKey}:`) && node.exposure);
    if (!planned.length || exposurePhase === "idle" || exposurePhase === "preparing") return estimateSeconds * 1000;
    return planned.reduce((remaining, node) => {
      if (node.status !== "current" && node.status !== "upcoming") return remaining;
      const exposure = node.exposure!;
      const completedPasses = exposure.completedPasses ?? 0;
      const plannedPassMs = (exposure.latticeBeamOnS ?? exposure.plan.beamOnS) * 1000 / exposure.plan.passes;
      const passMs = completedPasses > 0
        ? (exposure.completedPassExposureMs ?? 0) / completedPasses
        : plannedPassMs;
      const pendingPasses = Math.max(0, exposure.plan.passes - completedPasses);
      const currentPassMs = Math.min(passMs, exposure.currentPassExposureMs ?? 0);
      return remaining + Math.max(0, pendingPasses * passMs - currentPassMs);
    }, 0);
  }, [exposurePhase, exposureProgress, patternKey, estimateSeconds]);
  const completed = nodes.filter(n => n.status === "completed").length;
  const currentNode = nodes.find(node => node.status === "current");
  const passLabel = (node: WorkflowProgress) => {
    const plan = node.exposure?.plan;
    if (!plan || node.status === "upcoming") return null;
    const pass = node.status === "completed" ? plan.passes
      : Math.min(plan.passes, (node.exposure?.completedPasses ?? 0) + 1);
    return t("processing.workflow.pass", { current: pass, total: plan.passes });
  };
  const currentNodeRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    currentNodeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentNode?.id]);
  const caption = specs.find(spec => spec.key === patternKey)?.caption ?? patternKey;
  return <section className="processing-workflow" aria-label={`${caption}: Workflow progress`}>
    <p className="processing-workflow__elapsed"><span>{t("processing.workflow.timeLeft")}</span><time>{formatPatternTime(timeLeftMs)}</time></p>
    {!nodes.length && <p>{selectedWorkflow && selectedWorkflow.steps.length === 0
      ? "This workflow has no steps configured."
      : "Enable a pattern and draw its ROI to preview the workflow."}</p>}
    <ol className="processing-workflow__tree" aria-label="Workflow steps, left to right">{nodes.map((node, i) => {
      const stepNumber = node.exposure?.recipeStepIndex ?? i + 1;
      return <li key={node.id}
      ref={node.status === "current" ? currentNodeRef : undefined}
      className={`processing-workflow__node processing-workflow__node--${node.status}`} aria-current={node.status === "current" ? "step" : undefined}>
      <span className="processing-workflow__number" title={`${node.caption}: ${node.status}`}
        aria-label={`Step ${stepNumber}: ${node.caption}, ${node.status}`}>{String(stepNumber).padStart(2, "0")}</span>
      {passLabel(node) && <span className={`processing-workflow__pass${i === nodes.length - 1 ? " processing-workflow__pass--last" : ""}`}
        title={`${passLabel(node)} completed`} aria-label={passLabel(node)!}>{passLabel(node)}</span>}
      {node.startedAt !== undefined && <time className={`processing-workflow__duration${i === nodes.length - 1 ? " processing-workflow__duration--last" : ""}`}
        aria-label={`Step ${stepNumber} time spent: ${formatWorkflowElapsed(workflowElapsedMs(node, now))}`}
        title={`Step ${stepNumber} time spent`}>{formatWorkflowElapsed(workflowElapsedMs(node, now))}</time>}
      {i === nodes.length - 1 && <span className="processing-workflow__end" role="img"
        aria-label={`Workflow end: ${completed === nodes.length ? "completed" : "not reached"}`}
        title={`Workflow end: ${completed === nodes.length ? "completed" : "not reached"}`}
        data-completed={completed === nodes.length} />}
    </li>;
    })}</ol>
  </section>;
}
