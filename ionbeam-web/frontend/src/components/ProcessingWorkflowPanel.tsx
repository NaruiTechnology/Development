import { useEffect, useRef, useState } from "react";
import { workflowElapsedMs, formatWorkflowElapsed, type WorkflowProgress } from "../lib/processingWorkflows";
import { useAppSelector } from "../store";

/** Orbit's numbered timeline, adapted to scan stream completion events. */
export function ProcessingWorkflowPanel({ patternKey }: { patternKey: string }) {
  const { workflowProgress, specs, instances, workflows } = useAppSelector(s => s.processing);
  const exposureProgress = useAppSelector(s => s.exposure.progress);
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
  const running = nodes.some(node => node.status === "current" && node.startedAt !== undefined);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = nodes.reduce((total, node) => total + workflowElapsedMs(node, now), 0);
  const completed = nodes.filter(n => n.status === "completed").length;
  const currentNode = nodes.find(node => node.status === "current");
  const currentNodeRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    currentNodeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentNode?.id]);
  const caption = specs.find(spec => spec.key === patternKey)?.caption ?? patternKey;
  return <section className="processing-workflow" aria-label={`${caption}: Workflow progress`}>
    <p className="processing-workflow__elapsed">Elapsed: {formatWorkflowElapsed(elapsed)}</p>
    {!nodes.length && <p>{selectedWorkflow && selectedWorkflow.steps.length === 0
      ? "This workflow has no steps configured."
      : "Enable a pattern and draw its ROI to preview the workflow."}</p>}
    <ol className="processing-workflow__tree" aria-label="Workflow steps, left to right">{nodes.map((node, i) => <li key={node.id}
      ref={node.status === "current" ? currentNodeRef : undefined}
      className={`processing-workflow__node processing-workflow__node--${node.status}`} aria-current={node.status === "current" ? "step" : undefined}>
      <span className="processing-workflow__number" title={`${node.caption}: ${node.status}`}
        aria-label={`Step ${i + 1}: ${node.caption}, ${node.status}`}>{String(i + 1).padStart(2, "0")}</span>
      {i === nodes.length - 1 && <span className="processing-workflow__end" role="img"
        aria-label={`Workflow end: ${completed === nodes.length ? "completed" : "not reached"}`}
        title={`Workflow end: ${completed === nodes.length ? "completed" : "not reached"}`}
        data-completed={completed === nodes.length} />}
    </li>)}</ol>
  </section>;
}
