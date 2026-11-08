import { useTranslation, type TranslationKey } from "../i18n";
import { formatPixelSize, pixelSizeFromExtent, selectionPixelSize } from "../lib/pixelSize";
import { DAC_MAX } from "../lib/roiDac";
import { imageWorldBounds } from "../lib/roiGeometry";
import { transform } from "../lib/scanGeometry";
import { useAppSelector } from "../store";
import { selectGlobalPixelSize } from "../store/selectors";
import type { ROIRequest } from "../types/api";

/** Processing status reads only its workspace store and stream counters. */
export function ProcessingScanStatus({ kind }: { kind: "raster" | "vector" }) {
  const { t, fmt } = useTranslation();
  const scan = useAppSelector(s => s.scan);
  const image = useAppSelector(s => s.image);
  const calibrated = useAppSelector(selectGlobalPixelSize);
  const { roi } = scan;
  const raster = kind === "raster";
  const edge = raster ? image.resolution : image.vectorEdge;
  const cursor = raster ? image.cursor : image.vectorSource === "vector" ? image.vectorCursor : 0;
  const parallel = raster ? image.rasterParallelROIs : image.vectorParallelROIs;
  const active = raster ? image.rasterROI : image.vectorROI;
  const custom = !raster && image.vectorPattern === "custom";
  const total = !raster && image.vectorSource !== "vector" ? 0
    : custom ? image.vectorCustomCount : edge * edge * (parallel?.length || 1);
  const progress = total > 0 ? Math.min(100, Math.round(cursor / total * 100)) : 0;
  const regions = parallel?.length ? parallel : [active];
  const bounds = imageWorldBounds(roi);
  const basePixelSize = calibrated ?? pixelSizeFromExtent(roi.x_end - roi.x_origin,
    roi.y_end - roi.y_origin, edge, edge, roi.scale_unit, "scanRegion");
  const sourcePixelSize = custom && image.vectorCustomRenderInFrame
    ? pixelSizeFromExtent(bounds.x_end - bounds.x_origin, bounds.y_end - bounds.y_origin,
      edge, edge, roi.scale_unit, "scanRegion") : null;
  const point = (x: number, y: number) => `(${x.toFixed(2)}, ${y.toFixed(2)}) ${roi.scale_unit}`;
  const worldRegion = (region: ROIRequest | null): ROIRequest => {
    const r = region ?? { x_start: 0, x_end: DAC_MAX, y_start: 0, y_end: DAC_MAX };
    const corners = [r.x_start, r.x_end].flatMap(x => [r.y_start, r.y_end].map(y =>
      roi.scanGeometry?.enabled ? transform(roi.scanGeometry.forward, [x, y]) : [
        roi.x_origin + x / DAC_MAX * (roi.x_end - roi.x_origin),
        roi.y_origin + y / DAC_MAX * (roi.y_end - roi.y_origin),
      ]));
    return { x_start: Math.min(...corners.map(p => p[0])), x_end: Math.max(...corners.map(p => p[0])),
      y_start: Math.min(...corners.map(p => p[1])), y_end: Math.max(...corners.map(p => p[1])) };
  };
  return <div className="canvas-meta processing-scan-status" aria-label="Processing scan status">
    <span>{t("canvas.meta.phase")} <b>{t(`phase.${scan.phase}` as TranslationKey)}</b></span>
    <span>{t("canvas.meta.chunks")} <b>{fmt(scan.chunksReceived)}</b></span>
    <span>{t("canvas.meta.bytes")} <b>{fmt(scan.bytesReceived)}</b></span>
    <span>{t("canvas.meta.resolution")} <b>{fmt(edge)}×{fmt(edge)}</b></span>
    <span>{t(raster ? "canvas.meta.pixels" : "canvas.meta.samples")} <b>{fmt(cursor)} / {fmt(total)}</b></span>
    <span>{t("canvas.meta.progress")} <b>{progress}%</b></span>
    {!raster && <span>{custom ? t("vector.pattern.custom") : t(`vector.scanPath.${image.vectorScanPath}` as TranslationKey)}</span>}
    {regions.map((region, index) => {
      const world = worldRegion(region);
      const pixelSize = sourcePixelSize ?? selectionPixelSize(basePixelSize, world, roi, edge);
      return <span key={index} title={t("canvas.meta.roi.title")}>
        {t("canvas.meta.roi")}{regions.length > 1 ? ` ${index + 1}` : ""}{" "}
        <b>{point(world.x_start, world.y_start)} → {point(world.x_end, world.y_end)}
          {pixelSize && ` · ${t("canvas.meta.pixelSize")} ${formatPixelSize(pixelSize)}`}</b>
      </span>;
    })}
    {scan.errorMessage && <span role="alert">{scan.errorMessage}</span>}
  </div>;
}
