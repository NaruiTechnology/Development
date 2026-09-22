/** Equipment row shape + helpers shared by SettingsDialog (draft plumbing) and EquipmentGrid (AG Grid table). */
import { readPath } from "../store/settingsSlice";

export interface EquipmentRow {
  id: number | null;
  name: string;
  model: string;
  serial_number: string;
  site: string;
  description: string;
}

export function emptyEquipment(nextId: number): EquipmentRow {
  return {
    id: nextId,
    name: "",
    model: "",
    serial_number: "",
    site: "",
    description: "",
  };
}

export function equipmentFromDraft(draft: unknown): EquipmentRow[] {
  const equipment = readPath(draft, ["equipments"]);
  const rawEquipment = Array.isArray(equipment)
    ? equipment
    : readPath(draft, ["equipment"]) && typeof readPath(draft, ["equipment"]) === "object"
      ? [readPath(draft, ["equipment"])]
      : [];

  return rawEquipment
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row, index) => ({
      id: typeof row.id === "number" ? row.id : index + 1,
      name: String(row.name ?? ""),
      model: String(row.model ?? ""),
      serial_number: String(row.serial_number ?? ""),
      site: String(row.site ?? ""),
      description: String(row.description ?? ""),
    }));
}

/** Stable identity for a row across drafts: DB id when persisted, else serial number, else position. */
export function equipmentRowKey(row: EquipmentRow, index: number): string {
  if (row.id !== null) return `id:${row.id}`;
  const serial = row.serial_number.trim().toLowerCase();
  if (serial) return `serial:${serial}`;
  return `index:${index}`;
}

export function equipmentRowSignature(row: EquipmentRow): string {
  return JSON.stringify(row);
}
