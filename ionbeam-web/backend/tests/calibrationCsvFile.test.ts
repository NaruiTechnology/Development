import assert from "node:assert/strict";
import test from "node:test";

import {
  CalibrationCsvError,
  detectDelimiter,
  exportNameInfo,
  isCalibrationCsv,
  parseCalibrationCsv,
  tokenizeCsv,
} from "../src/calibrationCsvFile";

const HEADER =
  "parameter_key,vendor_name,category,display_name,value,unit,value_type,access_level,param_class,semantics_known,review_state,verified_at,notes,source_reference";

function exportRow(key: string, value: string, display = "Name"): string {
  return `${key},${key},Cat,${display},${value},V,number,adjustable,tuning,yes,imported,,,md.TXT float 1`;
}

function issuesOf(fn: () => unknown): CalibrationCsvError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CalibrationCsvError) return err;
    throw err;
  }
  assert.fail("expected a CalibrationCsvError");
}

test("an Export CSV file round-trips: BOM, CRLF, quoted cells, formula-neutralised text columns", () => {
  const text =
    "\uFEFF" +
    [
      HEADER,
      exportRow("IONF_SUP_USED", "624.5"),
      `IONI_LENS_TYPE,IONI_LENS_TYPE,Cat,"Lens, type ""A""",3,,enum,service,config,yes,imported,,"multi\nline note",md.TXT int 4`,
      `REG.ib32.IonSource.AutoAdjustEmissionWithSuppr,,Cat,'=looks like formula,true,,boolean,adjustable,config,yes,imported,,,reg`,
      exportRow("GCS#i126", ""),
      "",
    ].join("\r\n");
  const parsed = parseCalibrationCsv(text, { fileName: "calibration_2_FIB_r7.csv", equipmentId: 2, type: "FIB" });
  assert.equal(parsed.format, "csv");
  assert.equal(parsed.delimiter, ",");
  assert.deepEqual(parsed.items, [
    { parameter_key: "IONF_SUP_USED", raw: "624.5" },
    { parameter_key: "IONI_LENS_TYPE", raw: "3" },
    { parameter_key: "REG.ib32.IonSource.AutoAdjustEmissionWithSuppr", raw: "true" },
  ]);
  assert.equal(parsed.rows, 4);
  assert.equal(parsed.skippedEmpty, 1);
  assert.equal(parsed.lineOfKey.get("IONI_LENS_TYPE"), 3);
  assert.equal(parsed.lineOfKey.get("REG.ib32.IonSource.AutoAdjustEmissionWithSuppr"), 5, "the quoted line break moves later rows down");
  assert.equal(parsed.fileRevision, 7);
  assert.deepEqual(parsed.warnings.map((w) => w.code), ["empty_values"]);
});

test("only parameter_key and value are required; column order is free", () => {
  const parsed = parseCalibrationCsv(["Value,Parameter Key", "1.5,IONF_A", "-2,IONF_B", "+1e3,IONF_C"].join("\n"));
  assert.deepEqual(parsed.items.map((i) => i.raw), ["1.5", "-2", "+1e3"]);
});

test("semicolon files from Excel: delimiter detected, decimal commas converted with a warning", () => {
  const parsed = parseCalibrationCsv(["parameter_key;value;unit", "IONF_A;3,25;V", 'IONF_B;"1,5e-3";A'].join("\r\n"));
  assert.equal(parsed.delimiter, ";");
  assert.deepEqual(parsed.items, [
    { parameter_key: "IONF_A", raw: "3.25" },
    { parameter_key: "IONF_B", raw: "1.5e-3" },
  ]);
  assert.ok(parsed.warnings.some((w) => w.code === "decimal_comma"));
});

test("missing required column is refused with a hint", () => {
  const err = issuesOf(() => parseCalibrationCsv(["parameter_key,display_name", "IONF_A,x"].join("\n")));
  assert.equal(err.issues[0].code, "missing_column");
  assert.match(err.message, /"value"/);
});

test("duplicate header column is refused", () => {
  const err = issuesOf(() => parseCalibrationCsv(["parameter_key,value,value", "IONF_A,1,2"].join("\n")));
  assert.equal(err.issues[0].code, "duplicate_column");
});

test("structural row problems are all reported with line numbers, nothing is imported", () => {
  const text = [
    "parameter_key,value,notes",
    "IONF_A,1,ok",
    "IONF_B,1,2,3", // unquoted comma
    "IONF_C,1", // short row
    ",5,no key", // empty key
    "bad key!,5,", // invalid key
    "IONF_D,=SUM(A1:A3),", // formula
    'IONF_E,1,say "hi"', // quote inside unquoted cell
    "IONF_A,2,conflict", // duplicate with another value
  ].join("\n");
  const err = issuesOf(() => parseCalibrationCsv(text));
  assert.deepEqual(
    err.issues.map((i) => [i.line, i.code]),
    [
      [8, "quote_in_cell"],
      [3, "column_count"],
      [4, "column_count"],
      [5, "missing_key"],
      [6, "bad_key"],
      [7, "formula"],
      [9, "conflicting_key"],
    ],
  );
  assert.equal(err.totalIssues, 7);
});

test("an identical repeated key is only a warning", () => {
  const parsed = parseCalibrationCsv(["parameter_key,value", "IONF_A,1", "IONF_A,1"].join("\n"));
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.warnings[0].code, "duplicate_key");
});

test("unterminated quote is reported at the line it opens", () => {
  const err = issuesOf(() => parseCalibrationCsv(["parameter_key,value", "IONF_A,1", 'IONF_B,"2', "IONF_C,3"].join("\n")));
  assert.deepEqual(err.issues.map((i) => [i.line, i.code]), [[3, "unterminated_quote"]]);
});

test("empty, header-only and value-less files are refused", () => {
  assert.equal(issuesOf(() => parseCalibrationCsv("\uFEFF  \r\n")).issues[0].code, "empty_file");
  assert.equal(issuesOf(() => parseCalibrationCsv("parameter_key,value\r\n")).issues[0].code, "no_rows");
  assert.equal(issuesOf(() => parseCalibrationCsv("parameter_key,value\nIONF_A,\nIONF_B,\n")).issues[0].code, "no_values");
});

test("binary content (a workbook renamed to .csv) is refused", () => {
  assert.equal(issuesOf(() => parseCalibrationCsv("PK\u0003\u0004\u0000\u0000parameter_key")).issues[0].code, "binary_file");
});

test("file name: other column is refused, other equipment is a warning", () => {
  const text = ["parameter_key,value", "IONF_A,1"].join("\n");
  const wrong = issuesOf(() => parseCalibrationCsv(text, { fileName: "calibration_2_SEM_r3.csv", equipmentId: 2, type: "FIB" }));
  assert.equal(wrong.issues[0].code, "wrong_type");
  const other = parseCalibrationCsv(text, { fileName: "calibration_5_FIB_r3 (1).csv", equipmentId: 2, type: "FIB" });
  assert.equal(other.warnings[0].code, "other_equipment");
  assert.deepEqual(exportNameInfo("calibration_12_sem_r40.csv"), { equipmentId: 12, type: "SEM", revision: 40 });
  assert.equal(exportNameInfo("my-values.csv"), null);
});

test("isCalibrationCsv: by extension or by header, vendor text files are not", () => {
  assert.equal(isCalibrationCsv("calibration_1_FIB_r2.CSV", "anything"), true);
  assert.equal(isCalibrationCsv("paste.txt", "\uFEFFparameter_key;value\n"), true);
  assert.equal(isCalibrationCsv("md.TXT", "int 0 7 /* IMD_MD_INITIALIZED F */\n"), false);
  assert.equal(isCalibrationCsv("UI1280reg.txt", "\\Registry\\Machine\\Software\\Microscope\n"), false);
});

test("tokenizer and delimiter detection details", () => {
  assert.equal(detectDelimiter('"a;b",c,d'), ",");
  assert.equal(detectDelimiter("a\tb\tc"), "\t");
  const { rows, errors } = tokenizeCsv('a,"b ""q"" c" , d\n"x\r\ny",z', ",");
  assert.deepEqual(errors, []);
  assert.deepEqual(rows, [
    { line: 1, cells: ["a", 'b "q" c', "d"] },
    { line: 2, cells: ["x\ny", "z"] },
  ]);
  const bad = tokenizeCsv('a,"b"c\n', ",");
  assert.equal(bad.errors[0].code, "text_after_quote");
});
