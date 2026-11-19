import test from "node:test";
import assert from "node:assert/strict";
import { patternBounds, patternDisplayBounds } from "../.test-dist/lib/processingPatterns.js";


test("circular selection bounds match the screen diameter with unequal calibrated axes", () => {
  for (const scales of [[2.5, 1.25], [1.25, 2.5]]) {
    const [sx, sy] = scales;
    for (const roi of [{ cx: 50, cy: 100, radius: 10 }, { cx: 50, cy: 100, r_inner: 5, r_outer: 10 }]) {
      const saved = { ...roi };
      const box = patternDisplayBounds(roi, sx, sy);
      assert.equal((box.x_end - box.x_start) * sx, 20 * sx);
      assert.equal((box.y_end - box.y_start) * sy, 20 * sx);
      assert.equal((box.y_start + box.y_end) / 2, roi.cy);
      assert.deepEqual(roi, saved);
      assert.equal(patternBounds(roi).y_end - patternBounds(roi).y_start, 20);
    }
  }
  const rect = { x_start: 1, x_end: 2, y_start: 3, y_end: 6 };
  assert.deepEqual(patternDisplayBounds(rect, 2, 1), rect);
});
