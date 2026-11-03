import test from "node:test";
import assert from "node:assert/strict";
import { paintVectorScanOrderOverlay } from "../.test-dist/lib/scanPathOverlay.js";

function draw(path, regions, cursor = 100) {
  const lines = [], clips = [], markers = [];
  let points = [];
  const ctx = {
    clearRect() {}, save() {}, restore() {},
    beginPath() { points = []; },
    rect(...rect) { clips.push(rect); }, clip() {},
    moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); },
    stroke() { if (points.length === 64) lines.push(points); },
    arc(x, y) { markers.push([x, y]); }, fill() {},
  };
  paintVectorScanOrderOverlay({ width: 256, getContext: () => ctx }, 64, cursor, path, regions);
  return { lines, clips, markers };
}

const roi = { x_start: 4096, x_end: 8191, y_start: 8192, y_end: 12287 };
for (const path of ["horizontal_sawtooth", "horizontal_triangle", "vertical_raster", "vertical_serpentine"]) {
  test(`${path} sweep and marker stay inside the scanned ROI`, () => {
    const { lines, clips, markers } = draw(path, [roi]);
    assert.equal(lines.length, 1);
    const [left, top, width, height] = clips[0];
    assert.ok(width < 256 && height < 256);
    for (const [x, y] of [...lines[0], ...markers]) {
      assert.ok(x >= left && x < left + width, `x ${x} outside ROI`);
      assert.ok(y >= top && y < top + height, `y ${y} outside ROI`);
    }
    if (path.startsWith("horizontal")) {
      assert.equal(new Set(lines[0].map(([, y]) => y)).size, 1);
    } else {
      assert.equal(new Set(lines[0].map(([x]) => x)).size, 1);
    }
  });
}

test("full-field scan still spans the canvas", () => {
  const { lines, clips } = draw("horizontal_sawtooth", [null]);
  assert.deepEqual(clips, [[0, 0, 256, 256]]);
  assert.equal(lines[0][0][0], 0);
  assert.equal(lines[0].at(-1)[0], 255);
});

test("parallel scans draw separate ROI-local sweeps without a connecting line", () => {
  const other = { x_start: 8192, x_end: 12287, y_start: 0, y_end: 4095 };
  const { lines, clips } = draw("horizontal_sawtooth", [roi, other]);
  assert.equal(lines.length, 2);
  assert.equal(clips.length, 2);
  lines.forEach((line, index) => {
    const [left, top, width, height] = clips[index];
    assert.ok(line.every(([x, y]) => x >= left && x < left + width && y >= top && y < top + height));
  });
});

test("round-robin cursor does not draw a region before its first sample", () => {
  assert.equal(draw("horizontal_sawtooth", [roi, roi], 1).lines.length, 1);
  assert.equal(draw("horizontal_sawtooth", [roi], 0).lines.length, 0);
});
