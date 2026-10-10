import assert from "node:assert/strict";
import test from "node:test";

import { parseMachineData, parseRegistryExport, parseVendorFile, symbolOfComment } from "../src/calibrationVendorFile";

test("machine data: int/float rows, symbols, axis prefixes, unnamed rows", () => {
  const rows = parseMachineData(
    [
      "/*---- header ----*/",
      "int    0                     7 /* IMD_MD_INITIALIZED                F   */",
      "int   21                 24905 /* IONI_PSWD1                      CS  A */",
      "float  1                 624.5 /* IONF_SUP_USED  [V]              A */",
      "float 40                  1e-3 /* X: MD_8I_KP servo gain    A */",
      "int   45                     0 /* new  A */",
      "int   46                     3",
      "not a data row",
    ].join("\r\n"),
  );
  assert.deepEqual(rows, [
    { kind: "int", slot: 0, raw: "7", symbol: "IMD_MD_INITIALIZED" },
    { kind: "int", slot: 21, raw: "24905", symbol: "IONI_PSWD1" }, // parsed here; the database has no such parameter and drops it
    { kind: "float", slot: 1, raw: "624.5", symbol: "IONF_SUP_USED" },
    { kind: "float", slot: 40, raw: "1e-3", symbol: "MD_8I_KP" },
    { kind: "int", slot: 45, raw: "0" },
    { kind: "int", slot: 46, raw: "3" },
  ]);
});

test("symbolOfComment ignores flags, units and placeholder words", () => {
  assert.equal(symbolOfComment("IONF_HT_MAX  [V] F"), "IONF_HT_MAX");
  assert.equal(symbolOfComment("MD_8I_spare_6   A"), "MD_8I_spare_6");
  assert.equal(symbolOfComment("obsolete  A"), undefined);
  assert.equal(symbolOfComment("ACB"), undefined); // a bare flag token
  assert.equal(symbolOfComment(""), undefined);
});

test("registry export: indentation tree, values, defaults, binary skipped", () => {
  const text = [
    "\\Registry\\Machine\\Software\\Microscope",
    "    ib32",
    "        IonSource",
    "            AutoAdjust = TRUE",
    "            Path = C:\\Data = x",
    "            Blob = REG_BINARY 3 bytes",
    "                0x01 0x02 0x03",
    "        Other",
    "            = default text",
    "            Level = 5",
  ].join("\n");
  const { items, skippedBinary, root } = parseRegistryExport(text);
  assert.equal(root, "\\Registry\\Machine\\Software\\Microscope");
  assert.equal(skippedBinary, 1);
  assert.deepEqual(items, [
    { path: "ib32\\IonSource\\AutoAdjust", raw: "TRUE" },
    { path: "ib32\\IonSource\\Path", raw: "C:\\Data = x" },
    { path: "ib32\\Other\\(default)", raw: "default text" },
    { path: "ib32\\Other\\Level", raw: "5" },
  ]);
});

test("format detection and refusal of unknown files", () => {
  const md = Array.from({ length: 6 }, (_, i) => `float ${i} ${i}.5 /* SYM_${i} A */`).join("\n");
  assert.equal(parseVendorFile(md).format, "machine-data");
  assert.equal(parseVendorFile("\\Registry\\Machine\\X\n    a\n        b = 1\n").format, "registry");
  assert.throws(() => parseVendorFile("hello\nworld\n"), /unrecognised file/);
  assert.throws(() => parseVendorFile("float 1 2 /* A_B */\n"), /unrecognised file/); // too few rows to be a machine-data file
});
