import test from "node:test";
import assert from "node:assert/strict";

import { IMPORT_MAX_BYTES, exportFileInfo, precheckImportFile } from "../.test-dist/lib/calibrationImportFile.js";

test("precheck: accepts vendor text files and calibration CSVs", () => {
  assert.deepEqual(precheckImportFile({ name: "icmd.TXT", size: 10 }, "FIB"), { ok: true, kind: "vendor" });
  assert.deepEqual(precheckImportFile({ name: "calibration_2_FIB_r4.csv", size: 10 }, "FIB"), { ok: true, kind: "csv" });
  assert.deepEqual(precheckImportFile({ name: "my values.CSV", size: 10 }, "SEM"), { ok: true, kind: "csv" });
});

test("precheck: refuses other types, empty and oversized files", () => {
  assert.equal(precheckImportFile({ name: "calibration.xlsx", size: 10 }, "FIB").reason, "extension");
  assert.equal(precheckImportFile({ name: "a.csv", size: 0 }, "FIB").reason, "empty");
  assert.equal(precheckImportFile({ name: "a.csv", size: IMPORT_MAX_BYTES + 1 }, "FIB").reason, "tooLarge");
});

test("precheck: an Export CSV of the other column is refused", () => {
  assert.deepEqual(precheckImportFile({ name: "calibration_2_SEM_r4.csv", size: 10 }, "FIB"), { ok: false, reason: "wrongType", fileType: "SEM" });
  assert.deepEqual(exportFileInfo("calibration_12_fib_r40 (1).csv"), { equipmentId: 12, type: "FIB", revision: 40 });
  assert.equal(exportFileInfo("values.csv"), null);
});
