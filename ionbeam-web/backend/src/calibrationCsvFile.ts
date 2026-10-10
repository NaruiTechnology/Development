/**
 * Parser + validator for the calibration CSV, i.e. the file that *Export CSV* writes
 * (calibration_<equipmentId>_<FIB|SEM>_r<revision>.csv, see bundleToCsv() in calibrationRoutes.ts).
 *
 *   parameter_key,vendor_name,category,display_name,value,unit,value_type,access_level,...
 *
 * Only `parameter_key` and `value` are read; every other column is informational and may be edited or dropped. Like the
 * vendor parsers this module only checks the *shape* of the file. Whether a key exists in the catalog, whether the value
 * fits the parameter's type / enum / limits, and who may change it are decided by fn_import_equipment_calibration().
 *
 * Structural problems (broken quoting, rows with the wrong number of cells, missing columns, duplicate keys with different
 * values, formula-looking values, a file exported from the other column ...) make the whole file invalid: the caller gets
 * every problem with its line number instead of a partial import. Softer findings come back as warnings.
 */

export type CalibrationCsvType = "FIB" | "SEM";

export interface CalibrationCsvItem {
  parameter_key: string;
  raw: string;
}

export interface CalibrationCsvIssue {
  /** 1-based physical line in the file (the header is line 1) */
  line: number;
  code: string;
  message: string;
  parameter_key?: string;
}

export interface ParsedCalibrationCsv {
  format: "csv";
  items: CalibrationCsvItem[];
  /** data rows (header and blank rows not counted) */
  rows: number;
  lines: number;
  delimiter: "," | ";" | "\t";
  /** rows whose value cell is empty: import never clears a stored value */
  skippedEmpty: number;
  warnings: CalibrationCsvIssue[];
  /** parameter_key -> line, to point the database's per-parameter findings at a line of the file */
  lineOfKey: Map<string, number>;
  /** what the file name says, when it follows the export naming */
  fileEquipmentId: number | null;
  fileType: CalibrationCsvType | null;
  fileRevision: number | null;
}

export class CalibrationCsvError extends Error {
  constructor(
    message: string,
    readonly issues: CalibrationCsvIssue[],
    readonly totalIssues: number,
  ) {
    super(message);
    this.name = "CalibrationCsvError";
  }
}

export const CSV_REQUIRED_COLUMNS = ["parameter_key", "value"] as const;
export const CSV_MAX_ROWS = 20_000;
const MAX_VALUE_CHARS = 4000;
const MAX_REPORTED_ISSUES = 50;
const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.#-]{0,199}$/;
const EXPORT_NAME = /calibration_(\d+)_(FIB|SEM)_r(\d+)/i;
/** a cell a spreadsheet would run as a formula; numbers like -5 or +1e3 are fine */
const FORMULA = /^(?:[=@]|[+-](?![0-9.]))/;
const DECIMAL_COMMA = /^[+-]?\d+,\d+(?:[eE][+-]?\d+)?$/;

/** True when the upload should be read as a calibration CSV rather than a vendor text file. */
export function isCalibrationCsv(fileName: string | undefined, text: string): boolean {
  if (fileName && /\.csv$/i.test(fileName.trim())) return true;
  const first = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  return /^\s*"?'?parameter_key"?\s*[,;\t]/i.test(first);
}

/** What an export file name says about its origin, e.g. calibration_3_SEM_r12.csv -> { 3, SEM, 12 }. */
export function exportNameInfo(fileName: string | undefined): { equipmentId: number; type: CalibrationCsvType; revision: number } | null {
  const m = EXPORT_NAME.exec(fileName ?? "");
  if (!m) return null;
  return { equipmentId: Number(m[1]), type: m[2].toUpperCase() as CalibrationCsvType, revision: Number(m[3]) };
}

type Row = { line: number; cells: string[] };

/**
 * RFC 4180 tokenizer. Quoted cells may contain the delimiter, doubled quotes and line breaks. Returns rows with the
 * physical line they start on; structural errors (unterminated quote, text after a closing quote, a quote inside an
 * unquoted cell) are reported, not repaired.
 */
export function tokenizeCsv(text: string, delimiter: string): { rows: Row[]; errors: CalibrationCsvIssue[]; lines: number } {
  const rows: Row[] = [];
  const errors: CalibrationCsvIssue[] = [];
  let cells: string[] = [];
  let cell = "";
  let line = 1;
  let rowLine = 1;
  let quoted = false; // inside a quoted cell
  let wasQuoted = false; // current cell was a quoted one (only whitespace may follow the closing quote)
  let quoteLine = 0;
  let badRow = false;

  const endCell = () => {
    cells.push(wasQuoted ? cell : cell.trim());
    cell = "";
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    if (!badRow) rows.push({ line: rowLine, cells });
    cells = [];
    badRow = false;
    rowLine = line;
  };
  const fail = (code: string, message: string) => {
    if (!badRow) errors.push({ line, code, message });
    badRow = true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        if (ch !== "\r" || text[i + 1] !== "\n") cell += ch;
      }
      continue;
    }
    if (ch === delimiter) {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      endRow();
    } else if (ch === '"') {
      if (cell.trim() === "" && !wasQuoted) {
        quoted = true;
        wasQuoted = true;
        quoteLine = line;
        cell = "";
      } else {
        fail("quote_in_cell", 'a double quote inside an unquoted cell - quote the whole cell and double the inner quote ("")');
        cell += ch;
      }
    } else if (wasQuoted) {
      if (!/\s/.test(ch)) fail("text_after_quote", "text after the closing quote of a cell - is a delimiter missing?");
    } else {
      cell += ch;
    }
  }
  if (quoted) {
    errors.push({ line: quoteLine, code: "unterminated_quote", message: "a quoted cell is never closed - the rest of the file would be read as one value" });
  } else if (cell !== "" || cells.length > 0 || wasQuoted) {
    endRow();
  }
  return { rows, errors, lines: line };
}

/** The delimiter the header line uses: Excel writes ';' (and decimal commas) in many locales, some tools write tabs. */
export function detectDelimiter(headerLine: string): "," | ";" | "\t" {
  const count = (d: string) => {
    let n = 0;
    let q = false;
    for (const ch of headerLine) {
      if (ch === '"') q = !q;
      else if (!q && ch === d) n++;
    }
    return n;
  };
  const candidates: Array<"," | ";" | "\t"> = [",", ";", "\t"];
  let best: "," | ";" | "\t" = ",";
  let bestCount = 0;
  for (const d of candidates) {
    const n = count(d);
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

function normaliseHeader(cell: string): string {
  return cell.replace(/^'(?=[=+\-@])/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Undo csvCell()'s formula neutralisation of text columns ('=... -> =...). */
function unneutralise(cell: string): string {
  return /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;
}

/**
 * Parse and validate a calibration CSV for import into `target`. Throws CalibrationCsvError listing every structural
 * problem (up to 50, with the total) when the file cannot be imported as a whole.
 */
export function parseCalibrationCsv(
  text: string,
  target: { fileName?: string; equipmentId?: number; type?: CalibrationCsvType } = {},
): ParsedCalibrationCsv {
  const errors: CalibrationCsvIssue[] = [];
  const warnings: CalibrationCsvIssue[] = [];
  const fail = (issue: CalibrationCsvIssue) => errors.push(issue);
  const raise = (): never => {
    const shown = errors.slice(0, MAX_REPORTED_ISSUES);
    const head =
      errors.length === 1 ? errors[0].message : `the calibration CSV has ${errors.length} problems; nothing was imported`;
    throw new CalibrationCsvError(errors.length === 1 ? `line ${errors[0].line}: ${head}` : head, shown, errors.length);
  };

  const body = text.replace(/^\uFEFF/, "");
  if (!body.trim()) {
    fail({ line: 1, code: "empty_file", message: "the file is empty" });
    raise();
  }
  if (body.includes("\u0000")) {
    fail({ line: 1, code: "binary_file", message: "the file contains binary data - save it as CSV (UTF-8), not as a workbook" });
    raise();
  }

  // ---- file name: an export of the other column cannot be imported here --------------------------------------------------
  const nameInfo = exportNameInfo(target.fileName);
  if (nameInfo && target.type && nameInfo.type !== target.type) {
    fail({
      line: 1,
      code: "wrong_type",
      message: `the file name says this is a ${nameInfo.type} export, but you are importing into the ${target.type} column - switch the column or pick the ${target.type} file`,
    });
    raise();
  }
  if (nameInfo && target.equipmentId !== undefined && nameInfo.equipmentId !== target.equipmentId) {
    warnings.push({
      line: 1,
      code: "other_equipment",
      message: `the file name says it was exported from equipment #${nameInfo.equipmentId}; it will be imported into equipment #${target.equipmentId}`,
    });
  }

  // ---- header ---------------------------------------------------------------------------------------------------------------
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const { rows, errors: tokenErrors, lines } = tokenizeCsv(body, delimiter);
  errors.push(...tokenErrors);

  const header = rows.shift();
  if (!header || header.line !== 1) {
    fail({ line: 1, code: "missing_header", message: `the first line must be the header (${CSV_REQUIRED_COLUMNS.join(", ")}, ...)` });
    raise();
  }
  const columns = header!.cells.map(normaliseHeader);
  const seen = new Map<string, number>();
  columns.forEach((name, index) => {
    if (!name) return;
    if (seen.has(name)) {
      fail({ line: 1, code: "duplicate_column", message: `column "${name}" appears twice in the header (columns ${seen.get(name)! + 1} and ${index + 1})` });
    } else {
      seen.set(name, index);
    }
  });
  const missing = CSV_REQUIRED_COLUMNS.filter((c) => !seen.has(c));
  if (missing.length > 0) {
    const hint =
      columns.length <= 1 && firstLine.length > 0
        ? " - is the file separated by commas (or ';' / tabs)?"
        : " - export the file with Export CSV and edit only the value column";
    fail({ line: 1, code: "missing_column", message: `the header has no ${missing.map((c) => `"${c}"`).join(" or ")} column${hint}` });
    raise();
  }
  const keyCol = seen.get("parameter_key")!;
  const valueCol = seen.get("value")!;
  const width = columns.length;

  // ---- rows -----------------------------------------------------------------------------------------------------------------
  const items: CalibrationCsvItem[] = [];
  const lineOfKey = new Map<string, number>();
  const valueOfKey = new Map<string, string>();
  let dataRows = 0;
  let skippedEmpty = 0;
  let decimalCommas = 0;

  for (const row of rows) {
    if (row.cells.every((c) => c.trim() === "")) continue; // blank line
    dataRows++;
    if (dataRows > CSV_MAX_ROWS) {
      fail({ line: row.line, code: "too_many_rows", message: `more than ${CSV_MAX_ROWS} rows - is this a calibration export?` });
      break;
    }
    if (row.cells.length !== width) {
      fail({
        line: row.line,
        code: "column_count",
        message:
          row.cells.length > width
            ? `${row.cells.length} cells but the header has ${width} - a value containing "${delimiter === "\t" ? "tab" : delimiter}" must be quoted`
            : `${row.cells.length} cells but the header has ${width} - the row is incomplete`,
      });
      continue;
    }
    const key = unneutralise(row.cells[keyCol]).trim();
    let value = row.cells[valueCol].trim();

    if (!key) {
      fail({ line: row.line, code: "missing_key", message: "parameter_key is empty" });
      continue;
    }
    if (!KEY_PATTERN.test(key)) {
      fail({ line: row.line, code: "bad_key", parameter_key: key, message: `"${key.slice(0, 60)}" is not a valid parameter key` });
      continue;
    }
    if (value === "") {
      skippedEmpty++;
      continue;
    }
    if (value.length > MAX_VALUE_CHARS) {
      fail({ line: row.line, code: "value_too_long", parameter_key: key, message: `value is longer than ${MAX_VALUE_CHARS} characters` });
      continue;
    }
    if (FORMULA.test(value)) {
      fail({ line: row.line, code: "formula", parameter_key: key, message: `value "${value.slice(0, 40)}" looks like a spreadsheet formula - enter the plain value` });
      continue;
    }
    if (delimiter !== "," && DECIMAL_COMMA.test(value)) {
      value = value.replace(",", ".");
      decimalCommas++;
    }
    const previous = valueOfKey.get(key);
    if (previous !== undefined) {
      const firstLineOfKey = lineOfKey.get(key)!;
      if (previous === value) {
        warnings.push({ line: row.line, code: "duplicate_key", parameter_key: key, message: `${key} is listed again (same value as line ${firstLineOfKey}); the repeat is ignored` });
      } else {
        fail({ line: row.line, code: "conflicting_key", parameter_key: key, message: `${key} is listed twice with different values (line ${firstLineOfKey}: ${previous}, here: ${value})` });
      }
      continue;
    }
    valueOfKey.set(key, value);
    lineOfKey.set(key, row.line);
    items.push({ parameter_key: key, raw: value });
  }

  if (errors.length === 0 && dataRows === 0) {
    fail({ line: 2, code: "no_rows", message: "the file has a header but no parameter rows" });
  } else if (errors.length === 0 && items.length === 0) {
    fail({ line: 2, code: "no_values", message: `none of the ${dataRows} rows has a value - fill in the value column` });
  }
  if (errors.length > 0) raise();

  if (skippedEmpty > 0) {
    warnings.push({ line: 0, code: "empty_values", message: `${skippedEmpty} row(s) have no value and are skipped (an import never clears a stored value)` });
  }
  if (decimalCommas > 0) {
    warnings.push({ line: 0, code: "decimal_comma", message: `${decimalCommas} value(s) used a decimal comma and were read with a decimal point` });
  }

  return {
    format: "csv",
    items,
    rows: dataRows,
    lines,
    delimiter,
    skippedEmpty,
    warnings,
    lineOfKey,
    fileEquipmentId: nameInfo?.equipmentId ?? null,
    fileType: nameInfo?.type ?? null,
    fileRevision: nameInfo?.revision ?? null,
  };
}
