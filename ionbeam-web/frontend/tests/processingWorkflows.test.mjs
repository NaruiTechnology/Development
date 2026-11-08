import test from "node:test";
import assert from "node:assert/strict";
import { workflowPoints, DEFAULT_WORKFLOW, workflowElapsedMs, formatWorkflowElapsed } from "../.test-dist/lib/processingWorkflows.js";

const spec = { key: "box", caption: "Box", model: "SolidBoxModel" };
const field = { x_start: 0, x_end: 100, y_start: 0, y_end: 100 };
const materials = [{ name: "SiO2", brightness: 1 }];
const step = (selection) => ({ name: selection, caption: selection,
  actions: [{ name: "spot", caption: "Spot", mode: "spot", selection, thresholdMaterial: "SiO2" }] });
const even = { name: "EvenLinelCut", caption: "Even", steps: [step("dark"), step("bright")] };
const build = (workflow = even, shape = field, pattern = spec, frame = Uint16Array.from([0, 100, 100, 200], x => x << 8), ratios = materials) =>
  workflowPoints(pattern, shape, field, field, frame, 2, workflow, ratios, 3, "horizontal_sawtooth");

test("Even freezes AvgGray × material ratio and complementary Spot decisions, including equality", () => {
  const [dark, bright] = build();
  assert.equal(dark.threshold, 100);
  assert.equal(bright.threshold, 100);
  assert.equal(dark.spot, 1);
  assert.equal(bright.spot, 3);
  for (let i = 0; i < 4; i++) {
    assert.notEqual(dark.points[i][3], bright.points[i][3]);
    assert.equal(dark.points[i][2], 3);
  }
  assert.deepEqual(dark.points.map(p => p.slice(0, 2)), [[0,0],[16383,0],[0,16383],[16383,16383]]);
  assert.equal(build(even, field, spec, undefined, [{name: "SiO2", brightness: 2}])[0].threshold, 200);
});

test("Default removes gray filtering, dark and metal have one step", () => {
  assert.equal(build(DEFAULT_WORKFLOW)[0].spot, 4);
  assert.equal(build(DEFAULT_WORKFLOW)[0].threshold, null);
  for (const selection of ["dark", "bright"]) assert.equal(build({ ...even, steps: [step(selection)] }).length, 1);
});

test("shape membership blanks pixels outside a circle in both steps", () => {
  const frame = Uint16Array.from({length: 9}, (_, i) => i * 20 << 8);
  const results = workflowPoints({ ...spec, model: "CircleModel" }, {cx:50, cy:50, radius:30}, field, field,
    frame, 3, even, materials, 2, "vertical_raster");
  assert.equal(results[0].threshold, 80);
  assert.equal(results[0].spot + results[1].spot, 1);
  for (const result of results) assert.equal(result.points.filter(p => !p[3]).length, result.spot);
});

test("missing ratio, incomplete source, and an unsampled ROI fail before scanning", () => {
  assert.throws(() => build(even, field, spec, undefined, []), /brightness/);
  assert.throws(() => build(even, field, spec, new Uint16Array(1)), /complete source/);
  assert.throws(() => build(even, {x_start:40,x_end:60,y_start:40,y_end:60}), /no source pixels/);
});


test("elapsed time advances only after start and freezes at the terminal event", () => {
  assert.equal(workflowElapsedMs({}, 5000), 0);
  assert.equal(workflowElapsedMs({startedAt: 1000}, 2500), 1500);
  assert.equal(workflowElapsedMs({startedAt: 1000, finishedAt: 2500}, 9000), 1500);
  assert.equal(workflowElapsedMs({startedAt: 2000}, 1000), 0);
  assert.equal(formatWorkflowElapsed(1500), "00:01.5");
  assert.equal(formatWorkflowElapsed(61500), "01:01.5");
  assert.equal(formatWorkflowElapsed(3661500), "1:01:01.5");
});


test("ROI image and render pixel indices share the exact workflow point order", () => {
  const region = {x_start: 1, x_end: 2, y_start: 1, y_end: 2};
  const smallField = {x_start:0,x_end:3,y_start:0,y_end:3};
  const frame = Uint16Array.from({length: 16}, (_, i) => i << 8);
  const [dark, bright] = workflowPoints(spec, region, region, smallField, frame, 4, even, materials, 2, "vertical_serpentine");
  assert.deepEqual(dark.pointPixelIndices, [9,5,6,10]);
  assert.deepEqual(dark.simulationBitmap.pixels, [5,6,9,10]);
  assert.equal(dark.simulationBitmap.width, 2);
  assert.equal(dark.simulationBitmap.height, 2);
  assert.deepEqual(dark.simulationBitmap.source_roi, {x_start:5461,x_end:10922,y_start:5461,y_end:10922});
  assert.equal(dark.simulationBitmap, bright.simulationBitmap);
  assert.equal(dark.pointPixelIndices, bright.pointPixelIndices);
});
