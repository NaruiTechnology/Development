/** One parameter of the list view: label + badges, editor, unit, and an expandable details / admin-edit area. */
import { useState } from "react";

import { useTranslation, type TranslationKey } from "../../i18n";
import {
  enumLabel,
  formatValue,
  limitViolation,
  requiredRole,
  riskReason,
  type ParseResult,
} from "../../lib/calibrationModel";
import type { CalibrationDefinition, CalibrationEdit, CalibrationStoredValue } from "../../types/calibration";
import { Icon } from "../Icon";
import { ValueInput, parseMessageKey } from "./ValueInput";

export interface CalibrationRowProps {
  def: CalibrationDefinition;
  stored: CalibrationStoredValue | undefined;
  edit: CalibrationEdit | undefined;
  role: number | null;
  serverError?: string;
  parseError?: Extract<ParseResult, { ok: false }>["message"];
  isAdmin: boolean;
  resetKey: number;
  onParsed: (parsed: ParseResult) => void;
  onRevert: () => void;
  onHistory: () => void;
  onSaveInfo: (patch: { display_name: string; description: string; unit: string; semantics_known: boolean }) => Promise<void>;
}

const RISK_KEY: Record<string, TranslationKey> = {
  undocumented: "calibration.badge.undocumented",
  fixed: "calibration.badge.fixed",
  lowConfidence: "calibration.badge.lowConfidence",
};

export function CalibrationRow(props: CalibrationRowProps) {
  const { def, stored, edit, role } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const effective: unknown =
    edit?.kind === "set" ? edit.value : edit?.kind === "clear" ? undefined : stored?.value ?? undefined;
  const risk = riskReason(def);
  const needed = requiredRole(def.access_level);
  const roleOk = role !== null && role >= needed;
  const editable = def.ui_widget !== "readonly" && roleOk;
  const violation = edit?.kind === "set" ? limitViolation(def, edit.value) : null;
  const dirty = edit !== undefined;
  const error =
    props.serverError ??
    (props.parseError ? t(parseMessageKey(props.parseError)) : undefined) ??
    (violation ? t("calibration.limit.outside", { min: formatValue(violation.min), max: formatValue(violation.max) }) : undefined);
  const hasLimit =
    def.minimum_value !== null && def.maximum_value !== null && def.minimum_value <= def.maximum_value && !(def.minimum_value === 0 && def.maximum_value === 0);
  const lockTitle = !roleOk
    ? t("calibration.lock.role", { role: needed })
    : def.ui_widget === "readonly"
      ? t("calibration.lock.readonly")
      : undefined;
  const label = enumLabel(def.enum_options, effective);

  return (
    <div
      className="calib-row"
      data-dirty={dirty ? "true" : "false"}
      data-invalid={error ? "true" : "false"}
      data-locked={editable ? "false" : "true"}
      data-undocumented={!def.semantics_known || def.param_class === "undocumented" ? "true" : "false"}
      role="row"
    >
      <div className="calib-row__label" role="cell">
        <span className="calib-row__name">{def.display_name}</span>
        <span className="calib-row__key" title={def.parameter_key}>
          {def.vendor_name ?? def.parameter_key}
        </span>
        <span className="calib-row__badges">
          {risk && (
            <span className={`calib-badge calib-badge--${risk === "fixed" ? "info" : "warn"}`} title={t("calibration.badge.riskTitle")}>
              {t(RISK_KEY[risk])}
            </span>
          )}
          {def.access_level === "service" && <span className="calib-badge">{t("calibration.badge.service")}</span>}
          {def.shared_hardware && (
            <span className="calib-badge" title={t("calibration.badge.sharedTitle")}>
              {t("calibration.badge.shared")}
            </span>
          )}
          {def.review_state !== "imported" && <span className="calib-badge calib-badge--ok">{t("calibration.badge.reviewed")}</span>}
        </span>
      </div>

      <div className="calib-row__editor" role="cell">
        {def.ui_widget === "readonly" || !editable ? (
          <span className="calib-readonly" title={lockTitle}>
            {formatValue(effective) === "" ? "—" : formatValue(effective)}
            {label ? ` (${label})` : ""}
          </span>
        ) : (
          <ValueInput
            valueType={def.value_type}
            enumOptions={def.enum_options}
            value={effective}
            placeholder={def.default_value !== null && def.default_value !== undefined ? formatValue(def.default_value) : undefined}
            invalid={Boolean(error)}
            ariaLabel={def.display_name}
            title={def.parameter_key}
            resetKey={props.resetKey}
            onChange={props.onParsed}
          />
        )}
        {error && <span className="calib-row__error" role="alert">{error}</span>}
        {!error && hasLimit && editable && (
          <span className="calib-row__hint">
            {formatValue(def.minimum_value)} … {formatValue(def.maximum_value)}
          </span>
        )}
      </div>

      <span className="calib-row__unit" role="cell">{def.unit}</span>

      <div className="calib-row__actions" role="cell">
        {dirty && (
          <button type="button" className="btn btn--ghost btn--icon" onClick={props.onRevert} title={t("calibration.row.revert")} aria-label={t("calibration.row.revert")}>
            <Icon name="refresh" tone="accent" />
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--icon" onClick={props.onHistory} title={t("calibration.row.history")} aria-label={t("calibration.row.history")}>
          <Icon name="fileText" tone="accent" />
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={t("calibration.row.details")}
          aria-label={t("calibration.row.details")}
        >
          <Icon name="help" tone="accent" />
        </button>
      </div>

      {open && (
        <div className="calib-row__details" role="cell">
          <RowDetails {...props} effective={effective} editable={editable} />
        </div>
      )}
    </div>
  );
}

function RowDetails(props: CalibrationRowProps & { effective: unknown; editable: boolean }) {
  const { def, stored } = props;
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(def.display_name);
  const [description, setDescription] = useState(def.description);
  const [unit, setUnit] = useState(def.unit);
  const [known, setKnown] = useState(def.semantics_known);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      await props.onSaveInfo({ display_name: name.trim(), description, unit: unit.trim(), semantics_known: known });
      setEditing(false);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dl className="calib-details">
      {def.description && (<><dt>{t("calibration.details.description")}</dt><dd>{def.description}</dd></>)}
      <dt>{t("calibration.details.key")}</dt>
      <dd><code>{def.parameter_key}</code></dd>
      <dt>{t("calibration.details.source")}</dt>
      <dd>{def.source_vendor} · {def.source_document}<br /><code>{def.source_reference}</code></dd>
      <dt>{t("calibration.details.access")}</dt>
      <dd>
        {t(`calibration.access.${def.access_level}` as TranslationKey)} · {t(`calibration.class.${def.param_class}` as TranslationKey)}
        {def.assign_conf ? ` · ${t("calibration.details.confidence", { level: t(`calibration.confidence.${def.assign_conf}` as TranslationKey) })}` : ""}
      </dd>
      {def.default_value !== null && def.default_value !== undefined && (
        <><dt>{t("calibration.details.factory")}</dt><dd>{formatValue(def.default_value)} {def.unit}</dd></>
      )}
      {stored?.verified_at && (<><dt>{t("calibration.details.verified")}</dt><dd>{stored.verified_at}</dd></>)}
      {!def.semantics_known && (<><dt /><dd className="calib-details__warn">{t("calibration.details.undocumentedNote")}</dd></>)}
      {props.isAdmin && !editing && (
        <><dt /><dd><button type="button" className="btn btn--ghost" onClick={() => setEditing(true)}>{t("calibration.details.editInfo")}</button></dd></>
      )}
      {props.isAdmin && editing && (
        <>
          <dt>{t("calibration.details.editInfo")}</dt>
          <dd className="calib-details__form">
            <label>{t("calibration.edit.name")}<input className="input" value={name} maxLength={300} onChange={(e) => setName(e.target.value)} /></label>
            <label>{t("calibration.edit.description")}<textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
            <label>{t("calibration.edit.unit")}<input className="input" value={unit} maxLength={30} onChange={(e) => setUnit(e.target.value)} /></label>
            <label className="calib-check"><input type="checkbox" checked={known} onChange={(e) => setKnown(e.target.checked)} />{t("calibration.edit.known")}</label>
            {failure && <span className="calib-row__error" role="alert">{failure}</span>}
            <span className="calib-details__buttons">
              <button type="button" className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => void submit()}>{t("calibration.edit.save")}</button>
              <button type="button" className="btn btn--cancel" disabled={busy} onClick={() => setEditing(false)}>{t("calibration.edit.cancel")}</button>
            </span>
          </dd>
        </>
      )}
    </dl>
  );
}
