import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ConfigError } from "../src/configManager";
import { parseProcessingPatterns, readProcessingPatterns } from "../src/processingPatternsConfig";

const shipped = path.resolve(__dirname, "..", "..", "..", "GlasgowDataIO", "Json", "processingPatterns.json");

test("shipped file: nine active patterns in order, skipped ones dropped, no errors", () => {
  const cfg = readProcessingPatterns(shipped);
  assert.deepEqual(cfg.patterns.map((p) => p.key), ["solidBox", "openBox", "line", "stairCut", "cleaningLine", "circle", "ring", "polygon", "freeHand"]);
  assert.deepEqual(cfg.errors, []);
  assert.equal(cfg.patterns.find(p => p.key === "line")?.model, "LineModel");
  assert.equal(cfg.patterns.find(p => p.key === "line")?.parameters.find(p => p.name === "lineWidth")?.default, 0.5);
  assert.equal(cfg.patterns.find(p => p.key === "polygon")?.model, "PolygonModel");
  assert.equal(cfg.patterns.find((p) => p.key === "circle")?.roi, "circle");
  assert.equal(cfg.patterns.find((p) => p.key === "circle")?.model, "CircleModel");
  assert.equal(cfg.patterns.find((p) => p.key === "ring")?.roi, "ring");
  assert.equal(cfg.patterns.find((p) => p.key === "stairCut")?.parameters.find((q) => q.name === "steps")?.default, 5);
});

test("a malformed entry is reported and does not hide the others", () => {
  const cfg = parseProcessingPatterns({
    Patterns: [
      { a: { model: "SolidBoxModel", roi: "blob" } },
      { b: { model: "SolidBoxModel", parameters: { p: { type: "choice" } } } },
      { c: { model: "SolidBoxModel", parameters: { n: { type: "int", default: 7.4, min: 1, max: 5 } } } },
      { x: {}, y: {} },
      { c: { model: "SolidBoxModel" } },
    ],
  });
  assert.deepEqual(cfg.patterns.map((p) => p.key), ["c"]);
  assert.equal(cfg.patterns[0].parameters[0].default, 5);          // clamped, rounded
  assert.equal(cfg.errors.length, 4);
});

test("skip=true entries are not sent", () => {
  const cfg = parseProcessingPatterns({ Patterns: [{ a: { skip: true, model: "NopeModel" } }, { b: { model: "SolidBoxModel" } }] });
  assert.deepEqual(cfg.patterns.map((p) => p.key), ["b"]);
});

test("unusable files raise ConfigError", () => {
  assert.throws(() => parseProcessingPatterns({ nope: 1 }), ConfigError);
  assert.throws(() => readProcessingPatterns("/nonexistent/processingPatterns.json"), ConfigError);
});


test("pilot workflows expose validated materials and configured Spot steps", () => {
  const cfg = readProcessingPatterns(shipped);
  assert.deepEqual(cfg.workflows.map(w => w.name), ["default", "AreaRemoval", "MaterialLinelCut", "EvenLinelCut"]);
  assert.deepEqual(cfg.workflows.map(w => w.steps.length), [1, 3, 1, 2]);
  assert.equal(cfg.materials.find(m => m.name === "SiO2")?.brightness, 1);
  assert.deepEqual(cfg.workflows[3].steps.map(s => s.actions[0].selection), ["dark", "bright"]);
  assert.equal(cfg.workflows[1].steps[0].actions[0].thresholdSource, "fullScaleAverage");
  assert.equal(cfg.workflows[2].steps[0].actions[0].thresholdSource, "selectedMaterial");
  assert.ok(cfg.workflows[3].steps.every(s => s.actions[0].thresholdMaterial === undefined));
  assert.deepEqual(cfg.workflows[3].steps.map(s => s.actions[0].thresholdSource), ["roiAverage", "roiAverage"]);
  assert.throws(() => parseProcessingPatterns({ Patterns: [], Materials: [{ name: "SiO2", brightness: -1 }] }), ConfigError);
  assert.throws(() => parseProcessingPatterns({ Patterns: [], Workflows: [{ name: "bad", steps: [{name: "step", actions: [{name: "spot", mode: "spot", selection: "dark", thresholdMaterial: "missing"}]}] }] }), ConfigError);
});
