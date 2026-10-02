/**
 * One entry of the scan-parameter chip drawn on the live image after a scan
 * completes. Labels (and enum-like values) are i18n keys so the chip follows
 * the UI language; numeric values are pre-formatted strings.
 */
export interface ScanParamItem {
  id: string;
  labelKey: string;
  value?: string;
  /** Translate this key instead of showing `value` (e.g. scan path names). */
  valueKey?: string;
  /** Plain suffix appended after the translated value. */
  suffix?: string;
}

export interface ScanParamSummary {
  kind: "raster" | "vector";
  items: ScanParamItem[];
}

/** The request fields the chip reads; both RasterRequest and VectorRequest fit. */
export interface ScanParamSource {
  resolution?: number;
  vector_resolution?: number;
  pattern?: string;
  scan_path?: string;
  points?: unknown[] | null;
  simulation_bitmap?: { width: number; height: number } | null;
  dwell?: number;
  latency_bytes?: number;
  output_mode?: string;
  frame_blank?: boolean;
  feedback_mode?: string;
  gray_level_range?: [number, number] | null;
  gray_level_skipped?: boolean | null;
}

/** One ADC conversion on the current revC3 gateware (see lib/scanTiming). */
export const DEFAULT_SAMPLE_PERIOD_NS = 125;

/** A dwell of N averages N + 1 ADC samples of `samplePeriodNs` each. */
export function formatPixelDwell(dwell: number, samplePeriodNs = DEFAULT_SAMPLE_PERIOD_NS): string {
  const pixelDwellNs = (Math.max(0, Math.trunc(dwell)) + 1) * samplePeriodNs;
  return pixelDwellNs >= 1000
    ? `${(pixelDwellNs / 1000).toFixed(pixelDwellNs >= 100_000 ? 0 : 2)} µs/px`
    : `${pixelDwellNs.toFixed(1)} ns/px`;
}

/**
 * Summarise the request a scan was started with. Called when the scan
 * starts, so later edits to the form do not change the chip of a finished
 * scan. Never keeps the request itself (custom vector points can be large).
 */
export function summarizeScanParams(
  kind: "raster" | "vector",
  req: ScanParamSource,
  options: { beamEnergyEv?: number | null; samplePeriodNs?: number } = {},
): ScanParamSummary {
  const items: ScanParamItem[] = [];
  const beamEnergy = options.beamEnergyEv;
  if (typeof beamEnergy === "number" && Number.isFinite(beamEnergy)) {
    items.push({ id: "beamEnergy", labelKey: "canvas.scanParams.beamEnergy", value: `${beamEnergy} eV` });
  }

  if (kind === "raster") {
    const res = Math.trunc(req.resolution ?? 0);
    if (res > 0) items.push({ id: "resolution", labelKey: "canvas.scanParams.resolution", value: `${res}×${res}` });
  } else if (req.pattern === "custom") {
    const bitmap = req.simulation_bitmap;
    items.push({
      id: "resolution",
      labelKey: "canvas.scanParams.resolution",
      valueKey: "canvas.scanParams.customPattern",
      suffix: Array.isArray(req.points)
        ? ` (${req.points.length.toLocaleString("en-US")})`
        : bitmap
          ? ` (${bitmap.width}×${bitmap.height})`
          : undefined,
    });
  } else {
    const edge = Math.trunc(req.vector_resolution ?? 0);
    if (edge > 0) items.push({ id: "resolution", labelKey: "canvas.scanParams.resolution", value: `${edge}×${edge}` });
    if (req.scan_path) {
      items.push({ id: "scanPath", labelKey: "canvas.scanParams.scanPath", valueKey: `vector.scanPath.${req.scan_path}` });
    }
  }

  // Custom points carry their own per-point dwell.
  if (typeof req.dwell === "number" && !(kind === "vector" && req.pattern === "custom")) {
    items.push({
      id: "dwell",
      labelKey: "canvas.scanParams.dwell",
      value: `${Math.trunc(req.dwell)} (${formatPixelDwell(req.dwell, options.samplePeriodNs)})`,
    });
  }
  if (typeof req.latency_bytes === "number") {
    items.push({ id: "latency", labelKey: "canvas.scanParams.latency", value: `${req.latency_bytes} B` });
  }
  if (req.output_mode) {
    items.push({ id: "outputMode", labelKey: "canvas.scanParams.outputMode", value: req.output_mode });
  }
  if (kind === "raster" && req.frame_blank) {
    items.push({ id: "frameBlank", labelKey: "canvas.scanParams.frameBlank", valueKey: "canvas.scanParams.on" });
  }

  if (kind === "vector" && req.gray_level_range) {
    const [lo, hi] = req.gray_level_range;
    items.push({ id: "grayRange", labelKey: "canvas.scanParams.grayRange", value: `${Math.min(lo, hi)}–${Math.max(lo, hi)}` });
    if (req.gray_level_skipped === true || req.gray_level_skipped === false) {
      items.push({
        id: "grayMode",
        labelKey: "canvas.scanParams.grayMode",
        valueKey: req.gray_level_skipped ? "roi.grayScale.confirm.mode.skip" : "roi.grayScale.confirm.mode.spot",
      });
    }
    if (req.feedback_mode === "adaptive_gray_feedback") {
      items.push({ id: "feedback", labelKey: "canvas.scanParams.feedback", valueKey: "canvas.scanParams.feedback.adaptive" });
    }
  }

  return { kind, items };
}
