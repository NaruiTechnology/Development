/**
 * Client-side CSV export. Used for live-streamed scans where the data
 * never went through the validated REST path (so the server has no
 * cache to download from). Format must byte-for-byte match what the
 * server emits — see service.last_csv_bytes for the reference.
 *
 * Raster format:
 *   N rows, each containing N space-separated uint16 values (one row
 *   per image-row, row-major). Empty trailing rows trimmed.
 *
 * Vector format:
 *   One CSV row per chunk (matching the FPGA chunk boundaries on the
 *   wire), space-separated uint16 values.
 *
 *   For client-side export of live streams we don't have chunk boundaries
 *   (the buffer was reassembled into a 2048×2048 image by sample-index
 *   mapping). So we emit one CSV row per image row instead — same total
 *   data, different chunking. Anyone parsing should accept either.
 */

/** Format a Uint16Array as one space-separated row, trailing newline. */
function row(values: Uint16Array | number[]): string {
  // Match Python csv.writer's default: each value as decimal, single
  // space delimiter, trailing CRLF (Python uses \r\n by default for csv).
  return Array.from(values).join(" ") + "\r\n";
}

/**
 * Render the raster image (Uint16Array, row-major, edge*edge in length)
 * to CSV bytes. The browser triggers a download from this.
 */
export function rasterCsvBlob(frame: Uint16Array, resolution: number): Blob {
  const parts: string[] = [];
  for (let r = 0; r < resolution; r++) {
    const start = r * resolution;
    const end = start + resolution;
    if (end > frame.length) break;
    parts.push(row(frame.subarray(start, end)));
  }
  return new Blob(parts, { type: "text/csv;charset=utf-8" });
}

/**
 * Render the vector image to CSV bytes. We emit one row per image row.
 * The image is dense for default-pattern scans (every cell visited)
 * and sparse for custom-pattern scans (unvisited cells stay zero).
 */
export function vectorCsvBlob(image: Uint16Array, edge: number): Blob {
  const parts: string[] = [];
  for (let r = 0; r < edge; r++) {
    const start = r * edge;
    const end = start + edge;
    if (end > image.length) break;
    parts.push(row(image.subarray(start, end)));
  }
  return new Blob(parts, { type: "text/csv;charset=utf-8" });
}

/** Trigger a browser download of a Blob with the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Append-click-remove pattern is the cross-browser-safe way to
  // programmatically trigger a download; just calling .click() on a
  // detached anchor doesn't work in Firefox.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay so the browser has time to start the
  // download. 1s is plenty.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
