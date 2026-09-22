import { useCallback, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { CellClickedEvent, ColDef, GetRowIdParams, ICellRendererParams } from "ag-grid-community";

import { useTranslation } from "../i18n";
import { adminGridTheme } from "../lib/agGridTheme";
import { NumberStepperInput } from "./NumberStepperField";
import { Icon } from "./Icon";

export type UserAccountsGridRow = {
  id: number | null;
  login_name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  company_name: string;
  site: string;
  role: number;
  session_lifetime_limit_days: number;
  is_active: boolean;
};

type GridRow = UserAccountsGridRow & {
  _index: number;
  _rowExistsInDb: boolean;
  _rowDirty: boolean;
  _needsAdminApproval: boolean;
};

function rowKey(row: UserAccountsGridRow, index: number): string {
  if (row.id !== null) return `id:${row.id}`;
  const login = row.login_name.trim().toLowerCase();
  return `new:${login || index}`;
}

function rowSignature(row: UserAccountsGridRow): string {
  return JSON.stringify(row);
}

function ActiveCell(params: ICellRendererParams<GridRow> & { context: { disabled: boolean; onUpdate: (index: number, field: keyof UserAccountsGridRow, value: boolean) => void; t: ReturnType<typeof useTranslation>["t"] } }) {
  const row = params.data;
  if (!row) return null;
  const { disabled, onUpdate, t } = params.context;
  return (
    <label className="settings-admin-table__check vacuum-switch settings-switch">
      <input
        type="checkbox"
        checked={row.is_active}
        disabled={disabled}
        aria-label={t("settings.admin.user.active")}
        onChange={(event) => onUpdate(row._index, "is_active", event.target.checked)}
      />
      <span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span>
    </label>
  );
}

function ActionsCell(params: ICellRendererParams<GridRow> & { context: {
  t: ReturnType<typeof useTranslation>["t"];
  canManage: boolean;
  actionDisabled: boolean;
  rowCount: number;
  onDelete: (index: number) => void;
  onBlockedAction: () => void;
  onRequestAdminApproval: (user: UserAccountsGridRow, recipients: string[]) => void;
  auditorEmails: string[];
  onEdit: (index: number) => void;
} }) {
  const row = params.data;
  if (!row) return null;
  const { t, canManage, actionDisabled, rowCount, onDelete, onBlockedAction, onRequestAdminApproval, auditorEmails, onEdit } = params.context;
  const act = (fn: () => void) => (canManage ? fn() : onBlockedAction());
  return (
    <div className="settings-admin-table__actions">
      <button type="button" className="modal__close" onClick={() => (canManage ? onEdit(row._index) : onBlockedAction())} disabled={actionDisabled} aria-disabled={!canManage} aria-label={t("settings.admin.user.edit")} title={t("settings.admin.user.edit")}>
        <Icon name="edit" tone="accent" />
      </button>
      {row._needsAdminApproval && (
        <button type="button" className="modal__close" onClick={() => onRequestAdminApproval(row, auditorEmails)} disabled={actionDisabled} aria-label={t("settings.admin.user.requestAdmin")} title={t("settings.admin.user.requestAdmin.title")}>
          <Icon name="mail" tone="accent" />
        </button>
      )}
      <button type="button" className="modal__close" onClick={() => act(() => onDelete(row._index))} disabled={actionDisabled || rowCount <= 1} aria-disabled={!canManage} aria-label={t("settings.admin.user.delete")} title={t("settings.admin.user.delete")}>
        <Icon name="trash" tone="danger" />
      </button>
    </div>
  );
}

export function UserAccountsGrid({
  users,
  sourceUsers,
  auditorEmails,
  canApproveAdminRole,
  disabled,
  actionDisabled,
  canManage,
  siteOptions,
  roleOptions,
  onUpdate,
  onDelete,
  onBlockedAction,
  onRequestAdminApproval,
  onApplyChanges,
}: {
  users: UserAccountsGridRow[];
  sourceUsers: UserAccountsGridRow[];
  auditorEmails: string[];
  canApproveAdminRole: boolean;
  disabled: boolean;
  actionDisabled: boolean;
  canManage: boolean;
  siteOptions: Array<{ value: string; label: string }>;
  roleOptions: Array<{ value: number; label: string }>;
  onUpdate: (index: number, field: keyof UserAccountsGridRow, value: string | number | boolean | null) => void;
  onDelete: (index: number) => void;
  onBlockedAction: () => void;
  onRequestAdminApproval: (user: UserAccountsGridRow, recipients: string[]) => void;
  onApplyChanges: (index: number, user: UserAccountsGridRow) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const sourceSignatureByKey = useMemo(() => new Map(sourceUsers.map((row, index) => [rowKey(row, index), rowSignature(row)] as const)), [sourceUsers]);
  const sourceRoleById = useMemo(() => new Map(sourceUsers.map((row) => [row.id, row.role] as const)), [sourceUsers]);
  const rowData = useMemo<GridRow[]>(() => users.map((row, index) => {
    const persisted = sourceSignatureByKey.get(rowKey(row, index));
    return {
      ...row,
      _index: index,
      _rowExistsInDb: persisted !== undefined,
      _rowDirty: persisted !== rowSignature(row),
      _needsAdminApproval: !canApproveAdminRole && row.role === 3 && (sourceRoleById.get(row.id) ?? 0) < 3,
    };
  }), [users, sourceRoleById, sourceSignatureByKey, canApproveAdminRole]);

  const getRowId = useCallback((params: GetRowIdParams<GridRow>) => rowKey(params.data, params.data._index), []);
  const textCol = (field: keyof UserAccountsGridRow, headerName: string, minWidth: number, flex = 1): ColDef<GridRow> => ({ field: field as any, headerName, editable: false, flex, minWidth });
  const columnDefs = useMemo<ColDef<GridRow>[]>(() => [
    { field: "id", headerName: t("settings.admin.user.id"), editable: false, width: 72, cellClass: "settings-equipment-grid__id-cell", valueFormatter: (p) => p.value == null ? "—" : String(p.value) },
    textCol("login_name", t("settings.admin.user.login"), 120, 1),
    textCol("first_name", t("settings.admin.user.firstName"), 120, 1),
    textCol("last_name", t("settings.admin.user.lastName"), 120, 1),
    { ...textCol("email", t("settings.admin.user.email"), 180, 1.4), cellEditor: "agTextCellEditor" },
    textCol("phone_number", t("settings.admin.user.phone"), 140, 1),
    textCol("company_name", t("settings.admin.user.company"), 140, 1),
    { ...textCol("site", t("settings.admin.user.site"), 120, 0.9), valueFormatter: (p) => siteOptions.find((option) => option.value === p.value)?.label ?? String(p.value ?? "") },
    { ...textCol("role", t("settings.admin.user.role"), 110, 0.9), valueFormatter: (p) => roleOptions.find((option) => option.value === Number(p.value))?.label ?? String(p.value ?? "") },
    { field: "session_lifetime_limit_days", headerName: t("settings.admin.user.sessionLifetimeDays"), editable: false, width: 110 },
    { field: "is_active", headerName: t("settings.admin.user.active"), editable: false, width: 80, cellRenderer: ActiveCell },
    { colId: "actions", headerName: t("settings.admin.user.actions"), editable: false, sortable: false, filter: false, resizable: false, width: 92, pinned: "right", cellRenderer: ActionsCell },
  ], [t, disabled, siteOptions, roleOptions]);

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState<UserAccountsGridRow | null>(null);
  const openEdit = useCallback((index: number) => {
    const row = users[index];
    if (row) { setEditingIndex(index); setEditingDraft({ ...row }); }
  }, [users]);
  const closeEdit = useCallback(() => { setEditingIndex(null); setEditingDraft(null); }, []);
  const applyEdit = useCallback(async () => {
    if (editingIndex === null || !editingDraft) return;
    await onApplyChanges(editingIndex, editingDraft);
    closeEdit();
  }, [editingDraft, editingIndex, onApplyChanges, closeEdit]);
  const context = useMemo(() => ({ t, disabled, canManage, actionDisabled, rowCount: users.length, auditorEmails, onUpdate, onDelete, onBlockedAction, onRequestAdminApproval, onEdit: openEdit }), [t, disabled, canManage, actionDisabled, users.length, auditorEmails, onUpdate, onDelete, onBlockedAction, onRequestAdminApproval, openEdit]);
  const onCellClicked = useCallback((event: CellClickedEvent<GridRow>) => { if (!canManage) onBlockedAction(); }, [canManage, onBlockedAction]);

  return <>
    <div className="settings-admin-table-wrap settings-user-grid"><AgGridReact<GridRow> theme={adminGridTheme} rowData={rowData} columnDefs={columnDefs} getRowId={getRowId} context={context} domLayout="autoHeight" suppressCellFocus onCellClicked={onCellClicked} /></div>
    {editingDraft && <UserEditDialog draft={editingDraft} setDraft={setEditingDraft} onCancel={closeEdit} onApply={applyEdit} disabled={disabled} siteOptions={siteOptions} roleOptions={roleOptions} />}
  </>;
}

function UserEditDialog({ draft, setDraft, onCancel, onApply, disabled, siteOptions, roleOptions }: { draft: UserAccountsGridRow; setDraft: (next: UserAccountsGridRow) => void; onCancel: () => void; onApply: () => void; disabled: boolean; siteOptions: Array<{ value: string; label: string }>; roleOptions: Array<{ value: number; label: string }> }) {
  const { t } = useTranslation();
  const update = <K extends keyof UserAccountsGridRow>(field: K, value: UserAccountsGridRow[K]) => setDraft({ ...draft, [field]: value });
  return <div className="user-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="modal user-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="user-edit-title">
      <div className="modal__header"><div id="user-edit-title" className="modal__title">{t("settings.admin.user.editTitle")}</div><button type="button" className="modal__close" onClick={onCancel} aria-label={t("settings.admin.user.cancel")}><Icon name="x" /></button></div>
      <div className="modal__body user-edit-dialog__body">
        <label>{t("settings.admin.user.login")}<input className="input" value={draft.login_name} disabled={disabled} onChange={(e) => update("login_name", e.target.value)} /></label>
        <label>{t("settings.admin.user.firstName")}<input className="input" value={draft.first_name} disabled={disabled} onChange={(e) => update("first_name", e.target.value)} /></label>
        <label>{t("settings.admin.user.lastName")}<input className="input" value={draft.last_name} disabled={disabled} onChange={(e) => update("last_name", e.target.value)} /></label>
        <label>{t("settings.admin.user.email")}<input className="input" type="email" value={draft.email} disabled={disabled} onChange={(e) => update("email", e.target.value)} /></label>
        <label>{t("settings.admin.user.phone")}<input className="input" type="tel" value={draft.phone_number} disabled={disabled} onChange={(e) => update("phone_number", e.target.value)} /></label>
        <label>{t("settings.admin.user.company")}<input className="input" value={draft.company_name} disabled={disabled} onChange={(e) => update("company_name", e.target.value)} /></label>
        <label>{t("settings.admin.user.site")}<select className="select" value={draft.site} disabled={disabled} onChange={(e) => update("site", e.target.value)}>{siteOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>{t("settings.admin.user.role")}<select className="select" value={draft.role} disabled={disabled} onChange={(e) => update("role", Number(e.target.value))}>{roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>{t("settings.admin.user.sessionLifetimeDays")}<NumberStepperInput value={draft.session_lifetime_limit_days} min={1} step={1} inputMode="numeric" disabled={disabled} ariaLabel={t("settings.admin.user.sessionLifetimeDays")} onValueChange={(value) => update("session_lifetime_limit_days", Math.max(1, Math.trunc(Number(value) || 1)))} /></label>
        <label className="vacuum-switch settings-switch user-edit-dialog__active"><input type="checkbox" checked={draft.is_active} disabled={disabled} onChange={(e) => update("is_active", e.target.checked)} /><span className="vacuum-switch__track"><span className="vacuum-switch__thumb" /></span><span>{t("settings.admin.user.active")}</span></label>
      </div>
      <div className="modal__footer user-edit-dialog__footer"><button type="button" className="btn btn--ghost" onClick={onCancel}>{t("settings.admin.user.cancel")}</button><button type="button" className="btn btn--primary" disabled={disabled} onClick={onApply}>{t("settings.admin.user.apply")}</button></div>
    </div>
  </div>;
}
