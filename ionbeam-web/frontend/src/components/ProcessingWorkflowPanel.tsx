import { useEffect, useMemo, useRef, useState } from "react";
import { workflowElapsedMs, formatWorkflowElapsed, type WorkflowProgress } from "../lib/processingWorkflows";
import { plannedPatternExposureMetrics } from "../lib/patternExposure";
import { formatPatternTime } from "../lib/processingPatterns";
import { useAppSelector } from "../store";

/** Orbit's numbered timeline, adapted to scan stream completion events. */
export function ProcessingWorkflowPanel({ patternKey }: { patternKey: string }) {
  const { workflowProgress, specs, instances, workflows, materials, lensLookup } = useAppSelector(s => s.processing);
  const {progress: exposureProgress, phase: exposurePhase} = useAppSelector(s => s.exposure);
  const field = useAppSelector(s => s.scan.roi);
  const simulation = useAppSelector(s => s.status.defaults?.is_production === false);
  const instance = instances[patternKey];
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
  const elapsed = nodes.reduce((total, node) => total + workflowElapsedMs(node, now), 0);
  const estimateSeconds = useMemo(() => {
    const preparedNodes = exposureProgress.filter(node => node.id.startsWith(`${patternKey}:`) && node.exposure);
    if (preparedNodes.length) return preparedNodes.reduce((sum, node) => sum + (node.exposure?.plan.beamOnS ?? 0), 0);
    const spec = specs.find(item => item.key === patternKey);
    if (!spec || !instance?.roi || !lensLookup) return 0;
    const materialRemovalRates = Object.fromEntries(materials
      .filter(material => material.removalRateUM3PerNC !== undefined)
      .map(material => [material.name, material.removalRateUM3PerNC!]));
    try {
      return plannedPatternExposureMetrics(spec, instance.roi, instance.parameters, lensLookup, field,
        {simulation, stairOverrides: instance.stairSteps, defaultMaterial: materials[0]?.name, materialRemovalRates}).beamOnS;
    } catch { return 0; }
  }, [exposureProgress, patternKey, specs, instance, lensLookup, field, simulation, materials]);
  const exposureInProgress = ["preparing", "running", "paused", "stopping"].includes(exposurePhase);
  const timeLeftMs = useMemo(() => {
    if (exposurePhase === "completed") return 0;
    const planned = exposureProgress.filter(node => node.id.startsWith(`${patternKey}:`) && node.exposure);
    if (!planned.length || exposurePhase === "idle" || exposurePhase === "preparing") return estimateSeconds * 1000;
    const completedNodes = planned.filter(node => node.status === "completed");
    const currentNode = planned.find(node => node.status === "current");
    const futureNodes = planned.filter(node => node.status === "upcoming");
    const completedActualMs = completedNodes.reduce((sum, node) => sum + workflowElapsedMs(node, now), 0);
    const completedPlannedMs = completedNodes.reduce((sum, node) => sum + (node.exposure?.plan.beamOnS ?? 0) * 1000, 0);
    let scale = completedPlannedMs > 0 ? completedActualMs / completedPlannedMs : 1;
    let currentRemainingMs = 0;
    if (currentNode?.exposure) {
      const currentElapsedMs = workflowElapsedMs(currentNode, now);
      const plan = currentNode.exposure.plan;
      const expectedSamples = plan.count * plan.passes;
      const fraction = expectedSamples > 0 && currentNode.exposure.receivedSamples
        ? Math.min(0.98, currentNode.exposure.receivedSamples / expectedSamples) : 0;
      const currentPlanMs = plan.beamOnS * 1000;
      const observedCurrentTotalMs = fraction >= 0.1 ? currentElapsedMs / fraction : currentPlanMs * scale;
      if (fraction >= 0.1 && currentPlanMs > 0) scale = Math.max(scale, observedCurrentTotalMs / currentPlanMs);
      currentRemainingMs = Math.max(0, observedCurrentTotalMs - currentElapsedMs);
      if (exposureInProgress) currentRemainingMs = Math.max(1000, currentRemainingMs);
    }
    const futureMs = futureNodes.reduce((sum, node) => sum + (node.exposure?.plan.beamOnS ?? 0) * 1000 * scale, 0);
    return currentRemainingMs + futureMs;
  }, [exposurePhase, exposureProgress, patternKey, estimateSeconds, now, exposureInProgress]);
  const completed = nodes.filter(n => n.status === "completed").length;
  const currentNode = nodes.find(node => node.status === "current");
  const currentNodeRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    currentNodeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentNode?.id]);
  const caption = specs.find(spec => spec.key === patternKey)?.caption ?? patternKey;
  return <section className="processing-workflow" aria-label={`${caption}: Workflow progress`}>
    <p className="processing-workflow__elapsed"><span>Time left:</span><time>{formatPatternTime(timeLeftMs)}</time></p>
    {!nodes.length && <p>{selectedWorkflow && selectedWorkflow.steps.length === 0
      ? "This workflow has no steps configured."
      : "Enable a pattern and draw its ROI to preview the workflow."}</p>}
    <ol className="processing-workflow__tree" aria-label="Workflow steps, left to right">{nodes.map((node, i) => <li key={node.id}
      ref={node.status === "current" ? currentNodeRef : undefined}
      className={`processing-workflow__node processing-workflow__node--${node.status}`} aria-current={node.status === "current" ? "step" : undefined}>
      <span className="processing-workflow__number" title={`${node.caption}: ${node.status}`}
        aria-label={`Step ${i + 1}: ${node.caption}, ${node.status}`}>{String(i + 1).padStart(2, "0")}</span>
      {node.startedAt !== undefined && <time className={`processing-workflow__duration${i === nodes.length - 1 ? " processing-workflow__duration--last" : ""}`}
        aria-label={`Step ${i + 1} time spent: ${formatWorkflowElapsed(workflowElapsedMs(node, now))}`}
        title={`Step ${i + 1} time spent`}>{formatWorkflowElapsed(workflowElapsedMs(node, now))}</time>}
      {i === nodes.length - 1 && <span className="processing-workflow__end" role="img"
        aria-label={`Workflow end: ${completed === nodes.length ? "completed" : "not reached"}`}
        title={`Workflow end: ${completed === nodes.length ? "completed" : "not reached"}`}
        data-completed={completed === nodes.length} />}
    </li>)}</ol>
  </section>;
}
