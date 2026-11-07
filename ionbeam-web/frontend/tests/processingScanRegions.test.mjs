import test from "node:test";
import assert from "node:assert/strict";
import { processingScanRegions } from "../.test-dist/lib/processingScanRegions.js";

const field = { x_origin: 0, x_end: 100, y_origin: 0, y_end: 100 };
test("Processing acquisition windows follow catalogue order and preserve pattern shapes", () => {
  const specs = ["rect", "circle", "ring", "free", "empty"].map((key) => ({ key }));
  const shapes = { rect: { roi: { x_start: 10, x_end: 30, y_start: 20, y_end: 40 } },
    ring: { roi: { cx: 80, cy: 30, r_inner: 5, r_outer: 25 } },
    circle: { roi: { cx: 10, cy: 10, radius: 15 } },
    free: { roi: { points: [[5, 5], [50, 10], [20, 35]] } }, empty: { roi: null } };
  const original = JSON.stringify(shapes);
  const plan = processingScanRegions(specs, shapes, field);
  assert.deepEqual(plan.keys, ["rect", "circle", "ring", "free"]);
  assert.deepEqual(plan.regions, [shapes.rect.roi,
    { x_start: 0, x_end: 25, y_start: 0, y_end: 25 },
    { x_start: 55, x_end: 100, y_start: 5, y_end: 55 },
    { x_start: 5, x_end: 50, y_start: 5, y_end: 35 }]);
  assert.equal(JSON.stringify(shapes), original);
  assert.deepEqual(processingScanRegions(specs, {}, field), { keys: [], regions: [] });
});

test("disabled patterns are skipped without discarding their ROIs", () => {
  const roi = { x_start: 10, x_end: 30, y_start: 20, y_end: 40 };
  const specs = [{ key: "off" }, { key: "on" }];
  const instances = { off: { enabled: false, roi }, on: { enabled: true, roi } };
  assert.deepEqual(processingScanRegions(specs, instances, field), { keys: ["on"], regions: [roi] });
  instances.on.enabled = false;
  assert.deepEqual(processingScanRegions(specs, instances, field), { keys: [], regions: [] });
  instances.off.enabled = true;
  assert.deepEqual(processingScanRegions(specs, instances, field), { keys: ["off"], regions: [roi] });
});
