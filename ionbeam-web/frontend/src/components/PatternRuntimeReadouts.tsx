import { useEffect, useMemo, useState } from "react";
import { useTranslation, type TranslationKey } from "../i18n";
import { formatPatternTime, patternCenterOffset, type PatternParameters, type PatternRoi, type PatternSpec } from "../lib/processingPatterns";
import { imageWorldBounds } from "../lib/roiGeometry";
import { workflowElapsedMs } from "../lib/processingWorkflows";
import { useAppSelector } from "../store";
import { plannedPatternExposureMetrics } from "../lib/patternExposure";
import type { StairStepOverride } from "../lib/stairRecipe";
import type { ROIState } from "../store/scanSlice";
import { unitLabel } from "./ROIEditor";

/** Derived labels only: planned beam-on estimate before exposure; measured elapsed time during/after. */
export function PatternRuntimeReadouts({spec, roi, parameters, stairSteps, defaultMaterial, simulation}: {
  spec: PatternSpec; roi: PatternRoi | null; parameters: PatternParameters;
  stairSteps?: ReadonlyArray<StairStepOverride | null | undefined>; defaultMaterial?: string; simulation: boolean;
}) {
  const {t} = useTranslation();
  const field = useAppSelector(s => s.scan.roi);
  const lensLookup = useAppSelector(s => s.processing.lensLookup);
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
  const exposureCount = nodes.some(node => node.id.endsWith(":exposure"));
  const plannedExposure = useMemo(() => {
    if (!roi || !lensLookup) return null;
    try {
      return plannedPatternExposureMetrics(spec, roi, parameters, lensLookup, field as ROIState,
        {simulation, stairOverrides: stairSteps, defaultMaterial});
    } catch { return null; }
  }, [spec, roi, parameters, lensLookup, field, simulation, stairSteps, defaultMaterial]);
  // Keep a fresh recipe preview on the card as geometry or parameters change; the
  // prepared exposure nodes are a fallback while the recipe's lens data is unavailable.
  const spotCount = plannedExposure?.spotCount ?? (exposureCount
    ? nodes.reduce((sum, node) => sum + node.total, 0)
    : nodes.some(node => node.total > 0) ? nodes.reduce((sum, node) => sum + node.spot, 0) : null);
  const tr = (key: string, fallback: string) => { const value=t(key as TranslationKey); return value === key ? fallback : value; };
  return <div className="pattern-card__runtime" aria-label={tr("processing.runtime", "Runtime results")}>
    {(spec.readouts ?? []).map(readout => {
      const unit = readout.unit === "world" ? unitLabel(field.scale_unit) : readout.unit;
      const value = readout.source === "elapsed" ? measured ? formatPatternTime(elapsed)
        : plannedExposure ? formatPatternTime(plannedExposure.beamOnS * 1000) : "—"
        : readout.source === "spotCount" ? spotCount === null ? "—" : spotCount.toLocaleString()
        : offset ? (readout.source === "centerX" ? offset.x : offset.y).toFixed(2) : "—";
      const caption = tr(`processing.readout.${readout.name}`, readout.label);
      return <div className="pattern-card__result" key={readout.name}
        title={readout.source === "spotCount" ? plannedExposure !== null || exposureCount
          ? "Planned beam spots in the exposure lattice, updated from the current pattern and recipe. Repeated passes are not accumulated; this is not a measured exposure counter."
          : "Unblanked spots in the prepared workflow, summed across steps. Repeated passes are not accumulated; this is not a measured exposure counter."
          : readout.source === "elapsed" && !measured && plannedExposure
            ? "Estimated beam-on time from the current lattice plan. Settling and blanking overhead are excluded."
            : undefined}>
        <span>{caption}{unit ? ` (${unit})` : ""}</span>
        <output aria-label={`${spec.caption}: ${caption}`} data-readout={readout.name}>{value}</output>
      </div>;
    })}
  </div>;
}
