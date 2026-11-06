import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ConfigError } from "../src/configManager";
import { parseProcessingPatterns, readProcessingPatterns } from "../src/processingPatternsConfig";

const shipped = path.resolve(__dirname, "..", "..", "..", "GlasgowDataIO", "Json", "processingPatterns.json");

test("shipped file: seven active patterns in order, skipped ones dropped, no errors", () => {
  const cfg = readProcessingPatterns(shipped);
  assert.deepEqual(cfg.patterns.map((p) => p.key), ["solidBox", "openBox", "stairCut", "cleaningLine", "circle", "ring", "freeHand"]);
  assert.deepEqual(cfg.errors, []);
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
