/** CONFIGURATION > ADMIN > Custom Patterns: image catalogue backed by ionbeam_asset.CustomPatterns. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { customPatternApi, type CustomPattern } from "../lib/customPatternApi";
import { adminGridTheme } from "../lib/agGridTheme";
import { Icon } from "./Icon";
import { useTranslation } from "../i18n";

type PatternRow = CustomPattern;
type GridContext = { canManage: boolean; onEdit: (row: PatternRow) => void; onDelete: (row: PatternRow) => void };

function PreviewCell({ data }: ICellRendererParams<PatternRow>) {
  return data ? <img className="custom-patterns-grid__preview" src={data.payload.data} alt={data.name} /> : null;
}

function ActionsCell(params: ICellRendererParams<PatternRow> & { context: GridContext }) {
  const row = params.data;
  if (!row) return null;
  return <div className="settings-admin-table__actions">
    <button type="button" className="modal__close" disabled={!params.context.canManage} onClick={() => params.context.onEdit(row)} aria-label={`Edit ${row.name}`} title="Edit"><Icon name="edit" tone="accent" /></button>
    <button type="button" className="modal__close" disabled={!params.context.canManage} onClick={() => params.context.onDelete(row)} aria-label={`Delete ${row.name}`} title="Delete"><Icon name="trash" tone="danger" /></button>
  </div>;
}

function readImage(file: File): Promise<CustomPattern["payload"]> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return Promise.reject(new Error("Choose a PNG, JPEG, WebP, or GIF image."));
  if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error("Images must be 10 MB or smaller."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.onload = () => typeof reader.result === "string"
      ? resolve({ mimeType: file.type, data: reader.result })
      : reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

export function CustomPatternsGrid({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PatternRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PatternRow | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PatternRow | null>(null);
  const [name, setName] = useState("");
  const [payload, setPayload] = useState<CustomPattern["payload"] | null>(null);
  const [fileName, setFileName] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try { setRows((await customPatternApi.list()).patterns); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const openEditor = (row: PatternRow | "new") => {
    setDialog(row); setName(row === "new" ? "" : row.name);
    setPayload(row === "new" ? null : row.payload); setFileName(""); setError(null);
  };
  const closeEditor = () => { if (!saving) setDialog(null); };
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    try { setPayload(await readImage(file)); setFileName(file.name); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const save = async () => {
    if (!dialog || !payload || !name.trim()) { setError("Enter a name and select an image."); return; }
    setSaving(true); setError(null);
    try {
      if (dialog === "new") await customPatternApi.create(name.trim(), payload);
      else await customPatternApi.update(dialog.id, name.trim(), payload);
      setDialog(null); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!deleteTarget) return;
    setSaving(true); setError(null);
    try { await customPatternApi.remove(deleteTarget.id); setDeleteTarget(null); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const columnDefs = useMemo<ColDef<PatternRow>[]>(() => [
    { field: "id", headerName: "ID", width: 90 },
    { field: "name", headerName: t("settings.admin.customPatterns.name"), minWidth: 180, flex: 1 },
    { colId: "preview", headerName: t("settings.admin.customPatterns.image"), width: 130, sortable: false, filter: false, cellRenderer: PreviewCell },
    { colId: "actions", headerName: t("settings.admin.customPatterns.actions"), width: 100, pinned: "right", sortable: false, filter: false, resizable: false, cellRenderer: ActionsCell },
  ], [t]);
  const context = useMemo<GridContext>(() => ({ canManage, onEdit: openEditor, onDelete: setDeleteTarget }), [canManage]);

  return <>
    <div className="settings-form__group-row">
      <h4 className="settings-form__group">{t("settings.admin.group.customPatterns")}</h4>
      <button type="button" className="btn btn--primary" disabled={!canManage || saving} onClick={() => openEditor("new")} aria-label={t("settings.admin.customPatterns.add")} title={t("settings.admin.customPatterns.add")}>
        <Icon name="plus" /> {t("settings.admin.customPatterns.add")}
      </button>
    </div>
    {error && !dialog && <p role="alert" className="settings-form__hint" style={{ color: "var(--c-danger)" }}>{error}</p>}
    {loading ? <p className="settings-form__hint">{t("settings.admin.customPatterns.loading")}</p> : <div className="settings-admin-table-wrap custom-patterns-grid">
      <AgGridReact<PatternRow> theme={adminGridTheme} rowData={rows} columnDefs={columnDefs} context={context} getRowId={({ data }) => String(data.id)} domLayout="autoHeight" suppressCellFocus />
    </div>}

    {dialog && <div className="equipment-edit-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) closeEditor(); }}>
      <div className="modal custom-pattern-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="custom-pattern-edit-title">
        <div className="modal__header"><div id="custom-pattern-edit-title" className="modal__title">{dialog === "new" ? t("settings.admin.customPatterns.addTitle") : t("settings.admin.customPatterns.editTitle")}</div><button type="button" className="modal__close" onClick={closeEditor} aria-label={t("settings.admin.customPatterns.cancel")}><Icon name="x" /></button></div>
        <div className="modal__body custom-pattern-edit-dialog__body">
          {error && <p role="alert" className="settings-form__hint" style={{ color: "var(--c-danger)" }}>{error}</p>}
          <label>{t("settings.admin.customPatterns.name")}<input className="input" value={name} maxLength={160} disabled={saving} onChange={e => setName(e.target.value)} /></label>
          <label>{t("settings.admin.customPatterns.upload")}<input className="input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={saving} onChange={e => void chooseFile(e.target.files?.[0])} /></label>
          <span className="settings-form__hint">{fileName || (payload ? t("settings.admin.customPatterns.currentImage") : t("settings.admin.customPatterns.imageRequired"))}</span>
          {payload && <img className="custom-pattern-edit-dialog__preview" src={payload.data} alt={name || t("settings.admin.customPatterns.preview")} />}
        </div>
        <div className="modal__footer"><button type="button" className="btn btn--cancel" onClick={closeEditor}>{t("settings.admin.customPatterns.cancel")}</button><button type="button" className="btn btn--primary" disabled={saving || !canManage} onClick={() => void save()}>{saving ? t("settings.admin.customPatterns.saving") : t("settings.admin.customPatterns.save")}</button></div>
      </div>
    </div>}
    {deleteTarget && <div className="equipment-edit-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !saving) setDeleteTarget(null); }}>
      <div className="modal custom-pattern-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="custom-pattern-delete-title">
        <div className="modal__header"><div id="custom-pattern-delete-title" className="modal__title">{t("settings.admin.customPatterns.deleteTitle")}</div></div>
        <div className="modal__body">{t("settings.admin.customPatterns.deleteConfirm", { name: deleteTarget.name })}</div>
        <div className="modal__footer"><button type="button" className="btn btn--cancel" disabled={saving} onClick={() => setDeleteTarget(null)}>{t("settings.admin.customPatterns.cancel")}</button><button type="button" className="btn btn--warn" disabled={saving} onClick={() => void remove()}>{saving ? t("settings.admin.customPatterns.saving") : t("settings.admin.customPatterns.delete")}</button></div>
      </div>
    </div>}
  </>;
}
