/**
 * Import: pick a vendor file (icmd.TXT / md.TXT / registry export) or a calibration CSV (the Export CSV format)
 * -> quick local checks -> server-side validation + dry run (what would change) -> acknowledge risk -> commit.
 * A calibration CSV with structural problems is refused as a whole; every problem is listed with its line number.
 */
import { useRef, useState } from "react";

import { useTranslation } from "../../i18n";
import { CalibrationApiError, calibrationApi } from "../../lib/calibrationApi";
import { IMPORT_ACCEPT, IMPORT_MAX_BYTES, precheckImportFile } from "../../lib/calibrationImportFile";
import { decodeVendorFile, formatValue } from "../../lib/calibrationModel";
import type { CalibrationEquipmentType, CalibrationFileIssue, CalibrationImportPreview } from "../../types/calibration";
import { Icon } from "../Icon";
import { LoadingSpinner } from "../LoadingSpinner";
import { RiskAck } from "./RiskAck";

const SHOWN_ISSUES = 12;

type Phase = "idle" | "reading" | "ready" | "committing" | "done";

export function CalibrationImport({
  equipmentId,
  type,
  currentRevision,
  onClose,
  onImported,
}: {
  equipmentId: number;
  type: CalibrationEquipmentType;
  /** revision of the active profile, to flag a CSV exported from an older revision */
  currentRevision?: number | null;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t, fmt } = useTranslation();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<CalibrationImportPreview | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** the problems of a refused calibration CSV, one per line of the file */
  const [issues, setIssues] = useState<{ list: CalibrationFileIssue[]; total: number } | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setIssues(null);
    setPreview(null);
    setAck(false);
    setContent("");
    setFileName(file.name);

    const check = precheckImportFile(file, type);
    if (!check.ok) {
      setError(
        check.reason === "extension"
          ? t("calibration.import.invalid.extension")
          : check.reason === "empty"
            ? t("calibration.import.invalid.empty")
            : check.reason === "tooLarge"
              ? t("calibration.import.invalid.tooLarge", { max: fmt(Math.round(IMPORT_MAX_BYTES / 1_000_000)) })
              : t("calibration.import.invalid.wrongType", { fileType: check.fileType ?? "", type }),
      );
      setPhase("idle");
      return;
    }

    setPhase("reading");
    try {
      const text = decodeVendorFile(await file.arrayBuffer());
      setContent(text);
      setPreview(await calibrationApi.importFile(equipmentId, type, { file_name: file.name, content: text, dry_run: true }));
      setPhase("ready");
    } catch (err) {
      if (err instanceof CalibrationApiError && err.code === "invalid_csv" && err.errors.length > 0) {
        setIssues({
          list: err.errors.map((e) => ({ line: e.line ?? 0, code: e.code, message: e.message, parameter_key: e.parameter_key })),
          total: err.totalErrors ?? err.errors.length,
        });
        setError(t("calibration.import.invalid.csv", { count: fmt(err.totalErrors ?? err.errors.length) }));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setPhase("idle");
    }
  }

  async function commit() {
    setPhase("committing");
    setError(null);
    try {
      await calibrationApi.importFile(equipmentId, type, {
        file_name: fileName,
        content,
        dry_run: false,
        acknowledge_risk: ack,
        reason: t("calibration.import.reason", { file: fileName }),
      });
      setPhase("done");
      onImported();
    } catch (err) {
      setError(err instanceof CalibrationApiError ? err.message : err instanceof Error ? err.message : String(err));
      setPhase("ready");
    }
  }

  const risky = preview?.risky_changed ?? 0;
  const canCommit = phase === "ready" && preview !== null && preview.changed > 0 && preview.rejected_count === 0 && (risky === 0 || ack);
  const csv = preview?.csv;
  const staleRevision =
    csv?.file_revision !== null && csv?.file_revision !== undefined && currentRevision !== null && currentRevision !== undefined
      ? csv.file_revision < currentRevision
      : false;
  const lineLabel = (line: number | undefined) => (line ? `${t("calibration.import.line", { line })}: ` : "");
  const formatLabel =
    preview?.format === "csv"
      ? "calibration.import.formatCsv"
      : preview?.format === "registry"
        ? "calibration.import.formatRegistry"
        : "calibration.import.formatMachine";

  return (
    <section className="calib-import" aria-label={t("calibration.import.title", { type })}>
      <header className="calib-history__head">
        <h4>{t("calibration.import.title", { type })}</h4>
        <button type="button" className="btn btn--ghost" onClick={onClose}>{t("calibration.history.close")}</button>
      </header>
      <p className="calib-muted">{t(type === "FIB" ? "calibration.import.helpFib" : "calibration.import.helpSem")}</p>
      <p className="calib-muted">{t("calibration.import.helpCsv")}</p>

      <div className="calib-import__pick">
        <input
          ref={fileInput}
          type="file"
          accept={IMPORT_ACCEPT}
          hidden
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button type="button" className="btn" disabled={phase === "reading" || phase === "committing"} onClick={() => fileInput.current?.click()}>
          <Icon name="upload" tone="accent" />
          {t("calibration.import.choose")}
        </button>
        {fileName && <span className="calib-muted">{fileName}</span>}
      </div>

      {phase === "reading" && <LoadingSpinner label={t("calibration.import.reading")} />}
      {error && <p className="calib-row__error" role="alert">{error}</p>}
      {issues && (
        <div className="calib-import__problems calib-import__problems--invalid">
          <ul>
            {issues.list.slice(0, SHOWN_ISSUES).map((issue, index) => (
              <li key={`${issue.line}-${issue.code}-${index}`}>
                {lineLabel(issue.line)}
                {issue.message}
              </li>
            ))}
          </ul>
          {issues.total > Math.min(SHOWN_ISSUES, issues.list.length) && (
            <p className="calib-muted">{t("calibration.import.invalid.more", { count: fmt(issues.total - Math.min(SHOWN_ISSUES, issues.list.length)) })}</p>
          )}
          <p className="calib-muted">{t("calibration.import.invalid.hint")}</p>
        </div>
      )}

      {preview && (
        <div className="calib-import__preview">
          <p>
            <strong>{t(formatLabel)}</strong>{" "}
            {t("calibration.import.summary", { matched: fmt(preview.matched), changed: fmt(preview.changed), unchanged: fmt(preview.unchanged) })}
          </p>
          {csv && (
            <p className="calib-muted">
              {t("calibration.import.csvRows", { rows: fmt(csv.rows), values: fmt(csv.values) })}
            </p>
          )}
          {staleRevision && (
            <p className="calib-banner calib-banner--warn">
              {t("calibration.import.staleRevision", { fileRevision: csv?.file_revision ?? 0, revision: currentRevision ?? 0 })}
            </p>
          )}
          {csv && csv.warnings.length > 0 && (
            <div className="calib-import__problems">
              <ul>
                {csv.warnings.map((w, index) => (
                  <li key={`${w.code}-${index}`}>
                    {lineLabel(w.line)}
                    {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.unmatched_count > 0 && (
            <>
              <p className="calib-muted">
                {t(csv ? "calibration.import.unmatchedCsv" : "calibration.import.unmatched", { count: fmt(preview.unmatched_count) })}
              </p>
              {csv && preview.unmatched.length > 0 && (
                <p className="calib-muted calib-import__keys">
                  {preview.unmatched.slice(0, 10).map((key) => <code key={key}>{key}</code>)}
                  {preview.unmatched_count > Math.min(10, preview.unmatched.length) && " …"}
                </p>
              )}
            </>
          )}
          {preview.other_type_count > 0 && (
            <p className="calib-muted">
              {t("calibration.import.otherType", { count: fmt(preview.other_type_count), other: type === "FIB" ? "SEM" : "FIB" })}
            </p>
          )}
          {preview.rejected_count > 0 && (
            <div className="calib-import__problems">
              <p className="calib-row__error">{t("calibration.import.rejected", { count: fmt(preview.rejected_count) })}</p>
              <ul>
                {preview.rejected.slice(0, 6).map((r) => (
                  <li key={r.parameter_key + r.raw}>{lineLabel(r.line)}<code>{r.parameter_key}</code> = {r.raw}: {r.message}</li>
                ))}
              </ul>
              <p className="calib-row__error">{t("calibration.import.blockedRejected")}</p>
            </div>
          )}
          {preview.warning_count > 0 && (
            <div className="calib-import__problems">
              <p className="calib-muted">{t("calibration.import.warnings", { count: fmt(preview.warning_count) })}</p>
              <ul>
                {preview.warnings.slice(0, 6).map((w) => (
                  <li key={w.parameter_key}>{lineLabel(w.line)}<code>{w.parameter_key}</code> = {w.raw}: {w.message}</li>
                ))}
              </ul>
            </div>
          )}
          {(preview.changes?.length ?? 0) > 0 && (
            <details className="calib-import__changes">
              <summary>{t("calibration.import.changes", { count: fmt(preview.changed) })}</summary>
              <ul>
                {preview.changes!.map((c) => (
                  <li key={c.parameter_key}><code>{c.parameter_key}</code>: {formatValue(c.old) || "—"} → <strong>{formatValue(c.new)}</strong></li>
                ))}
              </ul>
              {preview.changed > preview.changes!.length && <p className="calib-muted">{t("calibration.import.changesTruncated", { shown: preview.changes!.length })}</p>}
            </details>
          )}
          {risky > 0 && (
            <RiskAck className="calib-ack--inline calib-import__ack" checked={ack} onChange={setAck}>
              {t("calibration.import.ack", { count: fmt(risky) })}
            </RiskAck>
          )}
          {preview.changed === 0 && <p className="calib-muted">{t("calibration.import.nothingToDo")}</p>}
          <span className="calib-details__buttons">
            <button type="button" className="btn btn--primary" disabled={!canCommit} onClick={() => void commit()}>
              {phase === "committing" ? t("calibration.import.committing") : t("calibration.import.commit", { count: fmt(preview.changed) })}
            </button>
            <button type="button" className="btn btn--cancel" onClick={onClose}>{t("calibration.edit.cancel")}</button>
          </span>
        </div>
      )}
      {phase === "done" && <p className="calib-import__done">{t("calibration.import.done")}</p>}
    </section>
  );
}
