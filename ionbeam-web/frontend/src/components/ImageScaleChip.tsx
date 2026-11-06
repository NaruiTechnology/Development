import { imageScale, type ImageExtent } from "../lib/imageScale";

export function ImageScaleChip({ extent, rotate90 = false, zoom = 1 }: { extent: ImageExtent | null; rotate90?: boolean; zoom?: number }) {
  const scale = imageScale(extent, rotate90, zoom);
  if (!scale) return null;
  return (
    <div className="canvas-image-scale" data-scale-fraction={scale.fraction} data-scale-label={scale.label} role="img" aria-label={scale.label} style={{ width: `calc(${scale.fraction * 100}% + 22px)` }}>
      <span className="canvas-image-scale__label">{scale.label}</span>
      <span className="canvas-image-scale__bar" aria-hidden="true" />
    </div>
  );
}

