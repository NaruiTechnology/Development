import { memo, useEffect, useMemo, useRef } from "react";
import { useAppSelector } from "../store";
import { selectExposurePreview } from "../store/exposureSlice";
import { useTranslation, type TranslationKey } from "../i18n";
import { imageWorldBounds, viewportBounds, worldToCanvasX, worldToCanvasY } from "../lib/roiGeometry";
import { patternBounds } from "../lib/processingPatterns";
import { sampleExposureLattice, exposureTraceFraction, exposureHeadFraction } from "../lib/exposurePreview";
import { orientCanvas } from "../lib/canvasOrientation";
import { effectiveScanRegions } from "../lib/scanRegions";
import { exposureViewScanRegions } from "../lib/processingScanRegions";
import type { WorkflowProgress } from "../lib/processingWorkflows";
import type { StreamTransforms } from "../store/scanSlice";

type Project = (x: number, y: number) => { x: number; y: number };
const COLORS = ["#fbbf24", "#fb923c", "#f472b6", "#a78bfa", "#4ade80"];

const ExposureStep = memo(function ExposureStep({ node, index, depthRank, depthCount, project, budget }: {
  node: WorkflowProgress; index: number; depthRank: number; depthCount: number; project: Project; budget: number;
}) {
  const e = node.exposure!;
  const spots = useMemo(() => sampleExposureLattice(e.model, e.shape, e.plan.lattice, budget, e.parameters),
    [e.model, e.shape, e.plan.lattice, e.parameters, budget]);
  const fraction = exposureTraceFraction(e.receivedSamples ?? 0, e.plan.count, node.status === "completed");
  const color = COLORS[index % COLORS.length];
  const points = spots.map(p => ({ ...project(p.x, p.y), order: p.order, connect: p.connect }));
  const path = points.map(p => `${p.connect ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const traced = points.filter(p => p.order <= fraction);
  const headFraction = exposureHeadFraction(e.receivedSamples ?? 0, e.plan.count);
  const headPoints = points.filter(p => p.order <= headFraction);
  const last = headPoints[headPoints.length - 1];
  const b = patternBounds(e.depthBand ?? e.shape);
  const corners = [[b.x_start,b.y_start], [b.x_end,b.y_start], [b.x_end,b.y_end], [b.x_start,b.y_end]]
    .map(([x,y]) => project(x,y));
  const gray = Math.round(225 - 170 * depthRank / depthCount);
  const center = project((b.x_start+b.x_end)/2, (b.y_start+b.y_end)/2);
  return <g pointerEvents="none" data-exposure-step={node.id}>
    {e.requestedDepthUM !== undefined && <polygon points={corners.map(p=>`${p.x},${p.y}`).join(" ")}
      fill={`rgb(${gray},${gray},${gray})`} fillOpacity={node.status === "upcoming" ? 0.25 : 0.78}
      stroke="#cbd5e1" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />}
    <path d={path} fill="none" stroke="#22d3ee" strokeWidth={0.8} opacity={0.5} vectorEffect="non-scaling-stroke" />
    <path d={traced.map(p => `${p.connect ? "L" : "M"}${p.x},${p.y}`).join(" ")}
      fill="none" stroke={color} strokeWidth={0.65} opacity={0.6} vectorEffect="non-scaling-stroke" />
    {points.map((p,i) => <circle key={i} cx={p.x} cy={p.y} r={1}
      fill="none" stroke={p.order <= fraction ? color : "#22d3ee"}
      strokeWidth={0.65} opacity={p.order <= fraction ? 0.95 : 0.5} vectorEffect="non-scaling-stroke" />)}
    {node.status === "current" && last && <circle cx={last.x} cy={last.y} r={3.5}
      fill="none" stroke="white" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />}
    {e.requestedDepthUM !== undefined && <text x={center.x} y={center.y} textAnchor="middle"
      fill="white" stroke="#111827" strokeWidth={2.5} paintOrder="stroke" fontSize={11}>
      {depthRank} · {e.requestedDepthUM.toFixed(2)} µm
    </text>}
  </g>;
});

export function ExposureLatticeGeometry({ project }: { project: Project }) {
  const nodes = useAppSelector(selectExposurePreview);
  const steps = nodes.filter(n => n.exposure);
  const budget = Math.max(4, Math.floor(3000 / Math.max(1, steps.length)));
  const counts = new Map<string, number>(), ranks = new Map<string, number>();
  for (const step of steps) {
    const key = step.id.split(":")[0];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return <g>{steps.map((n,i) => {
    const key = n.id.split(":")[0], rank = (ranks.get(key) ?? 0) + 1;
    ranks.set(key, rank);
    return <ExposureStep key={n.id} node={n} index={i} depthRank={rank}
      depthCount={counts.get(key)!} project={project} budget={budget} />;
  })}</g>;
}

/** Independent overlay: exposure detector values never replace the acquired image. */
export function ExposureLatticeOverlay({ transforms: displayTransforms }: {
  transforms?: {rotate90: boolean; xflip: boolean; yflip: boolean};
}) {
  const roi = useAppSelector(s => s.scan.roi);
  const viewPhase = useAppSelector(s => s.exposure.viewPhase);
  const configuredTransforms = useAppSelector(s => s.scan.streamTransforms);
  const transforms = displayTransforms ?? configuredTransforms;
  if (viewPhase === "queued" || viewPhase === "scanning") return null;
  const bounds = imageWorldBounds(roi);
  const project: Project = (wx,wy) => {
    let x = (wx-bounds.x_origin)/(bounds.x_end-bounds.x_origin);
    let y = (wy-bounds.y_origin)/(bounds.y_end-bounds.y_origin);
    if (transforms.rotate90) [x,y] = [1-y,x];
    if (transforms.xflip) x=1-x;
    if (transforms.yflip) y=1-y;
    return {x:x*640,y:y*640};
  };
  return <svg className="exposure-lattice-overlay" viewBox="0 0 640 640" preserveAspectRatio="none"
    aria-hidden="true"><ExposureLatticeGeometry project={project} /></svg>;
}

/** Separate raster canvas for the on-the-fly View frames; the exposure image and its trace stay intact below it. */
export function ExposureViewCanvasOverlay({ transforms, processingViewport = false }: {
  transforms?: StreamTransforms; processingViewport?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frames = useAppSelector(s => s.image.exposureViewFrames);
  const roi = useAppSelector(s => s.scan.roi);
  const specs = useAppSelector(s => s.processing.specs);
  const instances = useAppSelector(s => s.processing.instances);
  const viewPhase = useAppSelector(s => s.exposure.viewPhase);
  const viewActive = viewPhase === "queued" || viewPhase === "scanning";
  const scanBounds = useMemo(() => {
    const regions = exposureViewScanRegions(specs, instances, roi).regions;
    return effectiveScanRegions(regions, roi.scan_zoom, roi).filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== null);
  }, [specs, instances, roi]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = 640; canvas.height = 640;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, 640, 640);
    const field = imageWorldBounds(roi);
    const viewport = viewportBounds(roi);
    const worldWidth = field.x_end - field.x_origin, worldHeight = field.y_end - field.y_origin;
    if ((!frames.length && !viewActive) || !worldWidth || !worldHeight) return;
    const projectX = (x: number) => processingViewport ? worldToCanvasX(x, field, viewport) : (x - field.x_origin) / worldWidth * 640;
    const projectY = (y: number) => processingViewport ? worldToCanvasY(y, field, viewport) : (y - field.y_origin) / worldHeight * 640;
    for (const frame of frames) {
      let low = 65535, high = 0;
      for (const value of frame.pixels) { if (value < low) low = value; if (value > high) high = value; }
      const span = Math.max(1, high - low);
      const scratch = document.createElement("canvas");
      scratch.width = scratch.height = frame.resolution;
      const scratchContext = scratch.getContext("2d");
      if (!scratchContext) continue;
      const image = scratchContext.createImageData(frame.resolution, frame.resolution);
      for (let i = 0; i < frame.pixels.length; i++) {
        const gray = Math.max(0, Math.min(255, Math.round((frame.pixels[i] - low) * 255 / span)));
        const offset = i * 4;
        image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = gray;
        image.data[offset + 3] = 220;
      }
      scratchContext.putImageData(image, 0, 0);
      const x = projectX(frame.bounds.x_start);
      const y = projectY(frame.bounds.y_start);
      const width = projectX(frame.bounds.x_end) - x;
      const height = projectY(frame.bounds.y_end) - y;
      context.drawImage(scratch, x, y, width, height);
    }
    const paths = frames.length ? frames.map(frame => frame.bounds) : scanBounds;
    context.save();
    context.strokeStyle = "rgba(34, 211, 238, 0.9)";
    context.lineWidth = 1;
    for (const bounds of paths) {
      const x0 = projectX(bounds.x_start);
      const y0 = projectY(bounds.y_start);
      const width = projectX(bounds.x_end) - x0;
      const height = projectY(bounds.y_end) - y0;
      context.beginPath();
      context.rect(x0, y0, width, height);
      context.stroke();
    }
    context.restore();
    if (!processingViewport && transforms) orientCanvas(canvas, transforms);
  }, [frames, roi, transforms, viewActive, scanBounds, processingViewport]);
  if (!frames.length && !viewActive) return null;
  return <canvas ref={canvasRef} className="exposure-view-canvas" width={640} height={640}
    aria-label="View scan overlay for pattern ROIs" />;
}

export function ExposureLatticeMessage() {
  const { t } = useTranslation();
  const progress = useAppSelector(selectExposurePreview);
  const { error, viewPhase, viewError, viewReceivedSamples, viewReceivedChunks, viewExpectedSamples } = useAppSelector(s => s.exposure);
  const steps = progress.filter(n => n.exposure);
  const viewing = viewPhase === "queued" || viewPhase === "scanning";
  const node = steps.find(n => n.status === "current") ?? [...steps].reverse().find(n => n.status !== "upcoming") ?? steps[0];
  const errorMessage = error && (
    <div className="exposure-lattice-message exposure-lattice-message--error" role="alert">
      <strong>{t("canvas.scanParams.exposureLattice")} · {t("processing.exposure.status.error")}</strong>
      <span>{error}</span>
    </div>
  );
  const viewMessage = viewPhase !== "idle" && (
    <div className={`exposure-lattice-message exposure-lattice-message--view${viewPhase === "error" ? " exposure-lattice-message--error" : ""}`}
      role={viewPhase === "error" ? "alert" : "status"}>
      <span>{t(`processing.exposure.viewStatus.${viewPhase}` as TranslationKey)}</span>
      {viewPhase === "scanning" && viewExpectedSamples > 0 && <span className="exposure-lattice-message__data">
        {viewReceivedSamples >= viewExpectedSamples
          ? t("processing.exposure.viewFinishing", {samples: viewExpectedSamples.toLocaleString()})
          : viewReceivedChunks
          ? t("processing.exposure.viewData", {samples: viewReceivedSamples.toLocaleString(), expected: viewExpectedSamples.toLocaleString(), chunks: viewReceivedChunks.toLocaleString()})
          : t("processing.exposure.viewWaitingData", {expected: viewExpectedSamples.toLocaleString()})}
      </span>}
      {viewError && <span>{viewError}</span>}
    </div>
  );
  if (!node?.exposure || viewing) return <>{errorMessage}{viewMessage}</>;
  const e = node.exposure, p = e.plan;
  const index = steps.indexOf(node)+1;
  return <>
    {errorMessage}
    {viewMessage}
    <div className="exposure-lattice-message exposure-lattice-message--pattern" role="status" aria-live="polite">
    <strong>{t("canvas.scanParams.exposureLattice")} · {node.pattern} · {node.caption} · {t(`processing.exposure.status.${node.status}` as TranslationKey)}</strong>
    <span>{e.beamCurrentPA} pA · Ø {(p.spotDiameterUM*1000).toFixed(1)} nm · {t("processing.exposure.pitch")} {(p.spacingUM*1000).toFixed(2)} nm · OL {p.overlapPct}% · {e.dwellUS} µs · {p.lattice.axis.toUpperCase()} · {p.countExact ? "" : "≈"}{p.count.toLocaleString()} {t("processing.exposure.spots")} · {p.passes} {t("processing.exposure.passes")}</span>
    {e.requestedDepthUM !== undefined && <span>Material {e.material ?? "—"} · Depth {e.requestedDepthUM.toFixed(3)} µm · Layer {e.incrementUM?.toFixed(3) ?? "—"} µm · Sr {e.removalRate ? `${e.removalRate.toPrecision(4)} µm³/nC` : "not calibrated"}</span>}
    {e.lineSpacingUM !== undefined && <span>{t("processing.exposure.lineSpacing")} {e.lineSpacingUM.toFixed(4)} µm</span>}
    <span className="exposure-lattice-message__legend">
      <span style={{color:"#22d3ee"}}>○ {t("processing.exposure.path")}</span>
      <span style={{color:COLORS[(index-1)%COLORS.length]}}>○ {t("processing.exposure.trace")}</span>
      <span>○ {t("processing.exposure.head")}</span>
      <span>{t("processing.exposure.schematic")}</span>
      {steps.some(n=>n.exposure?.requestedDepthUM !== undefined) && <span>{t("processing.exposure.depth")}</span>}
    </span>
    </div>
  </>;
}
