import type { EquipmentRow } from "./equipmentModel";
import { SITE_OPTIONS } from "./sites";

export type EquipmentCsvRow = Partial<EquipmentRow> & Pick<EquipmentRow, "name">;
export interface EquipmentCsvValidation {
  rows: EquipmentCsvRow[];
  skippedRows: number[];
  skippedColumns: number[];
}

const MAX_EQUIPMENT_ROWS = 10_000;
const FIELD_LIMITS = {
  name: 100,
  model: 100,
  serial_number: 15,
  site: 50,
  equipment_code: 1000,
  host_computer_model: 1000,
  motherboard_model: 1000,
  windows_version: 1000,
  software_version: 1000,
  coreco_processing_card: 1000,
  description: 1000,
} as const;

export function parseEquipmentCsv(text: string): EquipmentCsvValidation {
  const table = parseCsvRecords(text.replace(/^\uFEFF/, ""));
  while (table.length > 0 && table[table.length - 1].every((cell) => !cell.trim())) table.pop();
  if (table.length < 2) throw new Error("The CSV has no equipment rows.");

  const headerMap = new Map<string, number>();
  const skippedColumns: number[] = [];
  table[0].forEach((header, index) => {
    const key = normalizeHeader(header);
    if (key === "") {
      skippedColumns.push(index + 1);
      return;
    }
    const column = key === "id" ? "id"
      : key === "name" ? "name"
      : key === "model" ? "model"
      : key === "serial" || key === "serialnumber" ? "serial_number"
      : key === "site" || key === "region" ? "site"
      : key === "equipmentcode" ? "equipment_code"
      : key === "hostcomputermodel" ? "host_computer_model"
      : key === "motherboardmodel" ? "motherboard_model"
      : key === "windowsversion" ? "windows_version"
      : key === "softwareversion" ? "software_version"
      : key === "corecoprocessingcard" ? "coreco_processing_card"
      : key === "description" || key === "notes" ? "description"
      : null;
    if (!column) return;
    if (headerMap.has(column)) throw new Error(`The CSV has more than one ${column} column.`);
    headerMap.set(column, index);
  });
  if (!headerMap.has("name")) {
    throw new Error("The CSV must include a Name column.");
  }
  if (table.length - 1 > MAX_EQUIPMENT_ROWS) {
    throw new Error(`The CSV may contain at most ${MAX_EQUIPMENT_ROWS.toLocaleString()} equipment rows.`);
  }

  const rows: EquipmentCsvRow[] = [];
  const skippedRows: number[] = [];
  const seenIds = new Set<number>();
  const seenSerials = new Set<string>();
  for (let recordIndex = 1; recordIndex < table.length; recordIndex++) {
    const cells = table[recordIndex];
    if (cells.every((cell) => !cell.trim())) continue;
    if (cells.length !== table[0].length) {
      skippedRows.push(recordIndex + 1);
      continue;
    }
    const value = (key: string) => {
      const column = headerMap.get(key);
      return column === undefined ? undefined : (cells[column] ?? "").trim();
    };
    const name = value("name") ?? "";
    const serialNumber = value("serial_number");
    const rowNumber = recordIndex + 1;
    if (!validateEquipmentCsvField("name", name)
      || (serialNumber !== undefined && !validateEquipmentCsvField("serial_number", serialNumber))) {
      skippedRows.push(rowNumber);
      continue;
    }

    const row: EquipmentCsvRow = { name };
    if (serialNumber !== undefined) row.serial_number = serialNumber;
    const idText = value("id");
    if (idText) {
      const id = Number(idText);
      if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) {
        skippedRows.push(rowNumber);
        continue;
      }
      row.id = id;
    } else if (headerMap.has("id")) {
      row.id = null;
    }
    for (const field of [
      "model", "site", "equipment_code", "host_computer_model", "motherboard_model",
      "windows_version", "software_version", "coreco_processing_card", "description",
    ] as const) {
      const fieldValue = value(field);
      if (fieldValue !== undefined) {
        if (!validateEquipmentCsvField(field, fieldValue)) {
          skippedRows.push(rowNumber);
          break;
        }
        row[field] = fieldValue;
      }
    }

    if (skippedRows.includes(rowNumber)) continue;

    const serialKey = (serialNumber ?? "").toLocaleLowerCase();
    if (serialKey) {
      if (seenSerials.has(serialKey)) {
        skippedRows.push(rowNumber);
        continue;
      }
      seenSerials.add(serialKey);
    }
    if (row.id != null) seenIds.add(row.id);
    rows.push(row);
  }
  return { rows, skippedRows, skippedColumns };
}

function validateEquipmentCsvField(field: keyof typeof FIELD_LIMITS, value: string): boolean {
  if (value.length > FIELD_LIMITS[field]) return false;
  if (field === "site") {
    return SITE_OPTIONS.some((option) => option.value === value);
  }
  if (field !== "description" && /[\r\n]/.test(value)) return false;
  return true;
}

function normalizeHeader(header: string): string {
  return header.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      if (cell.length !== 0 || closedQuote) throw new Error("The CSV has a quote in an invalid position.");
      quoted = true;
    } else if (char === ",") {
      record.push(cell);
      cell = "";
      closedQuote = false;
    } else if (char === "\n" || char === "\r") {
      record.push(cell);
      if (record.some((item) => item.length > 0)) records.push(record);
      record = [];
      cell = "";
      closedQuote = false;
      if (char === "\r" && text[index + 1] === "\n") index++;
    } else {
      if (closedQuote) throw new Error("The CSV has characters after a closing quote.");
      cell += char;
    }
  }
  if (quoted) throw new Error("The CSV has an unterminated quoted value.");
  record.push(cell);
  if (record.some((item) => item.length > 0)) records.push(record);
  return records;
}
