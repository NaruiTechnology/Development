import type { VectorScanPath } from "../types/api";

const PATH_POINTS: Record<VectorScanPath, string> = {
  vertical_raster: "10,10 10,90 30,10 30,90 50,10 50,90 70,10 70,90 90,10 90,90",
  vertical_serpentine: "10,10 10,90 30,90 30,10 50,10 50,90 70,90 70,10 90,10 90,90",
  horizontal_sawtooth: "10,10 90,10 10,30 90,30 10,50 90,50 10,70 90,70 10,90 90,90",
  horizontal_triangle: "10,10 90,10 90,30 10,30 10,50 90,50 90,70 10,70 10,90 90,90",
};

export function VectorScanPathPreview({ path, label }: { path: VectorScanPath; label: string }) {
  return (
    <div className="vector-scan-path-preview" role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <rect x="5" y="5" width="90" height="90" rx="5" className="vector-scan-path-preview__frame" />
        <polyline points={PATH_POINTS[path]} className="vector-scan-path-preview__line" />
        <circle cx="10" cy="10" r="3" className="vector-scan-path-preview__start" />
      </svg>
    </div>
  );
}
