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
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useAppSelector } from "../store";
import {
  rasterCsvBlob,
  vectorCsvBlob,
  downloadBlob,
} from "../lib/csvExport";
import { scanAuthHeaders } from "../lib/authIdentity";
import { useTranslation } from "../i18n";
import { Icon } from "./Icon";

type DownloadState = "idle" | "fetching" | "error";
type DbFlowState = "checking" | "ready" | "disabled" | "saving" | "saved" | "error";
type DirectoryPickerOptions = { startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos" };
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

const OUTPUT_PREFIX_STORAGE_KEY = "ionbeam:downloadOutputPrefix";
const DEFAULT_DOWNLOAD_PATH_LABEL = defaultDownloadPathLabel();

export function ValidationPanel({ disabled = false }: { disabled?: boolean }) {
  const { t, fmt } = useTranslation();
  const result = useAppSelector((s) => s.scan.lastResult);
  const error = useAppSelector((s) => s.scan.errorMessage);
  const phase = useAppSelector((s) => s.scan.phase);
  const kind = useAppSelector((s) => s.scan.kind);
  const scanKind = kind === "vector" ? "vector" : "raster";

  const rasterFrame = useAppSelector((s) => s.image.frame);
  const rasterRes = useAppSelector((s) => s.image.resolution);
  const rasterCursor = useAppSelector((s) => s.image.cursor);
  const vectorImage = useAppSelector((s) => s.image.vectorImage);
  const vectorEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const vectorLatency = useAppSelector((s) => s.scan.vector.latency_bytes);
  const vectorRenderMode = useAppSelector((s) => s.scan.vectorRenderMode);

  const [csvState, setCsvState] = useState<DownloadState>("idle");
  const [figState, setFigState] = useState<DownloadState>("idle");
  const [csvErr, setCsvErr] = useState<string | null>(null);
  const [figErr, setFigErr] = useState<string | null>(null);
  const [autoDownload, setAutoDownload] = useState(false);
  const [dbFlowState, setDbFlowState] = useState<DbFlowState>("checking");
  const [dbFlowErr, setDbFlowErr] = useState<string | null>(null);
  const [downloadDir, setDownloadDir] = useState<DirectoryHandle | null>(null);
  // downloadDirLabel is set lazily after the first translation read so
  // we don't end up showing the English placeholder briefly during the
  // initial mount in a Chinese-locale session.
  const [downloadDirLabel, setDownloadDirLabel] = useState(DEFAULT_DOWNLOAD_PATH_LABEL);
  const [outputPrefix, setOutputPrefix] = useState(
    () => window.localStorage.getItem(OUTPUT_PREFIX_STORAGE_KEY) ?? ""
  );
  const [autoErr, setAutoErr] = useState<string | null>(null);
  const lastAutoDownloadKeyRef = useRef<string | null>(null);
  const lastDbFlowKeyRef = useRef<string | null>(null);

  const haveStreamData =
    (kind === "raster" && rasterCursor > 0) ||
    (kind === "vector" && vectorCursor > 0);
  const haveValidatedData = result?.has_data === true;
  const haveAnyData =
    haveValidatedData ||
    (haveStreamData && (phase === "completed" || phase === "paused"));
  const dbFlowReadyPhase = phase === "completed" || phase === "paused";

  async function selectDownloadFolder() {
    if (disabled) return;
    setAutoErr(null);
    const picker = (window as any).showDirectoryPicker as
      | ((options?: DirectoryPickerOptions) => Promise<DirectoryHandle>)
      | undefined;
    if (!picker) {
      setAutoErr(t("validation.folder.unavailable"));
      setDownloadDir(null);
      setDownloadDirLabel(DEFAULT_DOWNLOAD_PATH_LABEL);
      return;
    }

    try {
      const dir = await picker({ startIn: "downloads" });
      setDownloadDir(dir);
      setDownloadDirLabel(dir.name || t("validation.folder.default"));
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setAutoErr(e?.message ?? String(e));
      }
    }
  }

  function updateOutputPrefix(next: string) {
    setOutputPrefix(next);
    window.localStorage.setItem(OUTPUT_PREFIX_STORAGE_KEY, next);
  }

  useEffect(() => {
    let cancelled = false;
    async function checkDb() {
      setDbFlowState("checking");
      setDbFlowErr(null);
      try {
        const r = await fetch("/api/admin/iobeam/db/status");
        const data = (await r.json()) as { ok?: boolean; enabled?: boolean; error?: string };
        if (cancelled) return;
        if (r.ok && data.enabled) {
          setDbFlowState("ready");
        } else {
          setDbFlowState("disabled");
          setDbFlowErr(data.error ?? `HTTP ${r.status}`);
        }
      } catch (e: any) {
        if (!cancelled) {
          setDbFlowState("disabled");
          setDbFlowErr(e?.message ?? String(e));
        }
      }
    }
    void checkDb();
    return () => {
      cancelled = true;
    };
  }, []);

  const downloadSettings = (
    <>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="validation-output-prefix">
          {t("validation.outputPrefix")}
        </label>
        <input
          id="validation-output-prefix"
          className="input"
          value={outputPrefix}
          disabled={disabled}
          onChange={(e) => updateOutputPrefix(e.target.value)}
          placeholder={t("validation.outputPrefix.placeholder")}
        />
        <span className="muted" style={{ fontSize: 11 }}>
          {t("validation.outputPrefix.help")}
        </span>
      </div>
      <div className="button-row" style={{ marginTop: 8, alignItems: "center" }}>
        <button className="btn btn--ghost" disabled={disabled} onClick={selectDownloadFolder}>
          <Icon name="download" tone="accent" />
          {t("validation.selectFolder")}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {downloadDirLabel}
        </span>
        <label className="checkbox" style={{ padding: 0 }}>
          <input
            type="checkbox"
            checked={autoDownload}
            disabled={disabled}
            onChange={(e) => {
              setAutoDownload(e.target.checked);
              setAutoErr(null);
            }}
          />
          {t("validation.autoDownload")}
        </label>
      </div>
      {autoErr && (
        <div style={{ color: "var(--c-warn)", fontSize: 12, marginTop: 6 }}>
          {t("validation.autoDownload.error", { detail: autoErr })}
        </div>
      )}
      {dbFlowState === "disabled" && dbFlowErr && (
        <div style={{ color: "var(--c-warn)", fontSize: 12, marginTop: 6 }}>
          {t("validation.flowToDb.disabled", { detail: dbFlowErr })}
        </div>
      )}
      {dbFlowState === "saved" && (
        <div style={{ color: "var(--c-accent)", fontSize: 12, marginTop: 6 }}>
          {t("validation.flowToDb.saved")}
        </div>
      )}
      {dbFlowState === "error" && dbFlowErr && (
        <div style={{ color: "var(--c-danger)", fontSize: 12, marginTop: 6 }}>
          {t("validation.flowToDb.error", { detail: dbFlowErr })}
        </div>
      )}
    </>
  );

  /* -------- download handlers ------------------------------------------ */

  async function csvDownloadBlob(): Promise<{ blob: Blob; filename: string }> {
    if (haveValidatedData) {
      const r = await fetch("/api/scan/last/csv");
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const blob = await r.blob();
      return {
        blob,
        filename: defaultDownloadFilename(scanKind, "csv", {
          resolution: result?.resolution ?? rasterRes,
          latency_bytes: vectorLatency,
        }, outputPrefix),
      };
    }

    const blob = kind === "raster"
      ? rasterCsvBlob(rasterFrame, rasterRes)
      : vectorCsvBlob(vectorImage, vectorEdge);
    return {
      blob,
      filename: defaultDownloadFilename(scanKind, "csv", {
        resolution: rasterRes,
        latency_bytes: vectorLatency,
      }, outputPrefix),
    };
  }

  async function figureDownloadBlob(): Promise<{ blob: Blob; filename: string }> {
    const url =
      kind === "vector"
        ? `/api/scan/last/figure?render=${encodeURIComponent(vectorRenderMode)}`
        : "/api/scan/last/figure";
    const r = await fetch(url);
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${detail || "figure render failed"}`);
    }
    const blob = await r.blob();
    return {
      blob,
      filename: defaultDownloadFilename(scanKind, "png", {
        resolution: result?.resolution ?? rasterRes,
        latency_bytes: vectorLatency,
      }, outputPrefix),
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

  async function saveResultToDb() {
    if (disabled) return;
    const signedUser = readSignedInUser();
    const r = await fetch("/api/admin/iobeam/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
      body: JSON.stringify({
        ...(signedUser?.id ? { user_id: signedUser.id } : {}),
        activity_type: scanKind === "raster" ? "RASTER run" : "VECTOR run",
      }),
    });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    }
  }

  async function downloadCsv() {
    if (disabled) return;
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
    if (disabled) return;
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
    if (disabled || !autoDownload || phase !== "completed" || !haveAnyData) return;

    const key = [
      scanKind,
      result?.chunks ?? "stream",
      result?.bytes ?? "stream",
      rasterCursor,
      vectorCursor,
      vectorRenderMode,
      outputPrefix,
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
  }, [disabled, autoDownload, phase, haveAnyData, scanKind, result?.chunks, result?.bytes, rasterCursor, vectorCursor, vectorRenderMode, outputPrefix]);

  useEffect(() => {
    if (disabled || dbFlowState === "checking" || dbFlowState === "disabled" || !dbFlowReadyPhase || !haveAnyData) return;

    const key = [
      "db",
      scanKind,
      result?.chunks ?? "stream",
      result?.bytes ?? "stream",
      rasterCursor,
      vectorCursor,
      vectorRenderMode,
    ].join(":");
    if (lastDbFlowKeyRef.current === key) return;
    lastDbFlowKeyRef.current = key;

    let cancelled = false;
    async function runDbFlow() {
      setDbFlowState("saving");
      setDbFlowErr(null);
      try {
        await saveResultToDb();
        if (!cancelled) setDbFlowState("saved");
      } catch (e: any) {
        if (!cancelled) {
          setDbFlowState("error");
          setDbFlowErr(e?.message ?? String(e));
        }
      }
    }
    void runDbFlow();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, dbFlowState, dbFlowReadyPhase, haveAnyData, scanKind, result?.chunks, result?.bytes, rasterCursor, vectorCursor, vectorRenderMode]);

  /* -------- render ------------------------------------------------------ */

  if (error) {
    return (
      <div className="card__body">
        {downloadSettings}
        <div style={{ color: "var(--c-danger)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!result && !haveAnyData) {
    // Empty-state message contains <Run> and <Run validated> labels
    // that should look like the actual buttons. Same bracketed-bold
    // convention used in RasterParameters.
    return (
      <div className="card__body">
        <div className="muted" style={{ fontSize: 12 }}>
          {renderBracketedBold(t("validation.empty"))}
        </div>
        {downloadSettings}
      </div>
    );
  }

  const v = result?.validation;
  // result.kind is "raster" or "vector" — a fixed enum on the wire.
  // We surface it as the localised name from the i18n table.
  const resultKindKey = result?.kind === "vector" ? "tabs.vector" : "tabs.raster";

  return (
    <div className="card__body">
      {result && (
        <div className="canvas-meta" style={{ marginTop: 0, flexWrap: "wrap" }}>
          <span>
            {t("validation.meta.kind")} <b>{t(resultKindKey)}</b>
          </span>
          <span>
            {t("validation.meta.chunks")} <b>{fmt(result.chunks)}</b>
            {result.expected_chunks != null && (
              <span className="muted"> / {fmt(result.expected_chunks)}</span>
            )}
          </span>
          <span>
            {t("validation.meta.bytes")} <b>{fmt(result.bytes)}</b>
          </span>
          {result.pixels_per_chunk != null && (
            <span>
              {t("validation.meta.pixelsPerChunk")} <b>{fmt(result.pixels_per_chunk)}</b>
            </span>
          )}
          {result.send_time_s != null && (
            <span>
              {t("validation.meta.send")} <b>{fmtSec(result.send_time_s)}</b>
            </span>
          )}
          {result.process_time_s != null && (
            <span>
              {t("validation.meta.process")} <b>{fmtSec(result.process_time_s)}</b>
            </span>
          )}
        </div>
      )}

      {!result && haveStreamData && (
        <div className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          {renderBracketedBold(t("validation.streamCompleted"))}
        </div>
      )}

      {downloadSettings}

      {!autoDownload && (
        <div className="button-row" style={{ marginTop: 12 }}>
          <button
            className="btn"
            disabled={disabled || !haveAnyData || csvState === "fetching"}
            onClick={downloadCsv}
            title={t("validation.downloadCsv.title")}
          >
            <Icon name="download" tone="success" />
            {csvState === "fetching"
              ? t("validation.downloadCsv.fetching")
              : t("validation.downloadCsv")}
          </button>
          <button
            className="btn"
            disabled={disabled || !haveAnyData || figState === "fetching"}
            onClick={downloadFigure}
            title={t("validation.downloadFigure.title")}
          >
            <Icon name="image" tone="success" />
            {figState === "fetching"
              ? t("validation.downloadFigure.rendering")
              : t("validation.downloadFigure")}
          </button>
        </div>
      )}

      {csvErr && (
        <div style={{ color: "var(--c-danger)", fontSize: 12, marginTop: 6 }}>
          {t("validation.csvError", { detail: csvErr })}
        </div>
      )}
      {figErr && (
        <div style={{ color: "var(--c-danger)", fontSize: 12, marginTop: 6 }}>
          {t("validation.figureError", { detail: figErr })}
        </div>
      )}

      {v && (
        <>
          <div className="divider" />
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="card__title">{t("validation.title")}</span>
            <span className="spacer" />
            <span
              className="status-pill"
              data-state={v.passed ? "idle" : "error"}
            >
              {v.passed ? t("validation.allPassed") : t("validation.failures")}
            </span>
          </div>
          <ul className="validation-list">
            {v.checks.map((c) => (
              <li key={c.name}>
                <span className={c.passed ? "pass" : "fail"}>
                  {c.passed ? t("validation.check.pass") : t("validation.check.fail")}
                </span>
                {/* Check names and details come from the backend in
                    English. They're technical strings (e.g. "chunks
                    correct", "first chunk has the expected cookie")
                    that map to specific code paths in the Python
                    service — translating them would create a key-by-
                    string-prefix lookup that would silently break the
                    next time a check is added on the backend. We
                    surface them verbatim and rely on the PASS/FAIL
                    pill to communicate state in the operator's
                    language. The integration guide notes this. */}
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

function shortTimestampSuffix(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${String(d.getFullYear()).slice(-2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function defaultDownloadPathLabel(): string {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  return platform.includes("win") || userAgent.includes("windows")
    ? "C:\\Scan\\output"
    : "~/Downloads/Scan/Output";
}

function filenameInsertedSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

function defaultDownloadFilename(
  kind: "raster" | "vector",
  fileType: "csv" | "png",
  result: { resolution?: number | null; latency_bytes?: number | null } | null,
  insertedPrefix: string
): string {
  const ts = shortTimestampSuffix();
  const suffix = filenameInsertedSegment(insertedPrefix);
  const inserted = suffix ? `_${suffix}` : "";
  if (kind === "raster") {
    const r = result?.resolution ?? 0;
    return `raster_${r}x${r}${inserted}_${ts}.${fileType}`;
  }
  return `vector_latency_${result?.latency_bytes ?? 0}${inserted}_${ts}.${fileType}`;
}

function readSignedInUser(): { id?: number | null } | null {
  const raw = window.localStorage.getItem("ionbeam:adminUser");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { id?: number | null };
  } catch {
    return null;
  }
}

/** Bracketed-bold for inline button-name references. Mirrors the
 *  helper in RasterParameters — kept duplicated rather than imported
 *  to keep components independently relocatable. */
function renderBracketedBold(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<([^<>]+)>/g;
  let last = 0;
  let i = 0;
  for (const m of s.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push(s.slice(last, start));
    out.push(<b key={i++}>{m[1]}</b>);
    last = start + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
