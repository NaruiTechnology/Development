import test from "node:test";
import assert from "node:assert/strict";

import {
  clipPixelRect,
  countTargetGrayMismatches,
  grayAt,
  pixelGray,
  stepTowardTargetGray,
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
    remaining = stepTowardTargetGray(data, width, rect, target, 2);
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
  assert.equal(stepTowardTargetGray(data, 1, rect, 200, 4), 1);
  assert.equal(data[0], 14);
  assert.equal(stepTowardTargetGray(data, 1, rect, 15, 4), 0);
  assert.equal(data[0], 15);
});
