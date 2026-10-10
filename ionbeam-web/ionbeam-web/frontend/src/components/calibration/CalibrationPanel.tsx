/**
 * CONFIGURATION > Admin > Calibration: FIB / SEM calibration parameters of a registered machine.
 *
 *   equipment + FIB|SEM  ->  group tree  ->  parameter list (or a matrix for table layouts)
 *   edits are collected locally, then saved as ONE revision (with a reason); history can restore any revision;
 *   a vendor machine-data file can be imported (dry-run preview first).
 *
 * The database is the authority for roles, limits and risk acknowledgement; the checks here only explain a
 * refusal before it happens (see lib/calibrationModel.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "../../i18n";
import { CalibrationApiError, calibrationApi, fetchCurrentRole, fetchEquipmentList } from "../../lib/calibrationApi";
import {
  ROLE_ADMIN,
  ROLE_DEVELOPER,
  ROLE_SUPER_USER,
  applyTyped,
  riskReason,
  toWriteItems,
  type ParseResult,
} from "../../lib/calibrationModel";
import type {
  CalibrationBundle,
  CalibrationDefinition,
  CalibrationEdit,
  CalibrationEquipmentType,
  CalibrationGroupsResponse,
  CalibrationTableResponse,
  EquipmentRecord,
} from "../../types/calibration";
import { Icon } from "../Icon";
import { CalibrationHistory } from "./CalibrationHistory";
import { CalibrationImport } from "./CalibrationImport";
import { CalibrationMatrixGrid } from "./CalibrationMatrixGrid";
import { CalibrationRow } from "./CalibrationRow";
import { CalibrationTree, type TreeSelection } from "./CalibrationTree";
import { ScanGeometryPanel } from "./ScanGeometryPanel";

const PAGE = 100;
type Mode = "values" | "history" | "import" | "geometry";
type Notice = { tone: "success" | "error" | "warning"; text: string } | null;
type RiskInfo = { semantics_known: boolean; param_class: CalibrationDefinition["param_class"]; access_level: CalibrationDefinition["access_level"]; assign_conf: CalibrationDefinition["assign_conf"] };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function CalibrationPanel() {
  const { t, fmt } = useTranslation();

  const [equipment, setEquipment] = useState<EquipmentRecord[]>([]);
  const [equipmentId, setEquipmentId] = useState<number | null>(null);
  const [type, setType] = useState<CalibrationEquipmentType>("FIB");
  const [role, setRole] = useState<number | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [groups, setGroups] = useState<CalibrationGroupsResponse | null>(null);
  const [selection, setSelection] = useState<TreeSelection>({ kind: "group", code: null });
  const [search, setSearch] = useState("");
  const [undocumentedOnly, setUndocumentedOnly] = useState(false);
  const [accessFilter, setAccessFilter] = useState("");
  const debouncedSearch = useDebounced(search.trim(), 300);

  const [bundle, setBundle] = useState<CalibrationBundle | null>(null);
  const [tableData, setTableData] = useState<CalibrationTableResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [edits, setEdits] = useState<Map<string, CalibrationEdit>>(new Map());
  const [parseErrors, setParseErrors] = useState<Map<string, Parameters<typeof CalibrationRow>[0]["parseError"]>>(new Map());
  const [serverErrors, setServerErrors] = useState<Map<string, string>>(new Map());
  const [resetKey, setResetKey] = useState(0);
  const riskByKey = useRef(new Map<string, RiskInfo>());
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [conflict, setConflict] = useState(false);

  const [mode, setMode] = useState<Mode>("values");
  const [historyKey, setHistoryKey] = useState<string | null>(null);

  const canEdit = role !== null && role >= ROLE_SUPER_USER;
  const canImport = role !== null && role >= ROLE_DEVELOPER;
  const isAdmin = role !== null && role >= ROLE_ADMIN;
  const profile = bundle?.profile ?? tableData?.profile ?? null;
  const selectedEquipment = equipment.find((item) => item.id === equipmentId) ?? null;
  const semAvailable = !selectedEquipment?.name.trim().toUpperCase().startsWith("FIB");

  useEffect(() => {
    if (!semAvailable && type === "SEM") setType("FIB");
  }, [semAvailable, type]);

  // ---- boot: equipment list + role ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchEquipmentList(), fetchCurrentRole()])
      .then(([list, r]) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name) || a.id - b.id);
        setEquipment(sorted);
        setRole(r);
        setEquipmentId((prev) => prev ?? sorted[0]?.id ?? null);
      })
      .catch((err) => !cancelled && setBootError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- groups (tree + counts) -----------------------------------------------------------------
  useEffect(() => {
    if (equipmentId === null) return;
    let cancelled = false;
    calibrationApi
      .groups(type, equipmentId)
      .then((g) => !cancelled && setGroups(g))
      .catch((err) => !cancelled && setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [equipmentId, type, reloadToken]);

  // ---- values of the current view -------------------------------------------------------------
  const seq = useRef(0);
  const remember = useCallback((defs: Array<RiskInfo & { parameter_key: string }>) => {
    for (const d of defs) riskByKey.current.set(d.parameter_key, d);
  }, []);

  useEffect(() => {
    if (equipmentId === null) return;
    const mine = ++seq.current;
    setLoading(true);
    setLoadError(null);
    const done = () => mine === seq.current && setLoading(false);
    if (selection.kind === "table") {
      calibrationApi
        .table(equipmentId, type, selection.code)
        .then((res) => {
          if (mine !== seq.current) return;
          remember(res.cells);
          setTableData(res);
          setBundle(null);
        })
        .catch((err) => mine === seq.current && setLoadError(err instanceof Error ? err.message : String(err)))
        .finally(done);
    } else {
      calibrationApi
        .bundle(equipmentId, type, {
          group_code: selection.code ?? undefined,
          q: debouncedSearch || undefined,
          undocumented: undocumentedOnly ? true : undefined,
          access_level: accessFilter || undefined,
          limit: PAGE,
          offset: 0,
        })
        .then((res) => {
          if (mine !== seq.current) return;
          remember(res.definitions);
          setBundle(res);
          setTableData(null);
        })
        .catch((err) => mine === seq.current && setLoadError(err instanceof Error ? err.message : String(err)))
        .finally(done);
    }
  }, [equipmentId, type, selection, debouncedSearch, undocumentedOnly, accessFilter, reloadToken, remember]);

  async function loadMore() {
    if (!bundle || equipmentId === null) return;
    setLoading(true);
    try {
      const res = await calibrationApi.bundle(equipmentId, type, {
        group_code: selection.kind === "group" ? selection.code ?? undefined : undefined,
        q: debouncedSearch || undefined,
        undocumented: undocumentedOnly ? true : undefined,
        access_level: accessFilter || undefined,
        limit: PAGE,
        offset: bundle.definitions.length,
      });
      remember(res.definitions);
      setBundle({ ...bundle, definitions: [...bundle.definitions, ...res.definitions], values: [...bundle.values, ...res.values], total: res.total });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const storedByKey = useMemo(() => new Map((bundle?.values ?? []).map((v) => [v.parameter_key, v])), [bundle]);

  // ---- editing --------------------------------------------------------------------------------
  const handleParsed = useCallback((key: string, stored: unknown, parsed: ParseResult) => {
    setParseErrors((m) => {
      const n = new Map(m);
      if (parsed.ok) n.delete(key);
      else n.set(key, parsed.message);
      return n;
    });
    setServerErrors((m) => {
      if (!m.has(key)) return m;
      const n = new Map(m);
      n.delete(key);
      return n;
    });
    setEdits((prev) => applyTyped(prev, key, parsed, stored));
    setNotice(null);
  }, []);

  function revert(key: string) {
    setEdits((m) => {
      const n = new Map(m);
      n.delete(key);
      return n;
    });
    setParseErrors((m) => {
      const n = new Map(m);
      n.delete(key);
      return n;
    });
    setServerErrors((m) => {
      const n = new Map(m);
      n.delete(key);
      return n;
    });
    setResetKey((k) => k + 1);
  }

  function discardAll() {
    setEdits(new Map());
    setParseErrors(new Map());
    setServerErrors(new Map());
    setAck(false);
    setReason("");
    setConflict(false);
    setResetKey((k) => k + 1);
  }

  function confirmLeave(): boolean {
    if (edits.size === 0) return true;
    if (!window.confirm(t("calibration.confirm.discard", { count: edits.size }))) return false;
    discardAll();
    return true;
  }

  const riskyKeys = useMemo(() => {
    const out: string[] = [];
    for (const key of edits.keys()) {
      const info = riskByKey.current.get(key);
      if (info && riskReason(info)) out.push(key);
    }
    return out;
  }, [edits]);

  const canSave = canEdit && edits.size > 0 && parseErrors.size === 0 && !saving && (riskyKeys.length === 0 || ack);

  async function save() {
    if (equipmentId === null || !canSave) return;
    setSaving(true);
    setNotice(null);
    setConflict(false);
    try {
      const res = await calibrationApi.save(equipmentId, type, {
        values: toWriteItems(edits),
        reason: reason.trim() || undefined,
        expected_revision: profile?.revision,
        acknowledge_risk: ack,
      });
      setNotice({ tone: "success", text: t("calibration.save.ok", { revision: res.result?.revision ?? 0, count: res.result?.changed ?? 0 }) });
      discardAll();
      setReloadToken((n) => n + 1);
    } catch (err) {
      if (err instanceof CalibrationApiError) {
        if (err.code === "revision_conflict") {
          setConflict(true);
          setNotice({ tone: "warning", text: t("calibration.save.conflict", { revision: err.currentRevision ?? 0 }) });
        } else {
          const map = new Map<string, string>();
          for (const e of err.errors) if (e.parameter_key) map.set(e.parameter_key, e.message);
          setServerErrors(map);
          setNotice({ tone: "error", text: err.errors.length > 1 ? t("calibration.save.failedMany", { count: err.errors.length }) : err.message });
        }
      } else {
        setNotice({ tone: "error", text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveInfo(id: number, patch: { display_name: string; description: string; unit: string; semantics_known: boolean }) {
    await calibrationApi.updateDefinition(id, patch);
    setReloadToken((n) => n + 1);
  }

  async function exportCsv() {
    if (equipmentId === null) return;
    try {
      const { blob, filename } = await calibrationApi.exportCsv(equipmentId, type);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---- render ---------------------------------------------------------------------------------
  if (bootError) return <p className="calib-row__error" role="alert">{bootError}</p>;
  if (equipment.length === 0 && role === null) return <p className="calib-muted">{t("calibration.loading")}</p>;
  if (equipment.length === 0) return <p className="calib-muted">{t("calibration.noEquipment")}</p>;

  const quality = groups?.quality;
  const undocumentedShare = quality && quality.definitions > 0 ? quality.undocumented : 0;

  return (
    <div className="calib">
      <div className="calib__head">
        <label className="calib__field">
          <span>{t("calibration.equipment")}</span>
          <select
            className="select"
            value={equipmentId ?? ""}
            onChange={(e) => {
              if (!confirmLeave()) return;
              setEquipmentId(Number(e.target.value));
              setNotice(null);
              setMode("values");
            }}
          >
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>
                {e.site} · {e.name} ({e.serial_number})
              </option>
            ))}
          </select>
        </label>
        <div className="calib__field">
          <span id="calib-type-label">{t("calibration.column")}</span>
          <div className="calib-seg" role="tablist" aria-labelledby="calib-type-label">
            {(["FIB", ...(semAvailable ? (["SEM"] as const) : [])] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={type === k}
                className="calib-seg__btn"
                onClick={() => {
                  if (k === type || !confirmLeave()) return;
                  setType(k);
                  setSelection({ kind: "group", code: null });
                  setNotice(null);
                  setMode("values");
                }}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        <div className="calib__profile" aria-live="polite">
          {profile ? (
            <>
              <strong>{profile.profile_name}</strong> · {t("calibration.profile.revision", { revision: profile.revision })}
              <br />
              <span className="calib-muted">{profile.updated_at.replace("T", " ").slice(0, 19)}</span>
            </>
          ) : (
            <span className="calib-muted">{t("calibration.profile.none")}</span>
          )}
        </div>
        <div className="calib__actions">
          <button type="button" className="btn btn--ghost" onClick={() => { setHistoryKey(null); setMode(mode === "history" && historyKey === null ? "values" : "history"); }} aria-pressed={mode === "history"}>
            <Icon name="fileText" tone="accent" />{t("calibration.action.history")}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setMode(mode === "geometry" ? "values" : "geometry")} aria-pressed={mode === "geometry"}>
            <Icon name="ruler" tone="accent" />{t("geometry.action")}
          </button>
          <button type="button" className="btn btn--ghost" disabled={!canImport} title={canImport ? undefined : t("calibration.import.needsRole")} onClick={() => setMode(mode === "import" ? "values" : "import")} aria-pressed={mode === "import"}>
            <Icon name="upload" tone="accent" />{t("calibration.action.import")}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void exportCsv()}>
            <Icon name="download" tone="accent" />{t("calibration.action.export")}
          </button>
        </div>
      </div>

      <p className="calib-muted calib__typehelp">{t(type === "FIB" ? "calibration.column.helpFib" : "calibration.column.helpSem")}</p>
      {!canEdit && <p className="calib-banner calib-banner--info">{t("calibration.readOnly")}</p>}
      {undocumentedShare > 0 && (
        <p className="calib-banner calib-banner--warn">
          {t("calibration.quality.undocumented", { count: fmt(undocumentedShare), total: fmt(quality?.definitions ?? 0) })}{" "}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setUndocumentedOnly(true);
              setSelection({ kind: "group", code: null });
              setMode("values");
            }}
          >
            {t("calibration.quality.show")}
          </button>
        </p>
      )}
      {notice && (
        <p className={`calib-banner calib-banner--${notice.tone === "success" ? "ok" : notice.tone === "warning" ? "warn" : "error"}`} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
          {conflict && (
            <>
              {" "}
              <button type="button" className="btn btn--ghost" onClick={() => { setConflict(false); setNotice(null); setReloadToken((n) => n + 1); }}>
                {t("calibration.save.reload")}
              </button>
            </>
          )}
        </p>
      )}

      <div className="calib__body">
        <aside className="calib__nav">
          {groups ? (
            <CalibrationTree
              groups={groups.groups}
              selection={selection}
              totals={{ definitions: groups.quality.definitions, undocumented: groups.quality.undocumented, with_values: groups.quality.with_values }}
              onSelect={(s) => {
                setSelection(s);
                setMode("values");
              }}
            />
          ) : (
            <p className="calib-muted">{t("calibration.loading")}</p>
          )}
        </aside>

        <main className="calib__main">
          {mode === "history" && equipmentId !== null && (
            <CalibrationHistory
              equipmentId={equipmentId}
              type={type}
              parameterKey={historyKey}
              role={role}
              currentRevision={profile?.revision ?? 0}
              reloadToken={reloadToken}
              onClose={() => { setMode("values"); setHistoryKey(null); }}
              onRestored={() => { setNotice({ tone: "success", text: t("calibration.history.restored") }); setReloadToken((n) => n + 1); }}
            />
          )}
          {mode === "geometry" && equipmentId !== null && (
            <ScanGeometryPanel
              equipmentId={equipmentId}
              type={type}
              role={role}
              profileRevision={profile?.revision ?? null}
              onClose={() => setMode("values")}
              onEditParameter={(key) => {
                setSelection({ kind: "group", code: null });
                setUndocumentedOnly(false);
                setAccessFilter("");
                setSearch(key.split(".").pop() ?? key);
                setMode("values");
              }}
            />
          )}
          {mode === "import" && equipmentId !== null && (
            <CalibrationImport
              equipmentId={equipmentId}
              type={type}
              onClose={() => setMode("values")}
              onImported={() => setReloadToken((n) => n + 1)}
            />
          )}
          {mode === "values" && (
            <>
              {selection.kind === "group" && (
                <div className="calib__toolbar">
                  <input
                    className="input calib__search"
                    type="search"
                    value={search}
                    placeholder={t("calibration.search.placeholder")}
                    aria-label={t("calibration.search.placeholder")}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <select className="select" value={accessFilter} aria-label={t("calibration.filter.access")} onChange={(e) => setAccessFilter(e.target.value)}>
                    <option value="">{t("calibration.filter.accessAll")}</option>
                    <option value="adjustable">{t("calibration.access.adjustable")}</option>
                    <option value="service">{t("calibration.access.service")}</option>
                    <option value="auto">{t("calibration.access.auto")}</option>
                    <option value="fixed">{t("calibration.access.fixed")}</option>
                  </select>
                  <label className="calib-check calib-switch vacuum-switch settings-switch">
                    <input type="checkbox" checked={undocumentedOnly} onChange={(e) => setUndocumentedOnly(e.target.checked)} />
                    <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
                    <span>{t("calibration.filter.undocumented")}</span>
                  </label>
                  {edits.size > 0 && (
                    <button type="button" className="btn btn--primary" disabled={!canSave} onClick={() => void save()}>
                      <Icon name="refresh" />{saving ? t("calibration.save.saving") : t("calibration.save.update")}
                    </button>
                  )}
                </div>
              )}
              {loadError && <p className="calib-row__error" role="alert">{loadError}</p>}
              {loading && !bundle && !tableData && <p className="calib-muted">{t("calibration.loading")}</p>}

              {tableData && (
                <>
                  <div className="calib-matrix__actions">
                    <button type="button" className="btn btn--primary" disabled={!canSave} onClick={() => void save()}>
                      <Icon name="refresh" />{saving ? t("calibration.save.saving") : t("calibration.save.update")}
                    </button>
                  </div>
                  <CalibrationMatrixGrid
                    data={tableData}
                    edits={edits}
                    role={role}
                    serverErrors={serverErrors}
                    resetKey={resetKey}
                    onParsed={handleParsed}
                  />
                </>
              )}

              {bundle && (
                <div className="calib-list" role="table" aria-busy={loading}>
                  <div className="calib-list__head" role="row">
                    <span role="columnheader">{t("calibration.col.parameter")}</span>
                    <span role="columnheader">{t("calibration.col.value")}</span>
                    <span role="columnheader">{t("calibration.col.unit")}</span>
                    <span role="columnheader" />
                  </div>
                  {bundle.definitions.length === 0 && <p className="calib-muted calib-list__empty">{t("calibration.list.empty")}</p>}
                  {bundle.definitions.map((def) => (
                    <CalibrationRow
                      key={def.id}
                      def={def}
                      stored={storedByKey.get(def.parameter_key)}
                      edit={edits.get(def.parameter_key)}
                      role={role}
                      isAdmin={isAdmin}
                      resetKey={resetKey}
                      serverError={serverErrors.get(def.parameter_key)}
                      parseError={parseErrors.get(def.parameter_key)}
                      onParsed={(p) => handleParsed(def.parameter_key, storedByKey.get(def.parameter_key)?.value ?? undefined, p)}
                      onRevert={() => revert(def.parameter_key)}
                      onHistory={() => { setHistoryKey(def.parameter_key); setMode("history"); }}
                      onSaveInfo={(patch) => saveInfo(def.id, patch)}
                    />
                  ))}
                  {bundle.definitions.length < (bundle.total ?? 0) && (
                    <button type="button" className="btn btn--ghost calib-list__more" disabled={loading} onClick={() => void loadMore()}>
                      {t("calibration.list.showing", { shown: fmt(bundle.definitions.length), total: fmt(bundle.total ?? 0) })} — {t("calibration.list.loadMore")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {edits.size > 0 && (
        <div className="calib-savebar" role="region" aria-label={t("calibration.save.bar")}>
          <span className="calib-savebar__count">{t("calibration.save.pending", { count: edits.size })}</span>
          <input className="input calib-savebar__reason" value={reason} maxLength={500} placeholder={t("calibration.save.reasonPlaceholder")} aria-label={t("calibration.save.reasonPlaceholder")} onChange={(e) => setReason(e.target.value)} />
          {riskyKeys.length > 0 && (
            <label className="calib-check calib-savebar__ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {t("calibration.ack.count", { count: riskyKeys.length })}
            </label>
          )}
          {parseErrors.size > 0 && <span className="calib-row__error">{t("calibration.save.invalid", { count: parseErrors.size })}</span>}
          <span className="spacer" />
          <button type="button" className="btn btn--ghost" disabled={saving} onClick={discardAll}>{t("calibration.save.discard")}</button>
          <button type="button" className="btn btn--primary" disabled={!canSave} onClick={() => void save()}>
            <Icon name="save" />{saving ? t("calibration.save.saving") : t("calibration.save.button")}
          </button>
        </div>
      )}
    </div>
  );
}
