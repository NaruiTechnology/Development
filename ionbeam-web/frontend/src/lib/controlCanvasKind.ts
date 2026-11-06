/** The selected navigation tab owns the visible canvas, independently of acquisition state. */
export function controlCanvasKind(
  top: "scan" | "processing" | "calibrate",
  scan: "raster" | "vector",
  calibration: "dimension" | "mag",
): "raster" | "vector" | "roi" | "mag" {
  if (top === "scan") return scan;
  if (top === "processing" || calibration === "dimension") return "roi";
  return "mag";
}
