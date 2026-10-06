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
 *   - Figure (PNG), first available of:
 *          1. the merged figure (edits + chip already burned in);
 *          2. the live canvas image — the same pixels the canvas shows and
 *             the merged FTP upload is built from (gray filter, levels,
 *             decimation) — with the glass scan-parameter chip burned in;
 *          3. fallback /api/scan/last/figure (matplotlib, server-side) with
 *             the scan-parameter summary appended as a caption band.
 *
 * Auto download saves the PNG first, then the CSV. When edits are merged
 * afterwards, the auto-downloaded PNG is replaced with the merged figure
 * under the same filename (overwritten in place when a folder is selected).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useAppSelector } from "../store";
import {
  rasterCsvBlob,
  vectorCsvBlob,
  downloadBlob,
} from "../lib/csvExport";
import { useTranslation, type TranslationKey } from "../i18n";
import { appendScanParamCaption, burnScanParamChip } from "../lib/scanParamChip";
import { apiUrl } from "../lib/backendUrl";
import { readJsonResponse } from "../lib/readJsonResponse";
import {
  chooseExportFolder,
  ensureFolderWritable,
  loadExportFolder,
  writeFileToFolder,
  type ExportFolderHandle,
} from "../lib/exportFolder";
import { Icon } from "./Icon";

type DownloadState = "idle" | "fetching" | "error";
type DbFlowState = "checking" | "ready" | "disabled" | "saving" | "saved" | "error";
const OUTPUT_PREFIX_STORAGE_KEY = "ionbeam:downloadOutputPrefix";
const SCAN_EXPORT_FOLDER = "scan-figures";
const DEFAULT_DOWNLOAD_PATH_LABEL = defaultDownloadPathLabel();

export function ValidationPanel({
  disabled = false,
  previewMode = false,
  mergedFigureUrl = null,
  liveFigureUrl = null,
  kindOverride = null,
  validationSummaryHost = null,
}: {
  disabled?: boolean;
  previewMode?: boolean;
  mergedFigureUrl?: string | null;
  /** PNG data URL of the live canvas for the last completed scan. */
  liveFigureUrl?: string | null;
  kindOverride?: "raster" | "vector" | null;
  validationSummaryHost?: HTMLElement | null;
}) {
  const { t, fmt } = useTranslation();
  const result = useAppSelector((s) => s.scan.lastResult);
  const error = useAppSelector((s) => s.scan.errorMessage);
  const phase = useAppSelector((s) => s.scan.phase);
  const kind = useAppSelector((s) => s.scan.kind);
  const scanKind = kindOverride ?? (kind === "vector" ? "vector" : "raster");

  const rasterFrame = useAppSelector((s) => s.image.frame);
  const rasterRes = useAppSelector((s) => s.image.resolution);
  const rasterCursor = useAppSelector((s) => s.image.cursor);
  const vectorImage = useAppSelector((s) => s.image.vectorImage);
  const vectorEdge = useAppSelector((s) => s.image.vectorEdge);
  const vectorCursor = useAppSelector((s) => s.image.vectorCursor);
  const vectorLatency = useAppSelector((s) => s.scan.vector.latency_bytes);
  const vectorRenderMode = useAppSelector((s) => s.scan.vectorRenderMode);
  const lastScanParams = useAppSelector((s) => s.scan.lastScanParams);

  const [csvState, setCsvState] = useState<DownloadState>("idle");
  const [figState, setFigState] = useState<DownloadState>("idle");
  const [csvErr, setCsvErr] = useState<string | null>(null);
  const [figErr, setFigErr] = useState<string | null>(null);
  const [autoDownload, setAutoDownload] = useState(false);
  const [dbFlowState, setDbFlowState] = useState<DbFlowState>("checking");
  const [dbFlowErr, setDbFlowErr] = useState<string | null>(null);
  const [downloadDir, setDownloadDir] = useState<ExportFolderHandle | null>(null);
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
  // Async download work must outlive re-renders: a dependency change while
  // the (slow) figure render is in flight used to cancel the run after the
  // first file, silently dropping the PNG. Only unmount stops state updates.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const mergedFigureUrlRef = useRef(mergedFigureUrl);
  mergedFigureUrlRef.current = mergedFigureUrl;
  const liveFigureUrlRef = useRef(liveFigureUrl);
  liveFigureUrlRef.current = liveFigureUrl;
  // Live image left over from the previous scan: never export it for the
  // scan that is running/just finished (the new one is captured a frame
  // after completion).
  const staleLiveFigureRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase === "running" || phase === "stopping") {
      staleLiveFigureRef.current = liveFigureUrlRef.current;
    }
  }, [phase]);
  // The canvas clears its image when a new scan starts; once that happens
  // the next image is fresh even if its pixels match the previous scan.
  useEffect(() => {
    if (!liveFigureUrl) staleLiveFigureRef.current = null;
  }, [liveFigureUrl]);
  // PNG written by the last auto download, so a later merge can replace it.
  const lastAutoFigureRef = useRef<{ kind: "raster" | "vector"; filename: string } | null>(null);
  const lastReplacedMergedRef = useRef<string | null>(null);
  const [mergedReplaced, setMergedReplaced] = useState<string | null>(null);
  const downloadControlsDisabled = disabled || previewMode;

  useEffect(() => {
    if (previewMode) setAutoDownload(false);
  }, [previewMode]);

  useEffect(() => {
    let cancelled = false;
    void loadExportFolder(SCAN_EXPORT_FOLDER).then((handle) => {
      if (cancelled || !handle) return;
      setDownloadDir(handle);
      setDownloadDirLabel(handle.name || DEFAULT_DOWNLOAD_PATH_LABEL);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const haveStreamData =
    (kind === "raster" && rasterCursor > 0) ||
    (kind === "vector" && vectorCursor > 0);
  const haveValidatedData = result?.has_data === true;
  const haveAnyData =
    haveValidatedData ||
    (haveStreamData && phase === "completed");
  const dbFlowReadyPhase = phase === "completed";

  async function selectDownloadFolder() {
    if (downloadControlsDisabled) return;
    setAutoErr(null);
    try {
      const dir = await chooseExportFolder(SCAN_EXPORT_FOLDER, downloadDir);
      if (!dir) return;
      if (!(await ensureFolderWritable(dir))) {
        setAutoErr(t("validation.folder.unavailable"));
        return;
      }
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
        const r = await fetch(apiUrl("/api/admin/iobeam/db/status"));
        const data = await readJsonResponse<{ ok?: boolean; enabled?: boolean; error?: string }>(
          r,
          "db status"
        );
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
      <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 8 }}>
        {downloadDirLabel}
      </span>
      <div className="validation-download-controls" style={{ marginTop: 8 }}>
        <button className="btn btn--ghost" disabled={downloadControlsDisabled} onClick={selectDownloadFolder}>
          <Icon name="download" tone="accent" />
          {t("validation.selectFolder")}
        </button>
        <label className="checkbox vacuum-switch app-switch" style={{ padding: 0, marginRight: 5 }}>
          <input
            type="checkbox"
            checked={autoDownload}
            disabled={downloadControlsDisabled}
            onChange={(e) => {
              setAutoDownload(e.target.checked);
              setAutoErr(null);
            }}
          />
          <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
          <span style={{ paddingRight: 5 }}>{t("validation.autoDownload")}</span>
        </label>
      </div>
      {mergedReplaced && !autoErr && (
        <div style={{ color: "var(--c-accent)", fontSize: 12, marginTop: 6 }}>
          {t("validation.autoDownload.mergedReplaced", { filename: mergedReplaced })}
        </div>
      )}
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
      const r = await fetch(apiUrl("/api/scan/last/csv"));
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

  async function figureDownloadBlob(): Promise<{ blob: Blob; filename: string; mergedSource: string | null }> {
    const mergedUrl = mergedFigureUrlRef.current;
    if (mergedUrl) {
      const merged = await fetch(mergedUrl);
      if (!merged.ok) {
        throw new Error(`HTTP ${merged.status}: merged figure export failed`);
      }
      return {
        blob: await merged.blob(),
        filename: defaultDownloadFilename(scanKind, "png", {
          resolution: result?.resolution ?? rasterRes,
          latency_bytes: vectorLatency,
        }, outputPrefix),
        mergedSource: mergedUrl,
      };
    }

    const paramItems = lastScanParams?.kind === scanKind ? lastScanParams.items : null;
    const translate = (key: string) => t(key as TranslationKey);
    const filename = defaultDownloadFilename(scanKind, "png", {
      resolution: result?.resolution ?? rasterRes,
      latency_bytes: vectorLatency,
    }, outputPrefix);

    const liveUrl = await waitForLiveFigure();
    if (liveUrl) {
      const live = await fetch(liveUrl);
      if (live.ok) {
        let blob = await live.blob();
        if (paramItems?.length) {
          try {
            blob = await burnScanParamChip(blob, paramItems, translate);
          } catch {
            // Keep the plain canvas image rather than failing the download.
          }
        }
        return { blob, filename, mergedSource: null };
      }
    }

    const url =
      kind === "vector"
        ? `/api/scan/last/figure?render=${encodeURIComponent(vectorRenderMode)}`
        : "/api/scan/last/figure";
    const r = await fetch(apiUrl(url));
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${detail || "figure render failed"}`);
    }
    let blob = await r.blob();
    // Fallback only (no live canvas image): the server figure has no scan
    // settings on it, so add them as a caption band.
    if (paramItems?.length) {
      try {
        blob = await appendScanParamCaption(blob, paramItems, translate);
      } catch {
        // Keep the plain figure rather than failing the download.
      }
    }
    return { blob, filename, mergedSource: null };
  }

  /**
   * The canvas snapshot is taken one animation frame after the scan
   * completes, so auto download can start before it exists. Wait briefly
   * for it instead of falling back to the differently rendered server PNG.
   */
  async function waitForLiveFigure(timeoutMs = 4000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const url = liveFigureUrlRef.current;
      if (url && url !== staleLiveFigureRef.current) return url;
      if (Date.now() >= deadline || !mountedRef.current) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Overwrite the auto-downloaded PNG with the merged figure. */
  async function replaceAutoFigureWithMerged(mergedUrl: string, filename: string) {
    lastReplacedMergedRef.current = mergedUrl;
    const merged = await fetch(mergedUrl);
    if (!merged.ok) throw new Error(`HTTP ${merged.status}: merged figure export failed`);
    await saveDownload(await merged.blob(), filename);
    if (mountedRef.current) setMergedReplaced(filename);
  }

  async function saveDownload(blob: Blob, filename: string) {
    if (!downloadDir) {
      downloadBlob(blob, filename);
      return;
    }
    await writeFileToFolder(downloadDir, filename, blob);
  }

  async function saveResultToDb() {
    if (disabled) return;
    // Activity rows are already written by the scan completion paths
    // (`useScanStream` for live scans and the validated run thunk for
    // POST /scan/{kind}/run). This hook now only gates the UI state for
    // the DB flow indicator so we don't double-count a single scan.
    return;
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
    if (disabled || previewMode || !autoDownload || phase !== "completed" || !haveAnyData) return;

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

    lastAutoFigureRef.current = null;
    lastReplacedMergedRef.current = null;
    setMergedReplaced(null);

    async function runAutoDownload() {
      setCsvState("fetching");
      setFigState("fetching");
      setCsvErr(null);
      setFigErr(null);
      setAutoErr(null);
      const errors: string[] = [];

      // PNG first: it is the primary result, and browsers that throttle
      // repeated programmatic downloads still let the first one through.
      // Each file is tried independently so one failure cannot drop the other.
      try {
        const figure = await figureDownloadBlob();
        await saveDownload(figure.blob, figure.filename);
        lastAutoFigureRef.current = { kind: scanKind, filename: figure.filename };
        if (mountedRef.current) setFigState("idle");
        // Edits merged while the figure was rendering: replace the file now.
        const latestMerged = mergedFigureUrlRef.current;
        if (latestMerged && latestMerged !== figure.mergedSource) {
          await replaceAutoFigureWithMerged(latestMerged, figure.filename);
        } else if (figure.mergedSource) {
          lastReplacedMergedRef.current = figure.mergedSource;
        }
      } catch (e: any) {
        if (mountedRef.current) setFigState("error");
        errors.push(e?.message ?? String(e));
      }

      try {
        const csv = await csvDownloadBlob();
        await saveDownload(csv.blob, csv.filename);
        if (mountedRef.current) setCsvState("idle");
      } catch (e: any) {
        if (mountedRef.current) setCsvState("error");
        errors.push(e?.message ?? String(e));
      }

      if (errors.length && mountedRef.current) setAutoErr(errors.join("; "));
    }

    void runAutoDownload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, previewMode, autoDownload, phase, haveAnyData, scanKind, result?.chunks, result?.bytes, rasterCursor, vectorCursor, vectorRenderMode, outputPrefix]);

  // "Save merged edits" was clicked after the auto download: the FTP copy is
  // replaced by ImageCanvas; replace the auto-downloaded PNG here as well.
  useEffect(() => {
    if (disabled || previewMode || !autoDownload || !mergedFigureUrl) return;
    const last = lastAutoFigureRef.current;
    if (!last || last.kind !== scanKind) return;
    if (lastReplacedMergedRef.current === mergedFigureUrl) return;
    void replaceAutoFigureWithMerged(mergedFigureUrl, last.filename).catch((e: any) => {
      if (mountedRef.current) setAutoErr(e?.message ?? String(e));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, previewMode, autoDownload, mergedFigureUrl, scanKind]);

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
        <div style={{
          color: "var(--c-danger)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          whiteSpace: "pre-wrap",
        }}>
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
  const validationSummary = v ? (
    <>
      <div className="divider" />
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="card__title">{t("validation.title")}</span>
        <span className="spacer" />
        <span className="status-pill" data-state={v.passed ? "idle" : "error"}>
          {v.passed ? t("validation.allPassed") : t("validation.failures")}
        </span>
      </div>
      <ul className="validation-list">
        {v.checks.map((c) => (
          <li key={c.name}>
            <span className={c.passed ? "pass" : "fail"}>
              {c.passed ? t("validation.check.pass") : t("validation.check.fail")}
            </span>
            {/* Backend check names and details are technical identifiers and are
                intentionally displayed verbatim. */}
            <span>{c.name}</span>
            <span className="muted">{c.detail}</span>
          </li>
        ))}
      </ul>
    </>
  ) : null;

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

      {validationSummaryHost && validationSummary
        ? createPortal(validationSummary, validationSummaryHost)
        : validationSummary}
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
