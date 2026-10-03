import type { EquipmentRow } from "./equipmentModel";
import { SITE_OPTIONS } from "./sites";

export type EquipmentCsvRow = Partial<EquipmentRow> & Pick<EquipmentRow, "name" | "serial_number">;

const MAX_EQUIPMENT_ROWS = 10_000;
const FIELD_LIMITS = {
  name: 100,
  model: 100,
  serial_number: 15,
  site: 50,
  description: 1000,
} as const;

export function parseEquipmentCsv(text: string): EquipmentCsvRow[] {
  const table = parseCsvRecords(text.replace(/^\uFEFF/, ""));
  while (table.length > 0 && table[table.length - 1].every((cell) => !cell.trim())) table.pop();
  if (table.length < 2) throw new Error("The CSV has no equipment rows.");

  const headerMap = new Map<string, number>();
  table[0].forEach((header, index) => {
    const key = normalizeHeader(header);
    const column = key === "id" ? "id"
      : key === "name" ? "name"
      : key === "model" ? "model"
      : key === "serial" || key === "serialnumber" ? "serial_number"
      : key === "site" || key === "region" ? "site"
      : key === "description" || key === "notes" ? "description"
      : null;
    if (!column) return;
    if (headerMap.has(column)) throw new Error(`The CSV has more than one ${column} column.`);
    headerMap.set(column, index);
  });
  if (!headerMap.has("name") || !headerMap.has("serial_number")) {
    throw new Error("The CSV must include Name and Serial number columns.");
  }
  if (table.length - 1 > MAX_EQUIPMENT_ROWS) {
    throw new Error(`The CSV may contain at most ${MAX_EQUIPMENT_ROWS.toLocaleString()} equipment rows.`);
  }

  const rows: EquipmentCsvRow[] = [];
  const seenIds = new Set<number>();
  const seenSerials = new Set<string>();
  for (let recordIndex = 1; recordIndex < table.length; recordIndex++) {
    const cells = table[recordIndex];
    if (cells.every((cell) => !cell.trim())) continue;
    if (cells.length !== table[0].length) {
      throw new Error(`Row ${recordIndex + 1} has ${cells.length} columns; expected ${table[0].length}.`);
    }
    const value = (key: string) => {
      const column = headerMap.get(key);
      return column === undefined ? undefined : (cells[column] ?? "").trim();
    };
    const name = value("name") ?? "";
    const serialNumber = value("serial_number") ?? "";
    const rowNumber = recordIndex + 1;
    if (!name || !serialNumber) {
      throw new Error(`Row ${rowNumber} needs both a name and serial number.`);
    }
    if (name.length > FIELD_LIMITS.name) throw new Error(`Row ${rowNumber} name exceeds ${FIELD_LIMITS.name} characters.`);
    if (serialNumber.length > FIELD_LIMITS.serial_number) {
      throw new Error(`Row ${rowNumber} serial number exceeds ${FIELD_LIMITS.serial_number} characters.`);
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(serialNumber)) {
      throw new Error(`Row ${rowNumber} name and serial number cannot contain line breaks.`);
    }

    const row: EquipmentCsvRow = { name, serial_number: serialNumber };
    const idText = value("id");
    if (idText) {
      const id = Number(idText);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Row ${rowNumber} has an invalid ID.`);
      if (seenIds.has(id)) throw new Error(`The CSV repeats equipment ID ${id}.`);
      seenIds.add(id);
      row.id = id;
    } else if (headerMap.has("id")) {
      row.id = null;
    }
    for (const field of ["model", "site", "description"] as const) {
      const fieldValue = value(field);
      if (fieldValue !== undefined) {
        if (fieldValue.length > FIELD_LIMITS[field]) {
          throw new Error(`Row ${rowNumber} ${field.replace("_", " ")} exceeds ${FIELD_LIMITS[field]} characters.`);
        }
        if (field === "site" && !SITE_OPTIONS.some((option) => option.value === fieldValue)) {
          throw new Error(`Row ${rowNumber} has an unsupported site.`);
        }
        if (field !== "description" && /[\r\n]/.test(fieldValue)) {
          throw new Error(`Row ${rowNumber} ${field.replace("_", " ")} cannot contain line breaks.`);
        }
        row[field] = fieldValue;
      }
    }

    const serialKey = serialNumber.toLocaleLowerCase();
    if (seenSerials.has(serialKey)) throw new Error(`The CSV repeats serial number “${serialNumber}”.`);
    seenSerials.add(serialKey);
    rows.push(row);
  }
  if (rows.length === 0) throw new Error("The CSV has no equipment rows.");
  return rows;
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
