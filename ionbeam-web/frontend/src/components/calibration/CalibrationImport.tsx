/** Vendor-file import: pick a file -> server-side dry run (what would change) -> acknowledge risk -> commit. */
import { useRef, useState } from "react";

import { useTranslation } from "../../i18n";
import { CalibrationApiError, calibrationApi } from "../../lib/calibrationApi";
import { decodeVendorFile, formatValue } from "../../lib/calibrationModel";
import type { CalibrationEquipmentType, CalibrationImportPreview } from "../../types/calibration";
import { Icon } from "../Icon";

type Phase = "idle" | "reading" | "ready" | "committing" | "done";

export function CalibrationImport({
  equipmentId,
  type,
  onClose,
  onImported,
}: {
  equipmentId: number;
  type: CalibrationEquipmentType;
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

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setPreview(null);
    setAck(false);
    setFileName(file.name);
    setPhase("reading");
    try {
      const text = decodeVendorFile(await file.arrayBuffer());
      setContent(text);
      setPreview(await calibrationApi.importFile(equipmentId, type, { file_name: file.name, content: text, dry_run: true }));
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
  const canCommit = phase === "ready" && preview !== null && preview.changed > 0 && (risky === 0 || ack);

  return (
    <section className="calib-import" aria-label={t("calibration.import.title", { type })}>
      <header className="calib-history__head">
        <h4>{t("calibration.import.title", { type })}</h4>
        <button type="button" className="btn btn--ghost" onClick={onClose}>{t("calibration.history.close")}</button>
      </header>
      <p className="calib-muted">{t(type === "FIB" ? "calibration.import.helpFib" : "calibration.import.helpSem")}</p>

      <div className="calib-import__pick">
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.TXT,text/plain"
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

      {phase === "reading" && <p className="calib-muted">{t("calibration.import.reading")}</p>}
      {error && <p className="calib-row__error" role="alert">{error}</p>}

      {preview && (
        <div className="calib-import__preview">
          <p>
            <strong>{t(preview.format === "registry" ? "calibration.import.formatRegistry" : "calibration.import.formatMachine")}</strong>{" "}
            {t("calibration.import.summary", { matched: fmt(preview.matched), changed: fmt(preview.changed), unchanged: fmt(preview.unchanged) })}
          </p>
          {preview.unmatched_count > 0 && (
            <p className="calib-muted">{t("calibration.import.unmatched", { count: fmt(preview.unmatched_count) })}</p>
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
                  <li key={r.parameter_key + r.raw}><code>{r.parameter_key}</code> = {r.raw}: {r.message}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.warning_count > 0 && (
            <div className="calib-import__problems">
              <p className="calib-muted">{t("calibration.import.warnings", { count: fmt(preview.warning_count) })}</p>
              <ul>
                {preview.warnings.slice(0, 6).map((w) => (
                  <li key={w.parameter_key}><code>{w.parameter_key}</code> = {w.raw}: {w.message}</li>
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
            <label className="calib-check calib-import__ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {t("calibration.import.ack", { count: fmt(risky) })}
            </label>
          )}
          {preview.changed === 0 && <p className="calib-muted">{t("calibration.import.nothingToDo")}</p>}
          <span className="calib-details__buttons">
            <button type="button" className="btn btn--primary" disabled={!canCommit} onClick={() => void commit()}>
              {phase === "committing" ? t("calibration.import.committing") : t("calibration.import.commit", { count: fmt(preview.changed) })}
            </button>
            <button type="button" className="btn btn--ghost" onClick={onClose}>{t("calibration.edit.cancel")}</button>
          </span>
        </div>
      )}
      {phase === "done" && <p className="calib-import__done">{t("calibration.import.done")}</p>}
    </section>
  );
}
