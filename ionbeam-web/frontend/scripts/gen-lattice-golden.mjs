// Regenerates glasgow_service/tests/fixtures/lattice_golden.json from the TypeScript planner.
// Run from ionbeam-web/frontend after `npm run test:compile`:  node scripts/gen-lattice-golden.mjs
import { writeFileSync } from "node:fs";
import { latticeSpec, exposureSpots, countSpots } from "../.test-dist/lib/exposurePlan.js";

export const cases = [
  { name: "wide-box", model: "SolidBoxModel", roi: { x_start: 0, x_end: 1, y_start: 0, y_end: 0.5 }, pitch: 0.25, axis: "long" },
  { name: "tall-box", model: "SolidBoxModel", roi: { x_start: 2, x_end: 3.1, y_start: 1, y_end: 4.3 }, pitch: 0.37, axis: "long" },
  { name: "forced-y", model: "SolidBoxModel", roi: { x_start: 0, x_end: 2.3, y_start: 0, y_end: 1.9 }, pitch: 0.41, axis: "y" },
  { name: "disk", model: "CircleModel", roi: { cx: 5, cy: 5, radius: 3.3 }, pitch: 0.37, axis: "long" },
  { name: "ring", model: "RingModel", roi: { cx: 5, cy: 4, r_inner: 1.7, r_outer: 3.1 }, pitch: 0.29, axis: "long" },
  { name: "freehand", model: "FreeHandModel", roi: { points: [[0, 0], [4.1, 0.6], [3.3, 3.7], [1.2, 2.9], [0.4, 1.7]] }, pitch: 0.23, axis: "x" },
];

const out = cases.map(c => {
  const spec = { model: c.model, caption: c.name };
  const l = latticeSpec(c.roi, c.pitch, c.axis);
  const spots = exposureSpots(spec, c.roi, l);
  return { ...c, expected: { nx: l.nx, ny: l.ny, pitchX: l.pitchX, pitchY: l.pitchY, axis: l.axis,
    count: countSpots(spec, c.roi, l).count, spotCount: spots.length, head: spots.slice(0, 6), tail: spots.slice(-6) } };
});
writeFileSync(new URL("../../../glasgow_service/tests/fixtures/lattice_golden.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${out.length} cases`);
