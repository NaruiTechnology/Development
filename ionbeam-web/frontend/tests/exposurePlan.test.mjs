import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLensLookup, lookupSpotSize } from "../.test-dist/lib/lensLookup.js";
import { pointSpacingUM, overlapPctFromSpacing, chargePerSpotNC, dosePerPass, passesForDose, doseFromDepth, depthFromDose,
  latticeSpec, latticeCells, countSpots, exposureSpots, planExposure, exposureVectorPoints } from "../.test-dist/lib/exposurePlan.js";

const lens = parseLensLookup(JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url))).LensLookup);
const box = { model: "SolidBoxModel", caption: "Box" };
const circle = { model: "CircleModel", caption: "Circle" };
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);

test("overlap and spacing follow OL = (d - s) / d from the FEI beam-overlap slide", () => {
  near(pointSpacingUM(0.035, 50), 0.0175);
  near(pointSpacingUM(0.035, 0), 0.035);      // etching / depositing
  near(pointSpacingUM(0.035, -50), 0.0525);   // large gas patterns
  near(overlapPctFromSpacing(0.035, 0.0175), 50);
  assert.throws(() => pointSpacingUM(0.035, 100));
  assert.throws(() => pointSpacingUM(0, 50));
});

test("spot size comes from the lens table by beam current, not from image pixels", () => {
  const spot = lookupSpotSize(lens, 30, 150);
  near(spot.spotSizeUM, 0.035);
  near(pointSpacingUM(spot.spotSizeUM, 50), 0.0175);
});

test("dose arithmetic: pA*us -> nC, per-pass dose, passes, depth via removal rate", () => {
  near(chargePerSpotNC(150, 1), 1.5e-4);
  near(dosePerPass(150, 1, 0.0175), 1.5e-4 / (0.0175 ** 2));
  assert.equal(passesForDose(1, dosePerPass(150, 1, 0.0175)), 3);
  assert.equal(passesForDose(0.1, 5), 1);
  near(doseFromDepth(1, 0.15), 1 / 0.15);
  near(depthFromDose(doseFromDepth(2, 0.3), 0.3), 2);
  assert.throws(() => doseFromDepth(1, 0));
});

test("rectangle lattice has an integral number of spots, centred in cells, serpentine order", () => {
  const roi = { x_start: 0, x_end: 1, y_start: 0, y_end: 0.5 };
  const l = latticeSpec(roi, 0.25);
  assert.deepEqual([l.nx, l.ny, l.axis], [4, 2, "x"]);
  const cells = [...latticeCells(l)];
  assert.deepEqual(cells.map(c => c.join(",")), ["0,0", "1,0", "2,0", "3,0", "3,1", "2,1", "1,1", "0,1"]);
  const spots = exposureSpots(box, roi, l);
  assert.deepEqual(spots[0], [0.125, 0.125]);
  assert.deepEqual(spots[4], [0.875, 0.375]);
  // a tall rectangle scans along y
  assert.equal(latticeSpec({ x_start: 0, x_end: 0.5, y_start: 0, y_end: 1 }, 0.25).axis, "y");
  assert.equal(latticeSpec(roi, 0.25, "y").axis, "y");
});

test("count follows the true shape and is independent of any image resolution", () => {
  const disk = { cx: 0, cy: 0, radius: 1 };
  const l = latticeSpec(disk, 0.05);
  const { count, exact } = countSpots(circle, disk, l);
  assert.equal(exact, true);
  assert.ok(Math.abs(count - Math.PI / 0.05 ** 2) / (Math.PI / 0.05 ** 2) < 0.01);
  assert.equal(exposureSpots(circle, disk, l).length, count);
  const huge = latticeSpec({ x_start: 0, x_end: 1e4, y_start: 0, y_end: 1e4 }, 1);
  assert.equal(countSpots(box, { x_start: 0, x_end: 1e4, y_start: 0, y_end: 1e4 }, huge).exact, false);
});

test("exposure bounds and degenerate patterns are rejected explicitly", () => {
  const roi = { x_start: 0, x_end: 100, y_start: 0, y_end: 100 };
  assert.throws(() => exposureSpots(box, roi, latticeSpec(roi, 0.1)), /exceeds/);
  const tiny = { cx: 0, cy: 0, radius: 0.001 };
  assert.throws(() => exposureSpots(circle, tiny, { nx: 1, ny: 1, pitchX: 1, pitchY: 1, x0: 5, y0: 5, axis: "x" }), /no beam spots/);
});

test("planExposure: spot size, spacing, count, passes and beam-on time for the screenshot pattern", () => {
  const roi = { x_start: 0, x_end: 42.85, y_start: 0, y_end: 48.03 };
  const plan = planExposure(box, roi, { beamCurrentPA: 150, spotDiameterUM: 0.035, overlapPct: 50, dwellUS: 1, dose: 1 });
  near(plan.spacingUM, 0.0175, 1e-4);
  assert.ok(Math.abs(plan.count - 42.85 * 48.03 / 0.0175 ** 2) / plan.count < 1e-3);
  assert.equal(plan.passes, 3);
  assert.ok(plan.deliveredDose >= 1 && plan.deliveredDose < 1.6);
  near(plan.beamOnS, plan.count * 1e-6 * plan.passes, 1e-9);
  // explicit passes override the dose-derived value
  assert.equal(planExposure(box, roi, { beamCurrentPA: 150, spotDiameterUM: 0.035, overlapPct: 50, dwellUS: 1, dose: 1, passes: 7 }).passes, 7);
});

test("doubling beam current halves beam-on time at fixed dose; unit scale is honoured", () => {
  const roi = { x_start: 0, x_end: 4, y_start: 0, y_end: 4 };
  const a = planExposure(box, roi, { beamCurrentPA: 100, spotDiameterUM: 0.1, overlapPct: 50, dwellUS: 1, dose: 100 });
  const b = planExposure(box, roi, { beamCurrentPA: 200, spotDiameterUM: 0.1, overlapPct: 50, dwellUS: 1, dose: 100 });
  assert.equal(a.passes, 2 * b.passes);
  // the same physical area expressed in nm world units gives the same count
  const nm = planExposure(box, { x_start: 0, x_end: 4000, y_start: 0, y_end: 4000 }, { beamCurrentPA: 100, spotDiameterUM: 0.1, overlapPct: 50, dwellUS: 1, dose: 100 }, { umPerWorld: 0.001 });
  assert.equal(nm.count, a.count);
  assert.throws(() => planExposure(box, roi, { beamCurrentPA: 0, spotDiameterUM: 0.1, overlapPct: 50, dwellUS: 1, dose: 1 }));
});

test("DAC-finer-than-LSB spacing warns and merged spots keep their dwell", () => {
  const roi = { x_start: 0, x_end: 1, y_start: 0, y_end: 1 };
  const plan = planExposure(box, roi, { beamCurrentPA: 150, spotDiameterUM: 0.001, overlapPct: 50, dwellUS: 1, dose: 1 }, { fieldWidthUM: 1000 });
  assert.ok(plan.warnings.some(w => /DAC step/.test(w)));
  const pts = exposureVectorPoints([[0, 0], [0.1, 0], [10, 0]], 7, (x, y) => ({ x: Math.round(x), y }));
  assert.deepEqual(pts, [[0, 0, 15, false, 1], [10, 0, 7, false, 1]]);
});
