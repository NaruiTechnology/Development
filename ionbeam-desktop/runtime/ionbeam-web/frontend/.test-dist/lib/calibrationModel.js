export const ROLE_SUPER_USER = 1;
export const ROLE_DEVELOPER = 2;
export const ROLE_ADMIN = 3;
/** Minimum users.role that may change a parameter of this access level (mirrors fn_calibration_required_role). */
export function requiredRole(access) {
    if (access === "adjustable")
        return ROLE_SUPER_USER;
    if (access === "fixed")
        return ROLE_ADMIN;
    return ROLE_DEVELOPER; // service | auto
}
/** Why changing this parameter needs an explicit acknowledgement, or null (mirrors fn_calibration_needs_ack). */
export function riskReason(def) {
    if (!def.semantics_known || def.param_class === "undocumented")
        return "undocumented";
    if (def.access_level === "fixed")
        return "fixed";
    if (def.assign_conf === "low")
        return "lowConfidence";
    return null;
}
const NUMBER = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/;
/**
 * What the operator typed -> a typed value for `def`. Enum values must be one of the documented options; the panel
 * still shows an already-stored undocumented value (the vendor's comments are not always exhaustive).
 */
export function parseInput(def, text) {
    if (def.value_type === "text")
        return { ok: true, value: text };
    const s = text.trim();
    if (s === "")
        return { ok: false, message: "required" };
    if (def.value_type === "boolean") {
        const lower = s.toLowerCase();
        if (["true", "1", "yes", "on"].includes(lower))
            return { ok: true, value: true };
        if (["false", "0", "no", "off"].includes(lower))
            return { ok: true, value: false };
        return { ok: false, message: "boolean" };
    }
    if (!NUMBER.test(s))
        return { ok: false, message: "number" };
    const n = Number(s);
    if (!Number.isFinite(n))
        return { ok: false, message: "number" };
    if ((def.value_type === "integer" || def.value_type === "enum") && !Number.isInteger(n)) {
        return { ok: false, message: "integer" };
    }
    if (def.value_type === "enum" && !(def.enum_options ?? []).some((o) => o.value === n)) {
        return { ok: false, message: "enum" };
    }
    return { ok: true, value: n };
}
/** A stored / typed value as the text of an input box (no float noise: 0.1+0.2 shows as 0.3). */
export function formatValue(value) {
    if (value === null || value === undefined)
        return "";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return Number.isFinite(value) ? String(Number(value.toPrecision(12))) : "";
    return String(value);
}
export function enumLabel(options, value) {
    if (typeof value !== "number")
        return null;
    return options?.find((o) => o.value === value)?.label ?? null;
}
export function valuesEqual(a, b) {
    if (a === b)
        return true;
    if (typeof a === "number" && typeof b === "number")
        return a === b;
    return (a ?? null) === (b ?? null);
}
/**
 * Vendor limit check on the values the server resolved into minimum_value / maximum_value. An unset pair
 * (0/0) or an inverted pair (min > max) means "no limit" in the vendor files.
 */
export function limitViolation(def, value) {
    const { minimum_value: lo, maximum_value: hi } = def;
    if (typeof value !== "number" || lo === null || hi === null)
        return null;
    if (lo > hi || (lo === 0 && hi === 0))
        return null;
    return value < lo || value > hi ? { min: lo, max: hi } : null;
}
/** Record what was typed for `key`; an edit that equals the stored value removes the entry, a parse failure leaves it as is. */
export function applyTyped(edits, key, parsed, stored) {
    const next = new Map(edits);
    if (parsed.ok && valuesEqual(parsed.value, stored))
        next.delete(key);
    else if (parsed.ok)
        next.set(key, { kind: "set", value: parsed.value });
    return next;
}
export function toWriteItems(edits) {
    return [...edits.entries()].map(([parameter_key, edit]) => edit.kind === "clear" ? { parameter_key, clear: true } : { parameter_key, value: edit.value });
}
export function buildGroupTree(groups) {
    const byCode = new Map(groups.map((g) => [g.group_code, { group: g, children: [] }]));
    const roots = [];
    for (const g of [...groups].sort((a, b) => a.sort_order - b.sort_order)) {
        const node = byCode.get(g.group_code);
        const parent = g.parent_code ? byCode.get(g.parent_code) : undefined;
        (parent ? parent.children : roots).push(node);
    }
    return roots;
}
/** Group codes on the path from the root to `code` (used to keep the selected branch expanded). */
export function ancestorCodes(groups, code) {
    const byCode = new Map(groups.map((g) => [g.group_code, g]));
    const out = [];
    for (let g = byCode.get(code); g?.parent_code; g = byCode.get(g.parent_code))
        out.push(g.parent_code);
    return out;
}
// ------------------------------------------------------------------------------------------ matrix
export function cellLookup(cells) {
    return new Map(cells.map((c) => [`${c.row_key}\u0000${c.col_key}`, c]));
}
export function cellAt(lookup, row, col) {
    return lookup.get(`${row}\u0000${col}`);
}
// ------------------------------------------------------------------------------------------ files
/** Vendor files are ASCII apart from a few Latin-1 characters (the registry export); UTF-8 first, else Windows-1252. */
export function decodeVendorFile(buffer) {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    }
    catch {
        return new TextDecoder("windows-1252").decode(buffer);
    }
}
