import test from "node:test";
import assert from "node:assert/strict";

import {
  clipPixelRect,
  countTargetGrayMismatches,
  grayAt,
  pixelGray,
  stepTowardTargetGray,
  targetGrayDecision,
  targetGrayFilter,
} from "../.test-dist/lib/roiTargetGray.js";

function grayImage(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

test("pixelGray keeps gray channels and uses luma for colour", () => {
  assert.equal(pixelGray(77, 77, 77), 77);
  assert.equal(pixelGray(255, 0, 0), 76);
});

test("grayAt reads the pixel under a point and ignores out-of-range or transparent pixels", () => {
  const data = grayImage(4, 4, (x, y) => x * 10 + y);
  assert.equal(grayAt(data, 4, 4, 2.7, 3.2), 23);
  assert.equal(grayAt(data, 4, 4, -1, 0), null);
  assert.equal(grayAt(data, 4, 4, 4, 0), null);
  data[3] = 0;
  assert.equal(grayAt(data, 4, 4, 0, 0), null);
});

test("clipPixelRect clips to the image and rejects empty areas", () => {
  assert.deepEqual(clipPixelRect({ left: -2.5, top: 1.2, width: 5, height: 10 }, 8, 8), {
    left: 0,
    top: 1,
    width: 3,
    height: 7,
  });
  assert.equal(clipPixelRect({ left: 9, top: 0, width: 3, height: 3 }, 8, 8), null);
});

test("looping step passes converge the ROI area to the target and leave the rest untouched", () => {
  const width = 8;
  const height = 6;
  const data = grayImage(width, height, (x, y) => (x * 37 + y * 53) % 256);
  const before = Uint8ClampedArray.from(data);
  const rect = { left: 2, top: 1, width: 4, height: 3 };
  const target = 128;

  let passes = 0;
  let remaining = countTargetGrayMismatches(data, width, rect, target);
  assert.ok(remaining > 0);
  while (remaining > 0) {
    remaining = stepTowardTargetGray(data, width, rect, target, 2).remaining;
    passes++;
    assert.ok(passes <= 128, "converges within 256 / step passes");
  }

  assert.equal(countTargetGrayMismatches(data, width, rect, target), 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
      const i = (y * width + x) * 4;
      if (inside) {
        assert.deepEqual([data[i], data[i + 1], data[i + 2]], [target, target, target]);
      } else {
        assert.deepEqual(
          [data[i], data[i + 1], data[i + 2], data[i + 3]],
          [before[i], before[i + 1], before[i + 2], before[i + 3]],
        );
      }
    }
  }
});

test("each pass moves a pixel at most maxStep gray levels", () => {
  const data = grayImage(1, 1, () => 10);
  const rect = { left: 0, top: 0, width: 1, height: 1 };
  assert.equal(stepTowardTargetGray(data, 1, rect, 200, 4).remaining, 1);
  assert.equal(data[0], 14);
  assert.equal(stepTowardTargetGray(data, 1, rect, 15, 4).remaining, 0);
  assert.equal(data[0], 15);
});

test("SPOT/SKIP is decided per pixel by comparing its gray with the target", () => {
  assert.equal(targetGrayDecision(128, 128), "skip");
  assert.equal(targetGrayDecision(127, 128), "spot");
  assert.equal(targetGrayDecision(129, 128), "spot");
  assert.deepEqual(targetGrayFilter(128.4), { selection: [128, 128], skipped: true });
  assert.deepEqual(targetGrayFilter(300), { selection: [255, 255], skipped: true });
});

test("each pass re-decides every ROI pixel: matching pixels are skipped and left unchanged", () => {
  // 3x1 ROI: one pixel already at target, one below, one above.
  const width = 5;
  const data = grayImage(width, 1, (x) => [9, 100, 50, 150, 9][x]);
  const rect = { left: 1, top: 0, width: 3, height: 1 };
  const decisions = new Uint8Array(width).fill(7);

  const first = stepTowardTargetGray(data, width, rect, 100, 10, decisions);
  assert.deepEqual(first, { spot: 2, skip: 1, remaining: 2 });
  assert.deepEqual([...decisions], [7, 0, 1, 1, 7], "outside pixels get no decision");
  assert.deepEqual([data[4], data[8], data[12]], [100, 60, 140]);
  assert.deepEqual([data[0], data[16]], [9, 9], "outside pixels untouched");

  // Run to convergence; the SPOT count can only fall and ends at zero.
  let pass = first;
  let lastSpot = pass.spot;
  while (pass.remaining > 0) {
    pass = stepTowardTargetGray(data, width, rect, 100, 10, decisions);
    assert.ok(pass.spot <= lastSpot);
    lastSpot = pass.spot;
  }
  const settled = stepTowardTargetGray(data, width, rect, 100, 10, decisions);
  assert.deepEqual(settled, { spot: 0, skip: 3, remaining: 0 });
  assert.deepEqual([...decisions], [7, 0, 0, 0, 7]);
});

test("colour pixels are compared by their gray value, not raw channels", () => {
  const data = new Uint8ClampedArray([255, 0, 0, 255]); // luma 76
  const rect = { left: 0, top: 0, width: 1, height: 1 };
  assert.equal(countTargetGrayMismatches(data, 1, rect, 76), 0);
  assert.deepEqual(stepTowardTargetGray(data, 1, rect, 76), { spot: 0, skip: 1, remaining: 0 });
});
