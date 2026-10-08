/** Admin > Equipment grid and row editor. */
import { useCallback, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { CellClickedEvent, ColDef, GetRowIdParams, ICellRendererParams } from "ag-grid-community";

import { useTranslation } from "../i18n";
import { adminGridTheme } from "../lib/agGridTheme";
import { equipmentRowKey, type EquipmentRow } from "../lib/equipmentModel";
import { Icon } from "./Icon";

type EquipmentGridRow = EquipmentRow & { _index: number };

type EquipmentGridContext = {
  t: ReturnType<typeof useTranslation>["t"];
  canManage: boolean;
  actionDisabled: boolean;
  rowCount: number;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
  onBlockedAction: () => void;
};

function EquipmentActionsCell(params: ICellRendererParams<EquipmentGridRow> & { context: EquipmentGridContext }) {
  const row = params.data;
  if (!row) return null;
  const { t, canManage, actionDisabled, rowCount, onEdit, onDelete, onBlockedAction } = params.context;

  return (
    <div className="settings-admin-table__actions">
      <button
        type="button"
        className="modal__close"
        onClick={() => (canManage ? onEdit(row._index) : onBlockedAction())}
        disabled={actionDisabled}
        aria-disabled={!canManage}
        aria-label={t("settings.admin.equipment.edit")}
        title={t("settings.admin.equipment.edit")}
      >
        <Icon name="edit" tone="accent" />
      </button>
      <button
        type="button"
        className="modal__close"
        onClick={() => (canManage ? onDelete(row._index) : onBlockedAction())}
        disabled={actionDisabled || rowCount <= 1}
        aria-disabled={!canManage}
        aria-label={t("settings.admin.equipment.delete")}
        title={t("settings.admin.equipment.delete")}
      >
        <Icon name="trash" tone="danger" />
      </button>
    </div>
  );
}

export function EquipmentGrid({
  equipment,
  disabled,
  actionDisabled,
  canManage,
  onDelete,
  onApplyEdit,
  onBlockedAction,
}: {
  equipment: EquipmentRow[];
  disabled: boolean;
  actionDisabled: boolean;
  canManage: boolean;
  onDelete: (index: number) => void;
  onApplyEdit: (index: number, row: EquipmentRow) => void | Promise<void>;
  onBlockedAction: () => void;
}) {
  const { t } = useTranslation();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState<EquipmentRow | null>(null);
  const rowData = useMemo<EquipmentGridRow[]>(() => equipment.map((row, index) => ({ ...row, _index: index })), [equipment]);

  const openEdit = useCallback((index: number) => {
    const row = equipment[index];
    if (row) {
      setEditingIndex(index);
      setEditingDraft({ ...row });
    }
  }, [equipment]);
  const closeEdit = useCallback(() => {
    setEditingIndex(null);
    setEditingDraft(null);
  }, []);
  const applyEdit = useCallback(async () => {
    if (editingIndex === null || !editingDraft) return;
    await onApplyEdit(editingIndex, editingDraft);
    closeEdit();
  }, [editingDraft, editingIndex, onApplyEdit, closeEdit]);

  const getRowId = useCallback(
    (params: GetRowIdParams<EquipmentGridRow>) => equipmentRowKey(params.data, params.data._index),
    [],
  );
  const columnDefs = useMemo<ColDef<EquipmentGridRow>[]>(() => [
    {
      field: "id",
      headerName: t("settings.admin.equipment.id"),
      editable: false,
      width: 90,
      cellClass: "settings-equipment-grid__id-cell",
      valueFormatter: (p) => (p.value === null || p.value === undefined ? "—" : String(p.value)),
    },
    { field: "name", headerName: t("settings.admin.equipment.name"), editable: false, width: 150 },
    { field: "model", headerName: t("settings.admin.equipment.model"), editable: false, width: 140 },
    { field: "site", headerName: t("settings.admin.equipment.site"), editable: false, width: 150 },
    { field: "equipment_code", headerName: t("settings.admin.equipment.equipmentCode"), editable: false, width: 190 },
    { field: "host_computer_model", headerName: t("settings.admin.equipment.hostComputerModel"), editable: false, width: 240 },
    { field: "motherboard_model", headerName: t("settings.admin.equipment.motherboardModel"), editable: false, width: 220 },
    { field: "windows_version", headerName: t("settings.admin.equipment.windowsVersion"), editable: false, width: 180 },
    { field: "software_version", headerName: t("settings.admin.equipment.softwareVersion"), editable: false, width: 180 },
    { field: "coreco_processing_card", headerName: t("settings.admin.equipment.corecoProcessingCard"), editable: false, width: 220 },
    { field: "description", headerName: t("settings.admin.equipment.description"), editable: false, width: 220 },
    {
      colId: "actions",
      headerName: t("settings.admin.equipment.actions"),
      editable: false,
      sortable: false,
      filter: false,
      resizable: false,
      width: 92,
      pinned: "right",
      cellRenderer: EquipmentActionsCell,
    },
  ], [t]);

  const context = useMemo<EquipmentGridContext>(() => ({
    t,
    canManage,
    actionDisabled,
    rowCount: equipment.length,
    onEdit: openEdit,
    onDelete,
    onBlockedAction,
  }), [t, canManage, actionDisabled, equipment.length, openEdit, onDelete, onBlockedAction]);
  const handleCellClicked = useCallback((event: CellClickedEvent<EquipmentGridRow>) => {
    if (!canManage) onBlockedAction();
  }, [canManage, onBlockedAction]);

  return <>
    <div className="settings-admin-table-wrap settings-equipment-grid">
      <AgGridReact<EquipmentGridRow>
        theme={adminGridTheme}
        rowData={rowData}
        columnDefs={columnDefs}
        getRowId={getRowId}
        context={context}
        domLayout="normal"
        alwaysShowHorizontalScroll
        alwaysShowVerticalScroll
        suppressCellFocus={disabled}
        onCellClicked={handleCellClicked}
      />
    </div>
    {editingDraft && (
      <EquipmentEditDialog
        draft={editingDraft}
        setDraft={setEditingDraft}
        onCancel={closeEdit}
        onApply={() => void applyEdit()}
        disabled={disabled || actionDisabled}
      />
    )}
  </>;
}

function EquipmentEditDialog({ draft, setDraft, onCancel, onApply, disabled }: {
  draft: EquipmentRow;
  setDraft: (next: EquipmentRow) => void;
  onCancel: () => void;
  onApply: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const update = <K extends keyof EquipmentRow>(field: K, value: EquipmentRow[K]) => setDraft({ ...draft, [field]: value });
  return (
    <div className="equipment-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="modal equipment-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="equipment-edit-title">
        <div className="modal__header">
          <div id="equipment-edit-title" className="modal__title">{t("settings.admin.equipment.editTitle")}</div>
          <button type="button" className="modal__close" onClick={onCancel} aria-label={t("settings.admin.equipment.cancel")}><Icon name="x" /></button>
        </div>
        <div className="modal__body equipment-edit-dialog__body">
          <label>{t("settings.admin.equipment.id")}<input className="input" value={draft.id ?? ""} disabled readOnly /></label>
          <label>{t("settings.admin.equipment.name")}<input className="input" value={draft.name} maxLength={100} disabled={disabled} onChange={(e) => update("name", e.target.value)} /></label>
          <label>{t("settings.admin.equipment.model")}<input className="input" value={draft.model} maxLength={100} disabled={disabled} onChange={(e) => update("model", e.target.value)} /></label>
          <label>{t("settings.admin.equipment.serial")}<input className="input" value={draft.serial_number} maxLength={100} disabled={disabled} onChange={(e) => update("serial_number", e.target.value)} /></label>
          <label>{t("settings.admin.equipment.site")}<input className="input" value={draft.site} maxLength={50} disabled={disabled} onChange={(e) => update("site", e.target.value)} /></label>
          <label>{t("settings.admin.equipment.equipmentCode")}<input className="input" value={draft.equipment_code} maxLength={1000} disabled={disabled} onChange={(e) => update("equipment_code", e.target.value)} /></label>
          <label>{t("settings.admin.equipment.hostComputerModel")}<input className="input" value={draft.host_computer_model} maxLength={1000} disabled={disabled} onChange={(e) => update("host_computer_model", e.target.value)} /></label>
          <label>{t("settings.admin.equipment.motherboardModel")}<input className="input" value={draft.motherboard_model} maxLength={1000} disabled={disabled} onChange={(e) => update("motherboard_model", e.target.value)} /></label>
          <label>{t("settings.admin.equipment.windowsVersion")}<input className="input" value={draft.windows_version} maxLength={1000} disabled={disabled} onChange={(e) => update("windows_version", e.target.value)} /></label>
          <label>{t("settings.admin.equipment.softwareVersion")}<input className="input" value={draft.software_version} maxLength={1000} disabled={disabled} onChange={(e) => update("software_version", e.target.value)} /></label>
          <label>{t("settings.admin.equipment.corecoProcessingCard")}<input className="input" value={draft.coreco_processing_card} maxLength={1000} disabled={disabled} onChange={(e) => update("coreco_processing_card", e.target.value)} /></label>
          <label className="equipment-edit-dialog__description">{t("settings.admin.equipment.description")}<textarea className="input" rows={3} maxLength={1000} value={draft.description} disabled={disabled} onChange={(e) => update("description", e.target.value)} /></label>
        </div>
        <div className="modal__footer equipment-edit-dialog__footer">
          <button type="button" className="btn btn--cancel" onClick={onCancel}>{t("settings.admin.equipment.cancel")}</button>
          <button type="button" className="btn btn--primary" disabled={disabled} onClick={onApply}>{t("settings.admin.equipment.apply")}</button>
        </div>
      </div>
    </div>
  );
}
