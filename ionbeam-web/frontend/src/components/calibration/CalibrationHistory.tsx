/** Revision history of one equipment/type profile (or of one parameter), with preview-then-confirm restore. */
import { useCallback, useEffect, useState } from "react";

import { useTranslation, type TranslationKey } from "../../i18n";
import { CalibrationApiError, calibrationApi } from "../../lib/calibrationApi";
import { formatValue, ROLE_SUPER_USER } from "../../lib/calibrationModel";
import type { CalibrationEquipmentType, CalibrationRevision, CalibrationWriteResult } from "../../types/calibration";

const PAGE = 25;

interface RestoreState {
  revision: number;
  ack: boolean;
  needsAck: string[];
  preview: CalibrationWriteResult | null;
  busy: boolean;
  error: string | null;
}

export function CalibrationHistory({
  equipmentId,
  type,
  parameterKey,
  role,
  currentRevision,
  reloadToken,
  onClose,
  onRestored,
}: {
  equipmentId: number;
  type: CalibrationEquipmentType;
  parameterKey: string | null;
  role: number | null;
  currentRevision: number;
  reloadToken: number;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const [revisions, setRevisions] = useState<CalibrationRevision[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restore, setRestore] = useState<RestoreState | null>(null);
  const canRestore = role !== null && role >= ROLE_SUPER_USER && parameterKey === null;

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await calibrationApi.history(equipmentId, type, { parameter_key: parameterKey ?? undefined, limit: PAGE, offset });
        setRevisions((prev) => (offset === 0 ? res.revisions : [...prev, ...res.revisions]));
        setMore(res.revisions.length === PAGE);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [equipmentId, type, parameterKey],
  );

  useEffect(() => {
    void load(0);
  }, [load, reloadToken]);

  async function startRestore(revision: number, ack = false) {
    setRestore((prev) => ({ revision, ack, needsAck: prev?.needsAck ?? [], preview: null, busy: true, error: null }));
    try {
      const res = await calibrationApi.restore(equipmentId, type, { revision, dry_run: true, acknowledge_risk: ack });
      setRestore({ revision, ack, needsAck: [], preview: res.result, busy: false, error: null });
    } catch (err) {
      if (err instanceof CalibrationApiError && err.code === "risk_ack_required") {
        setRestore({ revision, ack, needsAck: err.errors.map((e) => `${e.parameter_key ?? ""} — ${e.message}`), preview: null, busy: false, error: null });
      } else {
        setRestore({ revision, ack, needsAck: [], preview: null, busy: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async function confirmRestore() {
    if (!restore) return;
    setRestore({ ...restore, busy: true, error: null });
    try {
      await calibrationApi.restore(equipmentId, type, {
        revision: restore.revision,
        acknowledge_risk: restore.ack,
        expected_revision: currentRevision,
        reason: t("calibration.history.restoreReason", { revision: restore.revision }),
      });
      setRestore(null);
      onRestored();
    } catch (err) {
      setRestore({ ...restore, busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const kindKey: Record<string, TranslationKey> = {
    edit: "calibration.history.kind.edit",
    import: "calibration.history.kind.import",
    restore: "calibration.history.kind.restore",
  };

  return (
    <section className="calib-history" aria-label={t("calibration.history.title")}>
      <header className="calib-history__head">
        <h4>
          {parameterKey ? t("calibration.history.titleParam", { key: parameterKey }) : t("calibration.history.title")}
        </h4>
        <button type="button" className="btn btn--ghost" onClick={onClose}>{t("calibration.history.close")}</button>
      </header>
      {error && <p className="calib-row__error" role="alert">{error}</p>}
      {!loading && revisions.length === 0 && !error && <p className="calib-muted">{t("calibration.history.empty")}</p>}
      <ol className="calib-history__list">
        {revisions.map((rev) => (
          <li key={rev.revision} className="calib-history__item">
            <div className="calib-history__line">
              <strong>#{rev.revision}</strong>
              <span className="calib-badge">{t(kindKey[rev.kind ?? "edit"] ?? kindKey.edit)}</span>
              <span>{rev.created_at.replace("T", " ").slice(0, 19)}</span>
              <span className="calib-muted">{rev.created_by_name ?? t("calibration.history.unknownUser")}</span>
              <span className="calib-muted">{t("calibration.history.changed", { count: rev.changed_count ?? 0 })}</span>
              {rev.revision === currentRevision && <span className="calib-badge calib-badge--ok">{t("calibration.history.current")}</span>}
              <span className="spacer" />
              <button type="button" className="btn btn--ghost" aria-expanded={expanded === rev.revision} onClick={() => setExpanded(expanded === rev.revision ? null : rev.revision)}>
                {t("calibration.history.details")}
              </button>
              {canRestore && rev.revision !== currentRevision && (
                <button type="button" className="btn btn--warn" disabled={restore?.busy} onClick={() => void startRestore(rev.revision)}>
                  {t("calibration.history.restore")}
                </button>
              )}
            </div>
            {(rev.reason || rev.source_ref) && (
              <div className="calib-muted calib-history__reason">{[rev.source_ref, rev.reason].filter(Boolean).join(" — ")}</div>
            )}
            {expanded === rev.revision && (
              <ul className="calib-history__changes">
                {(rev.changes ?? []).map((c) => (
                  <li key={c.parameter_key}>
                    <code>{c.parameter_key}</code>: {formatValue(c.old) || "—"} → <strong>{formatValue(c.new) || "—"}</strong>
                  </li>
                ))}
                {rev.changes_truncated && <li className="calib-muted">{t("calibration.history.truncated")}</li>}
              </ul>
            )}
            {restore?.revision === rev.revision && (
              <div className="calib-confirm" role="group" aria-label={t("calibration.history.restore")}>
                {restore.needsAck.length > 0 && (
                  <>
                    <p className="calib-row__error">{t("calibration.history.needsAck", { count: restore.needsAck.length })}</p>
                    <ul className="calib-history__changes">{restore.needsAck.slice(0, 8).map((m) => <li key={m}>{m}</li>)}</ul>
                    <label className="calib-check">
                      <input type="checkbox" checked={restore.ack} onChange={(e) => void startRestore(rev.revision, e.target.checked)} />
                      {t("calibration.ack.label")}
                    </label>
                  </>
                )}
                {restore.preview && (
                  <p>{t("calibration.history.restorePreview", { revision: rev.revision, count: restore.preview.changed, next: currentRevision + 1 })}</p>
                )}
                {restore.error && <p className="calib-row__error" role="alert">{restore.error}</p>}
                <span className="calib-details__buttons">
                  <button type="button" className="btn btn--primary" disabled={restore.busy || !restore.preview || restore.preview.changed === 0} onClick={() => void confirmRestore()}>
                    {t("calibration.history.restoreConfirm")}
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => setRestore(null)}>{t("calibration.edit.cancel")}</button>
                </span>
              </div>
            )}
          </li>
        ))}
      </ol>
      {more && (
        <button type="button" className="btn btn--ghost" disabled={loading} onClick={() => void load(revisions.length)}>
          {t("calibration.list.loadMore")}
        </button>
      )}
    </section>
  );
}
