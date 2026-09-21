/** A table layout (aperture presets, stage servo constants, preset tables, ...) as an editable grid. */
import { useMemo } from "react";

import { useTranslation } from "../../i18n";
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

export function CalibrationMatrix({
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

  return (
    <div className="calib-matrix">
      <h4 className="calib-matrix__title">{table.label}</h4>
      {table.note && <p className="calib-matrix__note">{table.note}</p>}
      <div className="calib-matrix__scroll">
        <table className="calib-matrix__table">
          <thead>
            <tr>
              <th scope="col" className="calib-matrix__corner">
                {[table.row_header, table.col_header].filter(Boolean).join(" \\ ")}
              </th>
              {table.cols.map((col) => (
                <th key={col.key} scope="col" title={col.label}>
                  <span>{col.label}</span>
                  {col.unit && <small>{col.unit}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                {table.cols.map((col) => {
                  const cell = cellAt(lookup, row.key, col.key);
                  if (!cell) return <td key={col.key} className="calib-matrix__empty" />;
                  const edit = edits.get(cell.parameter_key);
                  const effective = edit?.kind === "set" ? edit.value : edit?.kind === "clear" ? undefined : cell.value ?? undefined;
                  const roleOk = role !== null && role >= requiredRole(cell.access_level);
                  const violation = edit?.kind === "set" ? limitViolation(cell, edit.value) : null;
                  const error = serverErrors.get(cell.parameter_key) ?? (violation ? t("calibration.limit.outside", { min: formatValue(violation.min), max: formatValue(violation.max) }) : undefined);
                  return (
                    <td
                      key={col.key}
                      data-dirty={edit ? "true" : "false"}
                      data-risk={riskReason(cell) ? "true" : "false"}
                      data-invalid={error ? "true" : "false"}
                      title={error ?? `${cell.parameter_key}${cell.unit ? ` [${cell.unit}]` : ""}`}
                    >
                      {roleOk && !cell.is_read_only ? (
                        <ValueInput
                          compact
                          valueType={cell.value_type}
                          enumOptions={cell.enum_options}
                          value={effective}
                          placeholder={cell.default_value !== null && cell.default_value !== undefined ? formatValue(cell.default_value) : undefined}
                          invalid={Boolean(error)}
                          ariaLabel={`${row.label} ${col.label}`}
                          resetKey={resetKey}
                          onChange={(parsed) => onParsed(cell.parameter_key, cell.value ?? undefined, parsed)}
                        />
                      ) : (
                        <span className="calib-readonly">{formatValue(effective) || "—"}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
