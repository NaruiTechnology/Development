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

test("TypeScript lattice matches the shared golden fixture the Python service is also tested against", () => {
  const golden = JSON.parse(readFileSync(new URL("../../../glasgow_service/tests/fixtures/lattice_golden.json", import.meta.url)));
  for (const c of golden) {
    const spec = { model: c.model, caption: c.name };
    const l = latticeSpec(c.roi, c.pitch, c.axis), spots = exposureSpots(spec, c.roi, l), e = c.expected;
    assert.deepEqual([l.nx, l.ny, l.axis, spots.length, countSpots(spec, c.roi, l).count], [e.nx, e.ny, e.axis, e.spotCount, e.count], c.name);
    near(l.pitchX, e.pitchX); near(l.pitchY, e.pitchY);
    spots.slice(0, 6).forEach((p, i) => { near(p[0], e.head[i][0]); near(p[1], e.head[i][1]); });
    spots.slice(-6).forEach((p, i) => { near(p[0], e.tail[i][0]); near(p[1], e.tail[i][1]); });
  }
});

import { buildLatticeRequest, linearDacMap } from "../.test-dist/lib/latticeRequest.js";
test("lattice request converts um pitch to DAC codes per axis and keeps shapes round on a linear map", () => {
  const map = linearDacMap({ x_origin: 0, x_end: 1000, y_origin: 0, y_end: 500 });
  const plan = { spacingUM: 0.5, passes: 3 };
  const rect = buildLatticeRequest({ x_start: 100, x_end: 200, y_start: 50, y_end: 100 }, plan, 7, map, { widthUM: 1000, heightUM: 500 });
  assert.equal(rect.shape.kind, "rect");
  near(rect.shape.x0, 1638.3); near(rect.shape.x1, 3276.6); near(rect.shape.y0, 1638.3);
  near(rect.pitch_x, 0.5 / (1000 / 16383)); near(rect.pitch_y, 0.5 / (500 / 16383));
  assert.deepEqual([rect.dwell, rect.passes, rect.axis], [7, 3, "long"]);
  const disk = buildLatticeRequest({ cx: 500, cy: 250, radius: 100 }, plan, 7, map, { widthUM: 1000, heightUM: 500 });
  assert.equal(disk.shape.kind, "ellipse");
  near(disk.shape.rx, 1638.3); near(disk.shape.ry, 3276.6); // anisotropic DAC scale -> ellipse
  const ring = buildLatticeRequest({ cx: 500, cy: 250, r_inner: 50, r_outer: 100 }, plan, 7, map, { widthUM: 1000, heightUM: 500 });
  near(ring.shape.inner_rx, 819.15);
  const rotated = { linear: false, toDac: (x, y) => ({ x: x + y, y: y }) };
  assert.equal(buildLatticeRequest({ cx: 5, cy: 5, radius: 2 }, plan, 7, rotated, { widthUM: 10, heightUM: 10 }).shape.kind, "polygon");
  assert.throws(() => buildLatticeRequest({ cx: 5, cy: 5, r_inner: 1, r_outer: 2 }, plan, 7, rotated, { widthUM: 10, heightUM: 10 }), /ring/);
  assert.throws(() => buildLatticeRequest({ x_start: 0, x_end: 1, y_start: 0, y_end: 1 }, plan, 7, map, { widthUM: 0, heightUM: 5 }));
});
