export interface CanvasOrientation {
  xflip: boolean;
  yflip: boolean;
  rotate90: boolean;
}

/** Apply the configured clockwise quarter-turn, then horizontal/vertical flips. */
export function orientCanvas(canvas: HTMLCanvasElement, transforms: CanvasOrientation): void {
  if (!transforms.xflip && !transforms.yflip && !transforms.rotate90) return;
  const source = document.createElement("canvas");
  source.width = canvas.width;
  source.height = canvas.height;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) return;
  sourceContext.drawImage(canvas, 0, 0);

  const width = source.width;
  const height = source.height;
  const outputWidth = transforms.rotate90 ? height : width;
  const outputHeight = transforms.rotate90 ? width : height;
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d");
  if (!context) return;

  if (transforms.rotate90) {
    // Canvas coordinates have +Y downward. Map (x, y) to (height - y, x).
    context.setTransform(0, transforms.yflip ? -1 : 1, transforms.xflip ? 1 : -1, 0,
      transforms.xflip ? 0 : height, transforms.yflip ? width : 0);
  } else {
    context.setTransform(transforms.xflip ? -1 : 1, 0, 0, transforms.yflip ? -1 : 1,
      transforms.xflip ? outputWidth : 0, transforms.yflip ? outputHeight : 0);
  }
  context.drawImage(source, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);
}
