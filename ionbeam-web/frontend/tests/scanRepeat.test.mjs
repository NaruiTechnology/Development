import test from "node:test";
import assert from "node:assert/strict";

import {
  repeatCountdownDisplay,
  shouldClearROIFeedbackBeforeRepeat,
  shouldRetainROIFeedbackOnComplete,
} from "../.test-dist/lib/scanRepeat.js";
import { ScanType } from "../.test-dist/types/scanType.js";

test("repeat countdown displays the active final cycle as one, never zero", () => {
  assert.deepEqual(
    [3, 2, 1, 0].map((remaining) => repeatCountdownDisplay(3, remaining, true)),
    [3, 2, 1, 1],
  );
  assert.equal(repeatCountdownDisplay(3, 0, false), 3);
  assert.equal(repeatCountdownDisplay(1, 0, false), 1);
});

test("clears ROI gray feedback after every non-final cycle for any repeat count", () => {
  for (const repeat of [1, 2, 3, 8]) {
    const remainingAtCompletion = Array.from(
      { length: repeat },
      (_, cycleIndex) => repeat - cycleIndex - 1
    );
    const clearSequence = remainingAtCompletion.map((cyclesRemaining) =>
      shouldClearROIFeedbackBeforeRepeat(ScanType.CUSTOM_GRAY_FEEDBACK_BLANK, cyclesRemaining)
    );

    assert.deepEqual(
      clearSequence,
      Array.from({ length: repeat }, (_, cycleIndex) => cycleIndex < repeat - 1)
    );
  }
  assert.equal(shouldClearROIFeedbackBeforeRepeat(ScanType.CUSTOM_RASTER, 1), false);
  assert.equal(shouldClearROIFeedbackBeforeRepeat(ScanType.VECTOR, 1), false);
});

test("retains only the final ROI gray-feedback cycle for any repeat count", () => {
  for (const repeat of [1, 2, 3, 8]) {
    const remainingAtCycleStart = Array.from(
      { length: repeat },
      (_, cycleIndex) => repeat - cycleIndex
    );
    const retentionSequence = remainingAtCycleStart.map((cyclesRemaining) =>
      shouldRetainROIFeedbackOnComplete(ScanType.CUSTOM_GRAY_FEEDBACK_BLANK, cyclesRemaining)
    );

    assert.deepEqual(
      retentionSequence,
      Array.from({ length: repeat }, (_, cycleIndex) => cycleIndex === repeat - 1)
    );
  }
});

test("Repeat N becomes one held session of N passes", async () => {
  const { repeatSessionRequest, MAX_REPEAT_FRAMES } = await import("../.test-dist/lib/scanRepeat.js");
  const base = { pattern: "default", dwell: 16 };
  assert.equal(repeatSessionRequest(base, 1), null);
  assert.equal(repeatSessionRequest(base, 0), null);
  const s = repeatSessionRequest(base, 7);
  assert.deepEqual(s, { req: { ...base, continuous: true, frames: 7 }, frames: 7 });
  assert.equal(base.continuous, undefined, "the caller's request is not mutated");
  assert.equal(repeatSessionRequest(base, 3.9).frames, 3);
  assert.equal(repeatSessionRequest(base, 999).frames, MAX_REPEAT_FRAMES);
});
