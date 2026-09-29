import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTyped,
  ancestorCodes,
  buildGroupTree,
  cellAt,
  cellLookup,
  decodeVendorFile,
  enumLabel,
  formatValue,
  limitViolation,
  parseInput,
  requiredRole,
  riskReason,
  toWriteItems,
} from "../.test-dist/lib/calibrationModel.js";

const number = { value_type: "number" };
const integer = { value_type: "integer" };
const enumDef = { value_type: "enum", enum_options: [{ value: 0, label: "Manual" }, { value: 4, label: "XL30 SMCB" }] };

test("numbers: accepts plain, signed and exponent forms, rejects anything else", () => {
  for (const [text, value] of [["12", 12], [" -0.5 ", -0.5], ["1e-3", 0.001], [".25", 0.25], ["+7.", 7]]) {
    assert.deepEqual(parseInput(number, text), { ok: true, value });
  }
  for (const text of ["", "  ", "1,5", "0x10", "abc", "1 2", "Infinity", "NaN"]) {
    assert.equal(parseInput(number, text).ok, false, text);
  }
  assert.equal(parseInput(number, "").message, "required");
  assert.equal(parseInput(number, "abc").message, "number");
});

test("integers and enums must be whole numbers; enums must be a documented option", () => {
  assert.deepEqual(parseInput(integer, "200"), { ok: true, value: 200 });
  assert.equal(parseInput(integer, "1.5").message, "integer");
  assert.deepEqual(parseInput(enumDef, "4"), { ok: true, value: 4 });
  assert.equal(parseInput(enumDef, "7").message, "enum");
  assert.equal(parseInput(enumDef, "4.5").message, "integer");
});

test("booleans and text", () => {
  assert.deepEqual(parseInput({ value_type: "boolean" }, "TRUE"), { ok: true, value: true });
  assert.deepEqual(parseInput({ value_type: "boolean" }, "0"), { ok: true, value: false });
  assert.equal(parseInput({ value_type: "boolean" }, "maybe").message, "boolean");
  assert.deepEqual(parseInput({ value_type: "text" }, "  COM7 "), { ok: true, value: "  COM7 " });
  assert.deepEqual(parseInput({ value_type: "text" }, ""), { ok: true, value: "" });
});

test("formatValue hides float noise and handles empties", () => {
  assert.equal(formatValue(0.1 + 0.2), "0.3");
  assert.equal(formatValue(612.5), "612.5");
  assert.equal(formatValue(33000), "33000");
  assert.equal(formatValue(null), "");
  assert.equal(formatValue(undefined), "");
  assert.equal(formatValue(true), "true");
  assert.equal(formatValue("COM7"), "COM7");
});

test("role thresholds mirror the database", () => {
  assert.equal(requiredRole("adjustable"), 1);
  assert.equal(requiredRole("service"), 2);
  assert.equal(requiredRole("auto"), 2);
  assert.equal(requiredRole("fixed"), 3);
});

test("risk reasons: undocumented beats fixed beats low confidence", () => {
  const base = { semantics_known: true, param_class: "calibration", access_level: "adjustable", assign_conf: "high" };
  assert.equal(riskReason(base), null);
  assert.equal(riskReason({ ...base, semantics_known: false, access_level: "fixed" }), "undocumented");
  assert.equal(riskReason({ ...base, param_class: "undocumented" }), "undocumented");
  assert.equal(riskReason({ ...base, access_level: "fixed" }), "fixed");
  assert.equal(riskReason({ ...base, assign_conf: "low" }), "lowConfidence");
});

test("limits: violation only for a real pair; 0/0 and inverted pairs mean no limit", () => {
  const d = (minimum_value, maximum_value) => ({ minimum_value, maximum_value });
  assert.deepEqual(limitViolation(d(100, 800), 900), { min: 100, max: 800 });
  assert.equal(limitViolation(d(100, 800), 450), null);
  assert.equal(limitViolation(d(100, 800), 100), null);
  assert.equal(limitViolation(d(0, 0), 5000), null);
  assert.equal(limitViolation(d(500, 100), 5000), null);
  assert.equal(limitViolation(d(null, 800), 900), null);
  assert.equal(limitViolation(d(100, 800), "x"), null);
});

test("edits: typing the stored value again removes the edit; clear and write items", () => {
  let edits = new Map();
  edits = applyTyped(edits, "A", { ok: true, value: 5 }, 3);
  assert.deepEqual([...edits.keys()], ["A"]);
  edits = applyTyped(edits, "A", { ok: true, value: 3 }, 3);
  assert.equal(edits.size, 0);
  edits = applyTyped(edits, "B", { ok: false, message: "number" }, 3);
  assert.equal(edits.size, 0);
  edits.set("C", { kind: "clear" });
  edits.set("D", { kind: "set", value: 1.5 });
  assert.deepEqual(toWriteItems(edits), [{ parameter_key: "C", clear: true }, { parameter_key: "D", value: 1.5 }]);
});

test("enumLabel", () => {
  assert.equal(enumLabel(enumDef.enum_options, 4), "XL30 SMCB");
  assert.equal(enumLabel(enumDef.enum_options, 99), null);
  assert.equal(enumLabel(undefined, 4), null);
});

test("group tree keeps sort order, nests by parent_code, and finds ancestors", () => {
  const g = (group_code, parent_code, sort_order) => ({ group_code, parent_code, label: group_code, sort_order });
  const groups = [g("FIB.SRC.EXTR", "FIB.SRC", 12), g("FIB.SRC", "FIB", 10), g("FIB", null, 0), g("FIB.VAC", "FIB", 20)];
  const tree = buildGroupTree(groups);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].children.map((n) => n.group.group_code), ["FIB.SRC", "FIB.VAC"]);
  assert.deepEqual(tree[0].children[0].children.map((n) => n.group.group_code), ["FIB.SRC.EXTR"]);
  assert.deepEqual(ancestorCodes(groups, "FIB.SRC.EXTR"), ["FIB.SRC", "FIB"]);
});

test("matrix lookup", () => {
  const lookup = cellLookup([{ row_key: "1", col_key: "PICO_AMP", parameter_key: "K" }]);
  assert.equal(cellAt(lookup, "1", "PICO_AMP").parameter_key, "K");
  assert.equal(cellAt(lookup, "2", "PICO_AMP"), undefined);
});

test("vendor files: UTF-8 first, Windows-1252 fallback for Latin-1 bytes", () => {
  assert.equal(decodeVendorFile(new TextEncoder().encode("float 1 2 /* µm */").buffer), "float 1 2 /* µm */");
  assert.equal(decodeVendorFile(Uint8Array.from([0x31, 0xb5, 0x6d]).buffer), "1µm");
});
