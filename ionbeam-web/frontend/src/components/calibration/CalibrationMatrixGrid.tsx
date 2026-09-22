/**
 * A table layout (aperture presets, stage servo constants, preset tables, ...) as an AG Grid.
 *
 * Cells stay "always editable" widgets (the same ValueInput used before) rendered through a custom
 * cellRenderer, rather than AG Grid's own click-to-edit cell editors: each cell needs typed parsing,
 * per-cell limit/risk checks and role gating that already live in lib/calibrationModel, and reusing that
 * logic through a cellRenderer is far lower-risk than re-deriving it against AG Grid's editor API. AG Grid
 * itself is only responsible for the grid mechanics here: virtualized rows/columns, the pinned row-header
 * column and resizing, for potentially wide preset tables.
 */
import { useCallback, useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, ICellRendererParams } from "ag-grid-community";

import { useTranslation } from "../../i18n";
import { adminGridTheme } from "../../lib/agGridTheme";
import {
  cellAt,
  cellLookup,
  formatValue,
  limitViolation,
  requiredRole,
  riskReason,
  type ParseResult,
} from "../../lib/calibrationModel";
import type { CalibrationEdit, CalibrationTableResponse } from "../../types/calibration";
import { ValueInput } from "./ValueInput";

type MatrixRow = { key: string; label: string; role?: string | null };

function MatrixCell(
  params: ICellRendererParams<MatrixRow> & {
    colDef: { colId?: string };
    colLabel: string;
    context: {
      t: ReturnType<typeof useTranslation>["t"];
      lookup: Map<string, ReturnType<typeof cellAt>>;
      edits: Map<string, CalibrationEdit>;
      role: number | null;
      serverErrors: Map<string, string>;
      resetKey: number;
      onParsed: (key: string, stored: unknown, parsed: ParseResult) => void;
    };
  },
) {
  const row = params.data;
  const colKey = params.colDef.colId;
  if (!row || !colKey) return null;
  const { t, lookup, edits, role, serverErrors, resetKey, onParsed } = params.context;
  const colLabel = params.colLabel;
  const cell = cellAt(lookup as Map<string, NonNullable<ReturnType<typeof cellAt>>>, row.key, colKey);
  if (!cell) return null;

  const edit = edits.get(cell.parameter_key);
  const effective = edit?.kind === "set" ? edit.value : edit?.kind === "clear" ? undefined : cell.value ?? undefined;
  const roleOk = role !== null && role >= requiredRole(cell.access_level);
  const violation = edit?.kind === "set" ? limitViolation(cell, edit.value) : null;
  const error =
    serverErrors.get(cell.parameter_key) ??
    (violation ? t("calibration.limit.outside", { min: formatValue(violation.min), max: formatValue(violation.max) }) : undefined);

  return roleOk && !cell.is_read_only ? (
    <ValueInput
      compact
      valueType={cell.value_type}
      enumOptions={cell.enum_options}
      value={effective}
      placeholder={cell.default_value !== null && cell.default_value !== undefined ? formatValue(cell.default_value) : undefined}
      invalid={Boolean(error)}
      ariaLabel={`${row.label} ${colLabel}`}
      resetKey={resetKey}
      onChange={(parsed) => onParsed(cell.parameter_key, cell.value ?? undefined, parsed)}
    />
  ) : (
    <span className="calib-readonly" title={error ?? `${cell.parameter_key}${cell.unit ? ` [${cell.unit}]` : ""}`}>
      {formatValue(effective) || "—"}
    </span>
  );
}

export function CalibrationMatrixGrid({
  data,
  edits,
  role,
  serverErrors,
  resetKey,
  onParsed,
}: {
  data: CalibrationTableResponse;
  edits: Map<string, CalibrationEdit>;
  role: number | null;
  serverErrors: Map<string, string>;
  resetKey: number;
  onParsed: (key: string, stored: unknown, parsed: ParseResult) => void;
}) {
  const { t } = useTranslation();
  const lookup = useMemo(() => cellLookup(data.cells), [data.cells]);
  const { table } = data;

  const getRowId = useCallback((params: GetRowIdParams<MatrixRow>) => params.data.key, []);

  const columnDefs = useMemo<ColDef<MatrixRow>[]>(() => {
    const rowHeaderLabel = [table.row_header, table.col_header].filter(Boolean).join(" \\ ");
    const cols: ColDef<MatrixRow>[] = [
      {
        colId: "__row_header",
        headerName: rowHeaderLabel,
        pinned: "left",
        editable: false,
        sortable: false,
        filter: false,
        resizable: true,
        minWidth: 140,
        cellClass: "calib-matrix-grid__row-header",
        valueGetter: (p) => p.data?.label ?? "",
      },
    ];
    for (const col of table.cols) {
      cols.push({
        colId: col.key,
        headerName: col.unit ? `${col.label} (${col.unit})` : col.label,
        editable: false,
        sortable: false,
        filter: false,
        resizable: true,
        minWidth: 92,
        width: 110,
        cellRenderer: MatrixCell,
        cellRendererParams: { colLabel: col.label },
        cellClass: (p) => {
          const cell = cellAt(lookup, p.data?.key ?? "", col.key);
          if (!cell) return "calib-matrix-grid__cell--empty";
          const edit = edits.get(cell.parameter_key);
          const violation = edit?.kind === "set" ? limitViolation(cell, edit.value) : null;
          const invalid = Boolean(serverErrors.get(cell.parameter_key) ?? (violation ? "invalid" : undefined));
          const classes = ["calib-matrix-grid__cell"];
          if (edit) classes.push("calib-matrix-grid__cell--dirty");
          if (invalid) classes.push("calib-matrix-grid__cell--invalid");
          if (riskReason(cell)) classes.push("calib-matrix-grid__cell--risk");
          return classes;
        },
      });
    }
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, lookup, edits, serverErrors]);

  const context = useMemo(
    () => ({ t, lookup, edits, role, serverErrors, resetKey, onParsed }),
    [t, lookup, edits, role, serverErrors, resetKey, onParsed],
  );

  return (
    <div className="calib-matrix">
      <h4 className="calib-matrix__title">{table.label}</h4>
      {table.note && <p className="calib-matrix__note">{table.note}</p>}
      <div className="calib-matrix-grid">
        <AgGridReact<MatrixRow>
          theme={adminGridTheme}
          rowData={table.rows}
          columnDefs={columnDefs}
          getRowId={getRowId}
          context={context}
          domLayout="normal"
          rowHeight={32}
          headerHeight={40}
          suppressCellFocus
          getContextMenuItems={() => []}
        />
      </div>
    </div>
  );
}