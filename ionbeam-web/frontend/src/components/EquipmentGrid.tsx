/**
 * Admin > Equipment: the equipment matrix, rendered with AG Grid instead of the hand-rolled CSS table.
 *
 * `id` is a database-assigned primary key (see fn_upsert_equipment on the backend) so it is shown read-only,
 * never as an editable control — letting someone hand-edit a row's id previously risked silently repointing
 * that row at a different database record.
 *
 * Persistence here is document-level, not per-row: "Update"/"Save" both call the same onPersist(index), which
 * saves the whole equipment list as one settings document (see onSave() in SettingsDialog). The icon shown
 * (refresh vs. save) only reflects whether this particular row already exists in the persisted source.
 */
import { useCallback, useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  CellClickedEvent,
  ColDef,
  GetRowIdParams,
  ICellRendererParams,
} from "ag-grid-community";

import { useTranslation } from "../i18n";
import { adminGridTheme } from "../lib/agGridTheme";
import {
  equipmentRowKey,
  equipmentRowSignature,
  type EquipmentRow,
} from "../lib/equipmentModel";
import { Icon } from "./Icon";

type EquipmentGridRow = EquipmentRow & {
  _index: number;
  _rowExistsInDb: boolean;
  _rowDirty: boolean;
};

function EquipmentActionsCell(
  params: ICellRendererParams<EquipmentGridRow> & {
    context: {
      t: ReturnType<typeof useTranslation>["t"];
      canManage: boolean;
      actionDisabled: boolean;
      rowCount: number;
      onPersist: (index: number) => void;
      onDelete: (index: number) => void;
      onBlockedAction: () => void;
    };
  },
) {
  const row = params.data;
  if (!row) return null;
  const { t, canManage, actionDisabled, rowCount, onPersist, onDelete, onBlockedAction } = params.context;

  return (
    <div className="settings-admin-table__actions">
      {row._rowExistsInDb ? (
        <button
          type="button"
          className="modal__close"
          onClick={() => (canManage ? onPersist(row._index) : onBlockedAction())}
          disabled={actionDisabled || !row._rowDirty}
          aria-disabled={!canManage}
          aria-label={t("settings.admin.equipment.update")}
          title={t("settings.admin.equipment.update")}
        >
          <Icon name="refresh" tone="accent" />
        </button>
      ) : (
        <button
          type="button"
          className="modal__close"
          onClick={() => (canManage ? onPersist(row._index) : onBlockedAction())}
          disabled={actionDisabled}
          aria-disabled={!canManage}
          aria-label={t("settings.admin.equipment.save")}
          title={t("settings.admin.equipment.save")}
        >
          <Icon name="save" tone="success" />
        </button>
      )}
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
  sourceEquipment,
  disabled,
  actionDisabled,
  canManage,
  onUpdate,
  onPersist,
  onDelete,
  onBlockedAction,
}: {
  equipment: EquipmentRow[];
  sourceEquipment: EquipmentRow[];
  disabled: boolean;
  actionDisabled: boolean;
  canManage: boolean;
  onUpdate: (index: number, field: keyof EquipmentRow, value: string | number | null) => void;
  onPersist: (index: number) => void;
  onDelete: (index: number) => void;
  onBlockedAction: () => void;
}) {
  const { t } = useTranslation();

  const rowData = useMemo<EquipmentGridRow[]>(() => {
    const sourceSignatureByKey = new Map(
      sourceEquipment.map((row, index) => [equipmentRowKey(row, index), equipmentRowSignature(row)] as const),
    );
    return equipment.map((row, index) => {
      const persistedSignature = sourceSignatureByKey.get(equipmentRowKey(row, index));
      return {
        ...row,
        _index: index,
        _rowExistsInDb: persistedSignature !== undefined,
        _rowDirty: persistedSignature !== equipmentRowSignature(row),
      };
    });
  }, [equipment, sourceEquipment]);

  const getRowId = useCallback(
    (params: GetRowIdParams<EquipmentGridRow>) => equipmentRowKey(params.data, params.data._index),
    [],
  );

  const columnDefs = useMemo<ColDef<EquipmentGridRow>[]>(
    () => [
      {
        field: "id",
        headerName: t("settings.admin.equipment.id"),
        editable: false,
        width: 90,
        cellClass: "settings-equipment-grid__id-cell",
        valueFormatter: (p) => (p.value === null || p.value === undefined ? "—" : String(p.value)),
      },
      {
        field: "name",
        headerName: t("settings.admin.equipment.name"),
        editable: !disabled,
        flex: 1.2,
        minWidth: 120,
        cellEditorParams: { maxLength: 100 },
      },
      {
        field: "model",
        headerName: t("settings.admin.equipment.model"),
        editable: !disabled,
        flex: 1,
        minWidth: 100,
        cellEditorParams: { maxLength: 100 },
      },
      {
        field: "serial_number",
        headerName: t("settings.admin.equipment.serial"),
        editable: !disabled,
        flex: 1,
        minWidth: 110,
        cellEditorParams: { maxLength: 15 },
      },
      {
        field: "site",
        headerName: t("settings.admin.equipment.site"),
        editable: !disabled,
        flex: 0.8,
        minWidth: 90,
        cellEditorParams: { maxLength: 50 },
      },
      {
        field: "description",
        headerName: t("settings.admin.equipment.description"),
        editable: !disabled,
        flex: 2,
        minWidth: 160,
        cellEditorParams: { maxLength: 1000 },
      },
      {
        colId: "actions",
        headerName: t("settings.admin.equipment.actions"),
        editable: false,
        sortable: false,
        filter: false,
        resizable: false,
        width: 100,
        pinned: "right",
        cellRenderer: EquipmentActionsCell,
      },
    ],
    [t, disabled],
  );

  const context = useMemo(
    () => ({
      t,
      canManage,
      actionDisabled,
      rowCount: equipment.length,
      onPersist,
      onDelete,
      onBlockedAction,
    }),
    [t, canManage, actionDisabled, equipment.length, onPersist, onDelete, onBlockedAction],
  );

  const handleCellClicked = useCallback(
    (event: CellClickedEvent<EquipmentGridRow>) => {
      if (!canManage) onBlockedAction();
    },
    [canManage, onBlockedAction],
  );

  const handleCellValueChanged = useCallback(
    (event: { data: EquipmentGridRow; colDef: ColDef<EquipmentGridRow>; newValue: unknown }) => {
      const field = event.colDef.field as keyof EquipmentRow | undefined;
      if (!field || field === "id") return;
      onUpdate(event.data._index, field, event.newValue as string);
    },
    [onUpdate],
  );

  return (
    <div className="settings-admin-table-wrap settings-equipment-grid">
      <AgGridReact<EquipmentGridRow>
        theme={adminGridTheme}
        rowData={rowData}
        columnDefs={columnDefs}
        getRowId={getRowId}
        context={context}
        domLayout="autoHeight"
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        suppressCellFocus={disabled}
        onCellClicked={handleCellClicked}
        onCellValueChanged={handleCellValueChanged}
      />
    </div>
  );
}