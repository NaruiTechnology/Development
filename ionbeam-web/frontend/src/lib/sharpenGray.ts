/** Apply display-only unsharp masking to a grayscale RGBA ImageData buffer. */
export function sharpenGrayImage(data: Uint8ClampedArray, width: number, height: number, strength: number): void {
  const normalized = Math.max(0, Math.min(100, strength)) / 100;
  const amount = Math.sqrt(normalized) * 5;
  if (!amount || width < 3 || height < 3) return;
  const source = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = (y * width + x) * 4;
      const blur = (
        source[p] * 4 +
        source[p - width * 4] * 2 + source[p + width * 4] * 2 +
        source[p - 4] * 2 + source[p + 4] * 2 +
        source[p - width * 4 - 4] + source[p - width * 4 + 4] +
        source[p + width * 4 - 4] + source[p + width * 4 + 4]
      ) / 16;
      const value = Math.max(0, Math.min(255, Math.round(source[p] + amount * (source[p] - blur))));
      data[p] = data[p + 1] = data[p + 2] = value;
    }
  }
}
