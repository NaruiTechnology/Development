import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { getProcessingCatalogueDocument } from "../src/processingCatalogueRepository";
import { parseProcessingPatterns } from "../src/processingPatternsConfig";

test("catalogue reads database values and surfaces missing or unavailable data without JSON fallback", async () => {
  const document = {Patterns: [{circle: {model: "CircleModel", roi: "circle", parameters: {passes: {type: "int", default: 7}}}}]};
  const result = await getProcessingCatalogueDocument(async sql => {
    assert.match(sql, /ionbeam_asset.processing_catalogue/);
    return JSON.stringify(document);
  });
  assert.equal(parseProcessingPatterns(result).patterns[0].parameters[0].default, 7);
  await assert.rejects(getProcessingCatalogueDocument(async () => ""), /missing from the database/);
  await assert.rejects(getProcessingCatalogueDocument(async () => { throw new Error("database offline"); }), /database offline/);
  await assert.rejects(getProcessingCatalogueDocument(async () => JSON.stringify({Patterns:[{bad:{}}]})), /Invalid database processing catalogue/);
});

test("migration seeds complete initialization metadata with three passes and preserves existing database settings", () => {
  const sql = fs.readFileSync(path.resolve(__dirname, "../../../IobeamAdmin/Sql/011_processing_catalogue.sql"), "utf8");
  const document = JSON.parse(sql.split("$catalogue$")[1]);
  const catalogue = parseProcessingPatterns(document);
  assert.deepEqual(catalogue.errors, []);
  assert.ok(catalogue.patterns.length >= 8);
  for (const pattern of catalogue.patterns) {
    const passes = pattern.parameters.find(p => p.name === "passes");
    if (passes) assert.equal(passes.default, 3);
  }
  assert.ok(catalogue.materials.length && catalogue.lensLookup && catalogue.header);
  assert.equal(document.StairReceipes, undefined);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
});
