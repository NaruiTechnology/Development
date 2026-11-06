import test from "node:test";
import assert from "node:assert/strict";
import { processingScanRegions } from "../.test-dist/lib/processingScanRegions.js";

const field = { x_origin: 0, x_end: 100, y_origin: 0, y_end: 100 };
test("Processing acquisition windows follow catalogue order and preserve pattern shapes", () => {
  const specs = ["rect", "ring", "free", "empty"].map((key) => ({ key }));
  const shapes = { rect: { roi: { x_start: 10, x_end: 30, y_start: 20, y_end: 40 } },
    ring: { roi: { cx: 80, cy: 30, r_inner: 5, r_outer: 25 } },
    free: { roi: { points: [[5, 5], [50, 10], [20, 35]] } }, empty: { roi: null } };
  const original = JSON.stringify(shapes);
  const plan = processingScanRegions(specs, shapes, field);
  assert.deepEqual(plan.keys, ["rect", "ring", "free"]);
  assert.deepEqual(plan.regions, [shapes.rect.roi,
    { x_start: 55, x_end: 100, y_start: 5, y_end: 55 },
    { x_start: 5, x_end: 50, y_start: 5, y_end: 35 }]);
  assert.equal(JSON.stringify(shapes), original);
  assert.deepEqual(processingScanRegions(specs, {}, field), { keys: [], regions: [] });
});
