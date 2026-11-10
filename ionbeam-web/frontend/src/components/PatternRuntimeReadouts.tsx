import { useEffect, useState } from "react";
import { useTranslation, type TranslationKey } from "../i18n";
import { formatPatternTime, patternCenterOffset, type PatternRoi, type PatternSpec } from "../lib/processingPatterns";
import { imageWorldBounds } from "../lib/roiGeometry";
import { workflowElapsedMs } from "../lib/processingWorkflows";
import { useAppSelector } from "../store";
import { unitLabel } from "./ROIEditor";

/** Derived labels only: no editable fields or fabricated milling-time estimate. */
export function PatternRuntimeReadouts({spec, roi}: {spec: PatternSpec; roi: PatternRoi | null}) {
  const {t} = useTranslation();
  const field = useAppSelector(s => s.scan.roi);
  const progress = useAppSelector(s => s.exposure.progress.length ? s.exposure.progress : s.processing.workflowProgress);
  const nodes = progress.filter(n => n.id.startsWith(`${spec.key}:`));
  const running = nodes.some(n => n.status === "current" && n.startedAt !== undefined);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);
  const offset = patternCenterOffset(roi, imageWorldBounds(field));
  const elapsed = nodes.reduce((total,n) => total + workflowElapsedMs(n, now),0);
  const measured = nodes.some(n => n.startedAt !== undefined);
  const spotCount = nodes.some(node => node.total > 0)
    ? nodes.reduce((sum, node) => sum + node.spot, 0) : null;
  const tr = (key: string, fallback: string) => { const value=t(key as TranslationKey); return value === key ? fallback : value; };
  return <div className="pattern-card__runtime" aria-label={tr("processing.runtime", "Runtime results")}>
    {(spec.readouts ?? []).map(readout => {
      const unit = readout.unit === "world" ? unitLabel(field.scale_unit) : readout.unit;
      const value = readout.source === "elapsed" ? measured ? formatPatternTime(elapsed) : "—"
        : readout.source === "spotCount" ? spotCount === null ? "—" : spotCount.toLocaleString()
        : offset ? (readout.source === "centerX" ? offset.x : offset.y).toFixed(2) : "—";
      const caption = tr(`processing.readout.${readout.name}`, readout.label);
      const exposureCount = nodes.some(node => node.id.endsWith(":exposure"));
      return <div className="pattern-card__result" key={readout.name}
        title={readout.source === "spotCount" ? exposureCount
          ? "Planned beam spots in the exposure lattice. Repeated passes are not accumulated; this is not a measured exposure counter."
          : "Unblanked spots in the prepared workflow, summed across steps. Repeated passes are not accumulated; this is not a measured exposure counter." : undefined}>
        <span>{caption}{unit ? ` (${unit})` : ""}</span>
        <output aria-label={`${spec.caption}: ${caption}`} data-readout={readout.name}>{value}</output>
      </div>;
    })}
  </div>;
}
