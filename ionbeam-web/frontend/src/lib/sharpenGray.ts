const SPATIAL_WEIGHTS = [1, 2, 1] as const;
const NOISE_RANGE_WEIGHTS = Float32Array.from({length: 256}, (_, delta) => Math.exp(-(delta * delta) / (2 * 16 * 16)));

/** Denoise detector grain while preserving edges, then apply display-only unsharp masking. */
export function sharpenGrayImage(data: Uint8ClampedArray, width: number, height: number, strength: number): void {
  const normalized = Math.max(0, Math.min(100, strength)) / 100;
  const amount = Math.sqrt(normalized) * 5;
  if (!amount || width < 3 || height < 3) return;
  const source = new Uint8ClampedArray(data);
  const pixelCount = width * height;
  const denoised = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) denoised[i] = source[i * 4];

  // Bilateral 3x3 smoothing: average nearby noise while down-weighting samples
  // across strong edges. The lookup table avoids repeated exponentials per pixel.
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const center = y * width + x;
      const p = center * 4;
      if (source[p + 3] === 0) continue;
      const centerValue = source[p];
      let weighted = 0;
      let totalWeight = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const neighbor = center + dy * width + dx;
          const neighborPixel = neighbor * 4;
          if (source[neighborPixel + 3] === 0) continue;
          const spatial = SPATIAL_WEIGHTS[dy + 1] * SPATIAL_WEIGHTS[dx + 1];
          const range = NOISE_RANGE_WEIGHTS[Math.abs(source[neighborPixel] - centerValue)];
          const weight = spatial * range;
          weighted += source[neighborPixel] * weight;
          totalWeight += weight;
        }
      }
      denoised[center] = totalWeight > 0 ? weighted / totalWeight : centerValue;
    }
  }

  // Sharpen detail remaining after edge-preserving denoising.
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const center = y * width + x;
      const p = center * 4;
      if (source[p + 3] === 0) continue;
      const blur = (
        denoised[center - width - 1] + 2 * denoised[center - width] + denoised[center - width + 1] +
        2 * denoised[center - 1] + 4 * denoised[center] + 2 * denoised[center + 1] +
        denoised[center + width - 1] + 2 * denoised[center + width] + denoised[center + width + 1]
      ) / 16;
      const value = Math.max(0, Math.min(255, Math.round(denoised[center] + amount * (denoised[center] - blur))));
      data[p] = data[p + 1] = data[p + 2] = value;
    }
  }
}
