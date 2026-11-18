import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseStairReceipes, readProcessingPatterns } from "../src/processingPatternsConfig";
import { validateRecipeKey } from "../src/patternRecipeRepository";
const file = path.resolve(__dirname, "../../../GlasgowDataIO/Json/stepReceipes.json");
const source = () => JSON.parse(fs.readFileSync(file, "utf8"));
test("legacy import preserves all six technology nodes and material rates", () => {
  const recipes = parseStairReceipes(source());
  assert.equal(recipes.SMProcess.nodes.length, 6);
  assert.equal(recipes.SMProcess.nodes[0].steps[2].material, "Au");
  assert.equal(recipes.SMProcess.nodes[0].steps[2].removalRateUM3PerNC, 1.5);
  assert.equal(recipes.SMProcess.nodes[0].steps[2].dwellUS, 1);
});
test("database catalogue path does not load the JSON recipe reference", () => {
  const patterns = path.join(path.dirname(file), "processingPatterns.json");
  assert.deepEqual(readProcessingPatterns(patterns, false).stairReceipes, {});
});
test("invalid equipment assignments and invalid recipes are rejected", () => {
  for (const id of [0, -1, 1.5, NaN]) assert.throws(() => validateRecipeKey(id, "stairCut"));
  assert.throws(() => validateRecipeKey(1, "../stairCut"));
  validateRecipeKey(1, "stairCut");
  for (const value of [0, -1, 10001, 1.2]) {
    const input = source(); input[0].SMProcess.stepDefaults.passes = value;
    assert.throws(() => parseStairReceipes(input));
  }
  const input = source(); input[0].SMProcess.nodes[0].steps[1].depthUM = 0.1;
  assert.throws(() => parseStairReceipes(input));
});


test("an unassigned Stair cut recipe does not prevent the catalogue from loading", async () => {
  const {getOptionalPatternRecipes} = await import("../src/patternRecipeRepository");
  const {ConfigError} = await import("../src/configManager");
  const recipes = await getOptionalPatternRecipes(1289, "stairCut", async () => {
    throw new ConfigError("No stairCut recipes assigned to equipment 1289", 404);
  });
  const catalogue = readProcessingPatterns(path.join(path.dirname(file), "processingPatterns.json"), false);
  assert.deepEqual(recipes, {});
  assert.equal(catalogue.patterns.length, 8);
  for (const status of [400, 500, 503]) {
    await assert.rejects(getOptionalPatternRecipes(1289, "stairCut", async () => {throw new ConfigError("failure", status);}), /failure/);
  }
});


test("restoration migration contains the exact Git HEAD technology nodes", () => {
  const sql = fs.readFileSync(path.resolve(__dirname, "../../../IobeamAdmin/Sql/010_restore_technology_nodes.sql"), "utf8");
  const match = sql.match(/SELECT '(.*?)'::jsonb \$body\$/s);
  assert.ok(match);
  const restored = parseStairReceipes(JSON.parse(match[1]));
  assert.deepEqual(restored.SMProcess.nodes.map(node => node.name), ["28nm", "14nm", "7nm", "5nm", "2nm", "1nm"]);
  for (const node of restored.SMProcess.nodes) {
    assert.equal(node.steps.length, 5);
    assert.deepEqual(node.steps.map(step => step.material), ["Si", "SiO2", "Au", "SiO2", "Si"]);
    assert.deepEqual(node.steps.map(step => step.removalRateUM3PerNC), [0.27, 0.24, 1.5, 0.24, 0.27]);
  }
});
