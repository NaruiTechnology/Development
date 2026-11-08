import { useEffect, useState } from "react";
import { workflowElapsedMs, formatWorkflowElapsed, type WorkflowProgress } from "../lib/processingWorkflows";
import { useAppSelector } from "../store";

/** Orbit's numbered timeline, adapted to scan stream completion events. */
export function ProcessingWorkflowPanel({ patternKey }: { patternKey: string }) {
  const { workflowProgress, specs, instances, workflows } = useAppSelector(s => s.processing);
  const cursor = useAppSelector(s => s.image.vectorCursor);
  const recordedNodes = workflowProgress.filter(step => step.id.startsWith(`${patternKey}:`));
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
  const caption = specs.find(spec => spec.key === patternKey)?.caption ?? patternKey;
  return <section className="processing-workflow" aria-label={`${caption}: Workflow progress`}>
    <p className="processing-workflow__elapsed">Elapsed: {formatWorkflowElapsed(elapsed)}</p>
    {!nodes.length && <p>Enable a pattern and draw its ROI to preview the workflow.</p>}
    <ol className="processing-workflow__tree" aria-label="Workflow steps, left to right">{nodes.map((node, i) => <li key={node.id}
      className={`processing-workflow__node processing-workflow__node--${node.status}`} aria-current={node.status === "current" ? "step" : undefined}>
      <span className="processing-workflow__number">{String(i + 1).padStart(2, "0")}</span>
      {i === nodes.length - 1 && <span className="processing-workflow__end" role="img"
        aria-label={`Workflow end: ${completed === nodes.length ? "completed" : "not reached"}`}
        title={`Workflow end: ${completed === nodes.length ? "completed" : "not reached"}`}
        data-completed={completed === nodes.length} />}
      <div className="processing-workflow__step"><small>{node.status}</small><strong>{node.caption}</strong>
        <span className="processing-workflow__elapsed">Elapsed: {node.startedAt === undefined ? "—" : formatWorkflowElapsed(workflowElapsedMs(node, now))}</span>
        <span>{node.pattern}</span><span>{node.action}</span>
        {node.threshold !== null && <span>AvgGray × SiO2: {node.threshold.toFixed(2)}</span>}
        {node.total > 0 && <span>Spot {node.spot.toLocaleString()} / {node.total.toLocaleString()} pixels</span>}
        {node.status === "current" && <progress aria-label="Current step progress" value={node.total > 0 ? Math.min(cursor, node.total) : undefined} max={Math.max(1, node.total)} />}
      </div>
    </li>)}</ol>
  </section>;
}
