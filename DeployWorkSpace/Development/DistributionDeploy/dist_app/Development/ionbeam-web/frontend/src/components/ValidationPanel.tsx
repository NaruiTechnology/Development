/**
 * Run-report panel: validation result + download buttons.
 *
 * The panel now shows after EITHER kind of completed scan:
 *   - Validated run (POST /scan/{kind}/run)  -> full report + checks + downloads
 *   - Live stream (WebSocket)                -> just downloads, no checks
 *
 * Download buttons:
 *   - CSV: validated runs hit /api/scan/last/csv on the server.
 *          Live streams (no validated result) generate the CSV
 *          client-side from imageSlice; matches the server format.
 *   - Figure (PNG): always hits /api/scan/last/figure (matplotlib only
 *          runs server-side). Both validated and streaming scans
 *          populate the server's last-scan cache.
 */
import { useState } from "react";

import { useAppSelector } from "../store";
import {
  rasterCsvBlob,
  vectorCsvBlob,
  downloadBlob,
} from "../lib/csvExport";

type DownloadState = "idle" | "fetching" | "error";

export function ValidationPanel() {
  const result = useAppSelector((s) => s.scan.lastResult);
  const error = useAppSelector((s) => s.scan.errorMessage);
  const phase = useAppSelector((s) => s.scan.phase);
  const kind = useAppSelector((s) => s.scan.kind);

  // Live-stream pixel state. Used as the source for client-side CSV
  // export when the user ran the stream (not validated).
  const rasterFrame = useAppSelector((s) => s.image.frame);
  const rasterRes = useAppSelector((s) => s.image.resolution);
  const rasterCursor = useAppSelector((s) => s.image.cursor);
  const vectorImage = useAppSelector((s) => s.image.vectorImage);
  const vectorEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  // For vector scans the operator picks a render mode in the canvas
  // toolbar. The figure download honours that choice so the PNG matches
  // what they're currently looking at.
  const vectorRenderMode = useAppSelector((s) => s.scan.vectorRenderMode);

  const [csvState, setCsvState] = useState<DownloadState>("idle");
  const [figState, setFigState] = useState<DownloadState>("idle");
  const [csvErr, setCsvErr] = useState<string | null>(null);
  const [figErr, setFigErr] = useState<string | null>(null);

  // True when there's anything worth downloading: a validated result
  // with has_data, OR a completed/paused live stream with pixels in the
  // image buffers.
  const haveStreamData =
    (kind === "raster" && rasterCursor > 0) ||
    (kind === "vector" && vectorCursor > 0);
  const haveValidatedData = result?.has_data === true;
  const haveAnyData =
    haveValidatedData ||
    (haveStreamData && (phase === "completed" || phase === "paused"));

  if (error) {
    return (
      <div className="card__body">
        <div style={{ color: "var(--c-danger)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!result && !haveAnyData) {
    return (
      <div className="card__body muted" style={{ fontSize: 12 }}>
        No completed scan yet. Press <b>Run</b> for a live stream, or
        <b> Run validated</b> for timing + checks. After either, you'll
        be able to download CSV and PNG figure here.
      </div>
    );
  }

  /* -------- download handlers ------------------------------------------ */

  async function downloadCsv() {
    setCsvState("fetching");
    setCsvErr(null);
    try {
      if (haveValidatedData) {
        // Server has the validated bytes — use them as the source of
        // truth so the CSV matches the validation report exactly.
        const r = await fetch("/api/scan/last/csv");
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        const blob = await r.blob();
        const filename = filenameFromContentDisposition(r.headers.get("content-disposition"))
          ?? defaultCsvFilename(kind, result);
        downloadBlob(blob, filename);
      } else {
        // Live stream: generate from the imageSlice buffer.
        const blob = kind === "raster"
          ? rasterCsvBlob(rasterFrame, rasterRes)
          : vectorCsvBlob(vectorImage, vectorEdge);
        const filename = defaultCsvFilename(kind, null);
        downloadBlob(blob, filename);
      }
      setCsvState("idle");
    } catch (e: any) {
      setCsvState("error");
      setCsvErr(e?.message ?? String(e));
    }
  }

  async function downloadFigure() {
    setFigState("fetching");
    setFigErr(null);
    try {
      // Render mode applies to vector only. Raster ignores it server-side,
      // so passing it unconditionally is harmless and keeps the URL shape
      // consistent across both kinds.
      const url =
        kind === "vector"
          ? `/api/scan/last/figure?render=${encodeURIComponent(vectorRenderMode)}`
          : "/api/scan/last/figure";
      const r = await fetch(url);
      if (!r.ok) {
        // Server returns 404 if the cache is empty (e.g., the live
        // stream was paused and nothing landed there yet) or 500 if
        // matplotlib is missing.
        const detail = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${detail || "figure render failed"}`);
      }
      const blob = await r.blob();
      const filename = filenameFromContentDisposition(r.headers.get("content-disposition"))
        ?? defaultFigureFilename(kind, result);
      downloadBlob(blob, filename);
      setFigState("idle");
    } catch (e: any) {
      setFigState("error");
      setFigErr(e?.message ?? String(e));
    }
  }

  /* -------- render ------------------------------------------------------ */

  const v = result?.validation;

  return (
    <div className="card__body">
      {result && (
        <div className="canvas-meta" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <span>
            kind <b>{result.kind}</b>
          </span>
          <span>
            chunks <b>{result.chunks.toLocaleString()}</b>
            {result.expected_chunks != null && (
              <span className="muted"> / {result.expected_chunks.toLocaleString()}</span>
            )}
          </span>
          <span>
            bytes <b>{result.bytes.toLocaleString()}</b>
          </span>
          {result.pixels_per_chunk != null && (
            <span>
              pixels/chunk <b>{result.pixels_per_chunk.toLocaleString()}</b>
            </span>
          )}
          {result.send_time_s != null && (
            <span>
              send <b>{fmtSec(result.send_time_s)}</b>
            </span>
          )}
          {result.process_time_s != null && (
            <span>
              process <b>{fmtSec(result.process_time_s)}</b>
            </span>
          )}
        </div>
      )}

      {!result && haveStreamData && (
        <div className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Live stream completed. Validation report is only generated by
          <b> Run validated</b> — but the data is still downloadable.
        </div>
      )}

      <div className="button-row" style={{ marginTop: 12 }}>
        <button
          className="btn"
          disabled={!haveAnyData || csvState === "fetching"}
          onClick={downloadCsv}
          title="Download the most recent scan's data as CSV"
        >
          {csvState === "fetching" ? "Fetching CSV…" : "📥 Download CSV"}
        </button>
        <button
          className="btn"
          disabled={!haveAnyData || figState === "fetching"}
          onClick={downloadFigure}
          title="Render the most recent scan as a matplotlib PNG and download"
        >
          {figState === "fetching" ? "Rendering…" : "📥 Download figure (PNG)"}
        </button>
      </div>

      {csvErr && (
        <div style={{ color: "var(--c-danger)", fontSize: 12, marginTop: 6 }}>
          CSV: {csvErr}
        </div>
      )}
      {figErr && (
        <div style={{ color: "var(--c-danger)", fontSize: 12, marginTop: 6 }}>
          Figure: {figErr}
        </div>
      )}

      {v && (
        <>
          <div className="divider" />
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="card__title">Validation</span>
            <span className="spacer" />
            <span
              className="status-pill"
              data-state={v.passed ? "idle" : "error"}
            >
              {v.passed ? "All checks passed" : "Failures"}
            </span>
          </div>
          <ul className="validation-list">
            {v.checks.map((c) => (
              <li key={c.name}>
                <span className={c.passed ? "pass" : "fail"}>
                  {c.passed ? "PASS" : "FAIL"}
                </span>
                <span>{c.name}</span>
                <span className="muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function fmtSec(s: number): string {
  if (s < 1e-3) return `${(s * 1e6).toFixed(0)} µs`;
  if (s < 1) return `${(s * 1e3).toFixed(1)} ms`;
  return `${s.toFixed(3)} s`;
}

/** Local-time timestamp suffix for downloaded files. Matches the format
 *  the Python service uses (time.strftime "%Y%m%d_%H%M%S") so naming is
 *  consistent across the two paths. Note the Python timestamp uses the
 *  server's local time; ours uses the browser's. They diverge only when
 *  the two run in different timezones, which is rare and not worth
 *  fancy reconciliation logic. */
function timestampSuffix(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function defaultCsvFilename(
  kind: "raster" | "vector",
  result: { resolution?: number | null } | null
): string {
  const ts = timestampSuffix();
  if (kind === "raster") {
    const r = result?.resolution ?? 0;
    return r ? `raster_${r}x${r}_${ts}.csv` : `raster_${ts}.csv`;
  }
  return `vector_${ts}.csv`;
}

function defaultFigureFilename(
  kind: "raster" | "vector",
  result: { resolution?: number | null } | null
): string {
  const ts = timestampSuffix();
  if (kind === "raster") {
    const r = result?.resolution ?? 0;
    return r ? `raster_${r}x${r}_${ts}.png` : `raster_${ts}.png`;
  }
  return `vector_${ts}.png`;
}

/** Pull the filename out of a Content-Disposition header. Tolerates the
 *  basic form `attachment; filename="x.csv"`; doesn't try to handle
 *  RFC 5987's filename* parameter (server doesn't emit it). */
function filenameFromContentDisposition(h: string | null): string | null {
  if (!h) return null;
  const match = h.match(/filename="([^"]+)"/i);
  return match ? match[1] : null;
}
