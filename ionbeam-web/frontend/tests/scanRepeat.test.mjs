import test from "node:test";
import assert from "node:assert/strict";

import { shouldClearROIFeedbackBeforeRepeat } from "../.test-dist/lib/scanRepeat.js";
import { ScanType } from "../.test-dist/types/scanType.js";

test("clears ROI gray feedback only for the gray-feedback repeat loop", () => {
  assert.equal(shouldClearROIFeedbackBeforeRepeat(ScanType.CUSTOM_GRAY_FEEDBACK_BLANK), true);
  assert.equal(shouldClearROIFeedbackBeforeRepeat(ScanType.CUSTOM_RASTER), false);
  assert.equal(shouldClearROIFeedbackBeforeRepeat(ScanType.VECTOR), false);
});
