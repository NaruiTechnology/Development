/**
 * Parsers for the two vendor file formats the calibration import understands. They only *read lines*; deciding
 * which line belongs to which catalogued parameter (and dropping everything else, e.g. credentials) is done in
 * PostgreSQL by fn_import_equipment_calibration(), so a parser bug can never store something the catalog does not know.
 *
 * 1. FEI xP machine data  (MD.TXT, icMD*.TXT)
 *
 *      int   <slot>  <value>  / * SYMBOL  description  [unit]  FLAGS * /
 *      float <slot>  <value>  / * SYMBOL  description  [unit]  FLAGS * /
 *
 *    `int` and `float` are separate address spaces. Stage rows carry an axis prefix (`X: MD_8I_KP ...`). Rows the
 *    vendor never named (`/ * new  A * /`) have no symbol.
 *
 * 2. Windows registry export of HKLM\Software\Microscope (UI1280reg.txt): an indented tree, 4 spaces per level,
 *    `name = value` lines are values, anything else is a key. Binary values are skipped.
 *
 * This is a line-for-line port of IobeamAdmin/CalibrationCatalog/calibration_catalog/{md_parser,registry_parser}.py,
 * which built the catalog; both must keep the same rules (see tests/calibrationVendorFile.test.ts).
 */

export type MachineDataItem = { kind: "int" | "float"; slot: number; raw: string; symbol?: string };
export type RegistryItem = { path: string; raw: string };
export type CalibrationImportItem = MachineDataItem | RegistryItem;

export interface ParsedVendorFile {
  format: "machine-data" | "registry";
  items: CalibrationImportItem[];
  lines: number;
  skippedBinary: number;
}

const ROW = /^(int|float)\s+(\d+)\s+(\S+)\s*(?:\/\*(.*?)\*\/)?\s*$/;
const AXIS = /^(X|Y|Z|T|R|LL):\s+(\S+)\s*(.*)$/;
const SYMBOL = /^[A-Z][A-Z0-9]*_[A-Za-z0-9_]+$|^[A-Z][A-Z0-9_]{2,}$/;
const UNIT_BRACKET = /\[\s*([^\]]*?)\s*\]/;
const UNIT_PAREN = /\(\s*(um|uDeg|mm|nm)\s*\)/;
const FLAG_TOKENS = new Set(["F", "A", "CS", "DB", "611", "ACB", "A--", "*", "NotUsed"]);
const UNNAMED = new Set(["new", "not", "out", "obsolete", "IMD"]);
const HEX_LINE = /^\s+(0x[0-9a-fA-F]+\s*)+$/;

function isFlag(token: string): boolean {
  return FLAG_TOKENS.has(token) || /^A\d+$/.test(token);
}

/** The vendor symbol of a comment body, or undefined when the vendor gave the slot no name. */
export function symbolOfComment(comment: string): string | undefined {
  let text = comment.trim();
  const axis = AXIS.exec(text);
  if (axis) text = `${axis[2]} ${axis[3]}`.trim();
  const unit = UNIT_BRACKET.exec(text) ?? UNIT_PAREN.exec(text);
  if (unit) text = `${text.slice(0, unit.index)} ${text.slice(unit.index + unit[0].length)}`.trim();
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  while (tokens.length > 0 && isFlag(tokens[tokens.length - 1])) tokens.pop();
  const first = tokens[0];
  if (first !== undefined && !UNNAMED.has(first) && SYMBOL.test(first)) return first;
  return undefined;
}

export function parseMachineData(text: string): MachineDataItem[] {
  const items: MachineDataItem[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const m = ROW.exec(line.trim());
    if (!m) continue;
    const item: MachineDataItem = { kind: m[1] as "int" | "float", slot: Number(m[2]), raw: m[3] };
    const symbol = symbolOfComment(m[4] ?? "");
    if (symbol) item.symbol = symbol;
    items.push(item);
  }
  return items;
}

export function parseRegistryExport(text: string): { items: RegistryItem[]; skippedBinary: number; root: string } {
  const lines = text.replace(/\r/g, "").split("\n");
  const root = (lines[0] ?? "").trim();
  let stack: string[] = [];
  const items: RegistryItem[] = [];
  let skippedBinary = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || HEX_LINE.test(line)) continue;
    const depth = Math.floor((line.length - line.replace(/^ +/, "").length) / 4);
    const body = line.trim();
    stack = stack.slice(0, depth - 1);
    if (body.includes(" = ") || body.endsWith(" =") || body.startsWith("=")) {
      const eq = body.indexOf("=");
      const name = body.slice(0, eq).trim();
      const raw = body.slice(eq + 1).trim();
      if (raw.startsWith("REG_BINARY")) {
        skippedBinary += 1;
        continue;
      }
      const path = stack.join("\\");
      items.push({ path: name ? `${path}\\${name}` : `${path}\\(default)`, raw });
    } else {
      stack.push(body);
    }
  }
  return { items, skippedBinary, root };
}

/** Decide which of the two formats `text` is and parse it. Throws a readable Error when it is neither. */
export function parseVendorFile(text: string): ParsedVendorFile {
  const lines = text.split("\n").length;
  const machine = parseMachineData(text);
  if (machine.length >= 5) {
    return { format: "machine-data", items: machine, lines, skippedBinary: 0 };
  }
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (/^\\?registry\\/i.test(firstLine) || /^\\/.test(firstLine)) {
    const reg = parseRegistryExport(text.replace(/^\uFEFF/, ""));
    if (reg.items.length > 0) {
      return { format: "registry", items: reg.items, lines, skippedBinary: reg.skippedBinary };
    }
  }
  throw new Error(
    "unrecognised file: expected a FEI machine-data file (lines like 'float 12 3.5 /* SYMBOL ... */') " +
      "or a registry export of HKLM\\Software\\Microscope",
  );
}
