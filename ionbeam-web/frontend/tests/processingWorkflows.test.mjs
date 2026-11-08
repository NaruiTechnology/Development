import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workflowPoints, DEFAULT_WORKFLOW, workflowElapsedMs, formatWorkflowElapsed } from "../.test-dist/lib/processingWorkflows.js";

const spec = { key: "box", caption: "Box", model: "SolidBoxModel" };
const field = { x_start: 0, x_end: 100, y_start: 0, y_end: 100 };
const materials = [{ name: "SiO2", brightness: 1 }];
const step = (selection) => ({ name: selection, caption: selection,
  actions: [{ name: "spot", caption: "Spot", mode: "spot", selection, thresholdSource: "roiAverage" }] });
const even = { name: "EvenLinelCut", caption: "Even", steps: [step("dark"), step("bright")] };
const build = (workflow = even, shape = field, pattern = spec, frame = Uint16Array.from([0, 100, 100, 200], x => x << 8), ratios = materials) =>
  workflowPoints(pattern, shape, field, field, frame, 2, workflow, ratios, 3, "horizontal_sawtooth");

test("Even range-filters Spot: dark is [spectrum min, ROI average], bright is [ROI average, spectrum max]", () => {
  const [dark, bright] = build();
  assert.equal(dark.threshold, 100);
  assert.equal(bright.threshold, 100);
  assert.deepEqual(dark.grayRange, [0, 100]);
  assert.deepEqual(bright.grayRange, [100, 200]);
  assert.equal(dark.targetGrayLevel, 100);
  assert.equal(bright.targetGrayLevel, 100);
  assert.equal(dark.spot, 3);
  assert.equal(bright.spot, 3);
  assert.deepEqual(dark.points.map(p => p[3]), [false, false, false, true]);
  assert.deepEqual(bright.points.map(p => p[3]), [true, false, false, false]);
  for (const point of [...dark.points, ...bright.points]) assert.equal(point[2], 3);
  assert.deepEqual(dark.points.map(p => p.slice(0, 2)), [[0,0],[16383,0],[0,16383],[16383,16383]]);
});

test("Even bounds come from the image spectrum, not 0..255", () => {
  // spectrum 40..200 with ROI average 120 -> dark [40,120], bright [120,200]; 40 and 200 are the extremes present.
  const frame = Uint16Array.from([40, 100, 140, 200], x => x << 8);
  const [dark, bright] = build(even, field, spec, frame);
  assert.deepEqual(dark.grayRange, [40, 120]);
  assert.deepEqual(bright.grayRange, [120, 200]);
  assert.deepEqual(dark.points.map(p => p[3]), [false, false, true, true]);
  assert.deepEqual(bright.points.map(p => p[3]), [true, true, false, false]);
  assert.equal(dark.targetGrayLevel, 120);
  assert.equal(bright.targetGrayLevel, 120);
  assert.equal(dark.targetGrayFrames, Math.ceil((120 - 40) / 2) + 1);
});

test("Even includes the boundary level in both ranges, like the ROI gray-level selection", () => {
  const [dark, bright] = build();
  assert.deepEqual([dark.points[1][3], dark.points[2][3]], [false, false]);
  assert.deepEqual([bright.points[1][3], bright.points[2][3]], [false, false]);
});

test("shipped EvenLinelCut uses the ROI average and image spectrum for both Spot steps", () => {
  const config = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url)));
  const workflow = config.Workflows.find(w => w.name === "EvenLinelCut");
  const [dark, bright] = build(workflow, field, spec, Uint16Array.from([0, 100, 100, 200], x => x << 8),
    [{ name: "SiO2", brightness: 1 }, { name: "Cu", brightness: 2 }]);
  assert.equal(dark.threshold, 100);
  assert.equal(bright.threshold, 100);
  assert.deepEqual(dark.grayRange, [0, 100]);
  assert.deepEqual(bright.grayRange, [100, 200]);
  assert.deepEqual(dark.points.map(p => p[3]), [false, false, false, true]);
  assert.deepEqual(bright.points.map(p => p[3]), [true, false, false, false]);
  for (const result of [dark, bright]) {
    assert.ok(result.targetGrayFrames >= 1);
    assert.equal(result.step.actions[0].thresholdSource, "roiAverage");
  }
});

test("Default removes gray filtering, dark and metal have one step", () => {
  assert.equal(build(DEFAULT_WORKFLOW)[0].spot, 4);
  assert.equal(build(DEFAULT_WORKFLOW)[0].threshold, null);
  for (const selection of ["dark", "bright"]) assert.equal(build({ ...even, steps: [step(selection)] }).length, 1);
});

test("MaterialLinelCut uses the selected material brightness", () => {
  const workflow = { ...even, name: "MaterialLinelCut", steps: [{ ...step("bright"), actions: [{ ...step("bright").actions[0], thresholdMaterial: undefined, thresholdSource: "selectedMaterial" }] }] };
  const result = workflowPoints(spec, field, field, field, Uint16Array.from([0, 100, 100, 200], x => x << 8),
    2, workflow, [{ name: "SiO2", brightness: 1 }, { name: "Cu", brightness: 1.5 }], 3, "horizontal_sawtooth", undefined, "Cu")[0];
  assert.equal(result.threshold, 150);
  assert.equal(result.spot, 1);
  assert.equal(result.targetGrayFrames, 26);
  assert.deepEqual(result.points.map(point => point[3]), [true, true, true, false]);
});

test("MaterialLinelCut rounds and clamps target gray and masks simulation pixels outside its shape", () => {
  const workflow = { ...even, name: "MaterialLinelCut", steps: [{ ...step("bright"), actions: [{ ...step("bright").actions[0], thresholdMaterial: undefined, thresholdSource: "selectedMaterial" }] }] };
  const result = workflowPoints({ ...spec, model: "CircleModel" }, {cx:50, cy:50, radius:30}, field, field,
    Uint16Array.from({ length: 9 }, (_, x) => x * 40 << 8), 3, workflow,
    [{ name: "Cu", brightness: 3 }], 3, "horizontal_sawtooth", undefined, "Cu")[0];
  assert.equal(result.threshold, 255);
  assert.equal(result.spot, 0);
  assert.equal(result.targetGrayFrames, 1);
  assert.ok(result.simulationBitmap.pixels.some(pixel => typeof pixel !== "number" && pixel.isSkipped));
});

test("shape membership blanks pixels outside a circle in both steps", () => {
  const frame = Uint16Array.from({length: 9}, (_, i) => i * 20 << 8);
  const results = workflowPoints({ ...spec, model: "CircleModel" }, {cx:50, cy:50, radius:30}, field, field,
    frame, 3, even, materials, 2, "vertical_raster");
  assert.equal(results[0].threshold, 80);
  assert.equal(results[0].spot + results[1].spot, 2);
  for (const result of results) assert.equal(result.points.filter(p => !p[3]).length, result.spot);
});

test("missing ratio, incomplete source, and an unsampled ROI fail before scanning", () => {
  const materialWorkflow = { ...even, steps: [{ ...step("bright"),
    actions: [{ ...step("bright").actions[0], thresholdSource: undefined, thresholdMaterial: "SiO2" }] }] };
  assert.throws(() => build(materialWorkflow, field, spec, undefined, []), /brightness/);
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
  assert.deepEqual(dark.pointPixelIndices, bright.pointPixelIndices);
});
