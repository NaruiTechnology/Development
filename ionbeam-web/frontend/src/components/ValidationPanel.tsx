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
import { useEffect, useRef, useState } from "react";

import { useAppSelector } from "../store";
import {
  rasterCsvBlob,
  vectorCsvBlob,
  downloadBlob,
} from "../lib/csvExport";
import { Icon } from "./Icon";

type DownloadState = "idle" | "fetching" | "error";
type DirectoryHandle = {
  name: string;
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

export function ValidationPanel() {
  const result = useAppSelector((s) => s.scan.lastResult);
  const error = useAppSelector((s) => s.scan.errorMessage);
  const phase = useAppSelector((s) => s.scan.phase);
  const kind = useAppSelector((s) => s.scan.kind);
  const scanKind = kind === "vector" ? "vector" : "raster";

  // Live-stream pixel state. Used as the source for client-side CSV
  // export when the user ran the stream (not validated).
  const rasterFrame = useAppSelector((s) => s.image.frame);
  const rasterRes = useAppSelector((s) => s.image.resolution);
  const rasterCursor = useAppSelector((s) => s.image.cursor);
  const vectorImage = useAppSelector((s) => s.image.vectorImage);
  const vectorEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const vectorLatency = useAppSelector((s) => s.scan.vector.latency_bytes);
  // For vector scans the operator picks a render mode in the canvas
  // toolbar. The figure download honours that choice so the PNG matches
  // what they're currently looking at.
  const vectorRenderMode = useAppSelector((s) => s.scan.vectorRenderMode);

  const [csvState, setCsvState] = useState<DownloadState>("idle");
  const [figState, setFigState] = useState<DownloadState>("idle");
  const [csvErr, setCsvErr] = useState<string | null>(null);
  const [figErr, setFigErr] = useState<string | null>(null);
  const [autoDownload, setAutoDownload] = useState(false);
  const [downloadDir, setDownloadDir] = useState<DirectoryHandle | null>(null);
  const [downloadDirLabel, setDownloadDirLabel] = useState("~/Downloads");
  const [autoErr, setAutoErr] = useState<string | null>(null);
  const lastAutoDownloadKeyRef = useRef<string | null>(null);

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

  async function selectDownloadFolder() {
    setAutoErr(null);
    const picker = (window as any).showDirectoryPicker as
      | (() => Promise<DirectoryHandle>)
      | undefined;
    if (!picker) {
      setAutoErr("Folder selection is unavailable in this browser; using the browser Downloads folder.");
      setDownloadDir(null);
      setDownloadDirLabel("~/Downloads");
      return;
    }

    try {
      const dir = await picker();
      setDownloadDir(dir);
      setDownloadDirLabel(dir.name || "~/Downloads");
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setAutoErr(e?.message ?? String(e));
      }
    }
  }

  const autoDownloadControls = (
    <>
      <div className="button-row" style={{ marginTop: 12, alignItems: "center" }}>
        <label className="checkbox" style={{ padding: 0 }}>
          <input
            type="checkbox"
            checked={autoDownload}
            onChange={(e) => {
              setAutoDownload(e.target.checked);
              setAutoErr(null);
            }}
          />
          Auto download
        </label>
        {autoDownload && (
          <>
            <button className="btn btn--ghost" onClick={selectDownloadFolder}>
              <Icon name="download" tone="accent" />
              Select folder
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              {downloadDirLabel}
            </span>
          </>
        )}
      </div>
      {autoErr && (
        <div style={{ color: "var(--c-warn)", fontSize: 12, marginTop: 6 }}>
          Auto download: {autoErr}
        </div>
      )}
    </>
  );

  /* -------- download handlers ------------------------------------------ */

  async function csvDownloadBlob(): Promise<{ blob: Blob; filename: string }> {
    if (haveValidatedData) {
      // Server has the validated bytes — use them as the source of
      // truth so the CSV matches the validation report exactly.
      const r = await fetch("/api/scan/last/csv");
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const blob = await r.blob();
      return {
        blob,
        filename: defaultDownloadFilename(scanKind, "csv", {
          resolution: result?.resolution ?? rasterRes,
          latency_bytes: vectorLatency,
        }),
      };
    }

    // Live stream: generate from the imageSlice buffer.
    const blob = kind === "raster"
      ? rasterCsvBlob(rasterFrame, rasterRes)
      : vectorCsvBlob(vectorImage, vectorEdge);
    return {
      blob,
      filename: defaultDownloadFilename(scanKind, "csv", {
        resolution: rasterRes,
        latency_bytes: vectorLatency,
      }),
    };
  }

  async function figureDownloadBlob(): Promise<{ blob: Blob; filename: string }> {
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
    return {
      blob,
      filename: defaultDownloadFilename(scanKind, "png", {
        resolution: result?.resolution ?? rasterRes,
        latency_bytes: vectorLatency,
      }),
    };
  }

  async function saveDownload(blob: Blob, filename: string) {
    if (!downloadDir) {
      downloadBlob(blob, filename);
      return;
    }
    const fileHandle = await downloadDir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async function downloadCsv() {
    setCsvState("fetching");
    setCsvErr(null);
    try {
      const { blob, filename } = await csvDownloadBlob();
      await saveDownload(blob, filename);
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
      const { blob, filename } = await figureDownloadBlob();
      await saveDownload(blob, filename);
      setFigState("idle");
    } catch (e: any) {
      setFigState("error");
      setFigErr(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    if (!autoDownload || phase !== "completed" || !haveAnyData) return;

    const key = [
      scanKind,
      result?.chunks ?? "stream",
      result?.bytes ?? "stream",
      rasterCursor,
      vectorCursor,
      vectorRenderMode,
    ].join(":");
    if (lastAutoDownloadKeyRef.current === key) return;
    lastAutoDownloadKeyRef.current = key;

    let cancelled = false;
    async function runAutoDownload() {
      setCsvState("fetching");
      setFigState("fetching");
      setCsvErr(null);
      setFigErr(null);
      setAutoErr(null);
      try {
        const csv = await csvDownloadBlob();
        if (cancelled) return;
        await saveDownload(csv.blob, csv.filename);

        const figure = await figureDownloadBlob();
        if (cancelled) return;
        await saveDownload(figure.blob, figure.filename);

        setCsvState("idle");
        setFigState("idle");
      } catch (e: any) {
        if (!cancelled) {
          const msg = e?.message ?? String(e);
          setCsvState("error");
          setFigState("error");
          setAutoErr(msg);
        }
      }
    }

    runAutoDownload();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDownload, phase, haveAnyData, scanKind, result?.chunks, result?.bytes, rasterCursor, vectorCursor, vectorRenderMode]);

  /* -------- render ------------------------------------------------------ */

  if (error) {
    return (
      <div className="card__body">
        {autoDownloadControls}
        <div style={{ color: "var(--c-danger)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!result && !haveAnyData) {
    return (
      <div className="card__body">
        <div className="muted" style={{ fontSize: 12 }}>
          No completed scan yet. Press <b>Run</b> for a live stream, or
          <b> Run validated</b> for timing + checks. After either, you'll
          be able to download CSV and PNG figure here.
        </div>
        {autoDownloadControls}
      </div>
    );
  }

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

      {autoDownloadControls}

      {!autoDownload && (
        <div className="button-row" style={{ marginTop: 12 }}>
          <button
            className="btn"
            disabled={!haveAnyData || csvState === "fetching"}
            onClick={downloadCsv}
            title="Download the most recent scan's data as CSV"
          >
            <Icon name="download" tone="success" />
            {csvState === "fetching" ? "Fetching CSV..." : "Download CSV"}
          </button>
          <button
            className="btn"
            disabled={!haveAnyData || figState === "fetching"}
            onClick={downloadFigure}
            title="Render the most recent scan as a matplotlib PNG and download"
          >
            <Icon name="image" tone="success" />
            {figState === "fetching" ? "Rendering..." : "Download figure (PNG)"}
          </button>
        </div>
      )}

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

/** Short local-time timestamp suffix for downloaded files. Matches the
 *  Python service's "%y%m%d_%H%M%S" format. */
function shortTimestampSuffix(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function defaultDownloadFilename(
  kind: "raster" | "vector",
  fileType: "csv" | "png",
  result: { resolution?: number | null; latency_bytes?: number | null } | null
): string {
  const ts = shortTimestampSuffix();
  if (kind === "raster") {
    const r = result?.resolution ?? 0;
    return `raster_${r}x${r}_${ts}.${fileType}`;
  }
  return `vector_latency_${result?.latency_bytes ?? 0}_${ts}.${fileType}`;
}
