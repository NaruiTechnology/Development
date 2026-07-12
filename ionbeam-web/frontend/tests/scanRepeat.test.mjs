import test from "node:test";
import assert from "node:assert/strict";

import { shouldClearROIFeedbackBeforeRepeat } from "../.test-dist/lib/scanRepeat.js";
import { ScanType } from "../.test-dist/types/scanType.js";

test("clears ROI gray feedback between cycles but retains the final cycle", () => {
  const repeatThreeCompletionSequence = [2, 1, 0].map((cyclesRemaining) =>
    shouldClearROIFeedbackBeforeRepeat(ScanType.CUSTOM_GRAY_FEEDBACK_BLANK, cyclesRemaining)
  );

  assert.deepEqual(repeatThreeCompletionSequence, [true, true, false]);
  assert.equal(shouldClearROIFeedbackBeforeRepeat(ScanType.CUSTOM_RASTER, 1), false);
  assert.equal(shouldClearROIFeedbackBeforeRepeat(ScanType.VECTOR, 1), false);
});
