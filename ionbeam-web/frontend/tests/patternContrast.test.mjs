import test from "node:test";
import assert from "node:assert/strict";
import { applyMaskedGrayLut, grayLevelLut } from "../.test-dist/lib/displayLevels.js";

test("pattern contrast changes only ROI pixels and leaves source and alpha intact", () => {
  const source = new Uint8ClampedArray([80,80,80,255, 80,80,80,255, 180,180,180,100]);
  const rendered = source.slice();
  const lut = grayLevelLut({low:100*256, high:150*256});
  applyMaskedGrayLut(rendered, lut, Uint8Array.of(0,1,1));
  assert.deepEqual([...rendered], [80,80,80,255, 0,0,0,255, 255,255,255,100]);
  assert.deepEqual([...source], [80,80,80,255, 80,80,80,255, 180,180,180,100]);
});

test("histogram scope switches to the selected drawn ROI even when exposure is disabled", async () => {
  const { contrastPatternSpecs } = await import("../.test-dist/lib/processingPatterns.js");
  const specs = [{key:"dark"}, {key:"bright"}, {key:"empty"}];
  const roi = {x_start:0,x_end:1,y_start:0,y_end:1};
  const instances = {dark:{roi,enabled:false}, bright:{roi}, empty:{roi:null}};
  assert.deepEqual(contrastPatternSpecs(specs, instances, "dark"), [specs[0]]);
  assert.deepEqual(contrastPatternSpecs(specs, instances, "bright"), [specs[1]]);
  assert.deepEqual(contrastPatternSpecs(specs, instances, "empty"), specs.slice(0,2));
  assert.deepEqual(contrastPatternSpecs(specs, {}, null), []);
});
