import assert from "node:assert/strict";
import test from "node:test";

import { formatPixelDwell, summarizeScanParams } from "../.test-dist/lib/scanParamChip.js";

const byId = (summary) => Object.fromEntries(summary.items.map((item) => [item.id, item]));

test("raster chip lists beam, resolution, dwell, latency and output mode", () => {
  const summary = summarizeScanParams(
    "raster",
    { resolution: 1024, dwell: 16, latency_bytes: 16384, output_mode: "SixteenBit", frame_blank: false },
    { beamEnergyEv: 1000 },
  );
  const items = byId(summary);
  assert.equal(summary.kind, "raster");
  assert.equal(items.beamEnergy.value, "1000 eV");
  assert.equal(items.resolution.value, "1024×1024");
  assert.equal(items.dwell.value, "16 (2.13 µs/px)");
  assert.equal(items.latency.value, "16384 B");
  assert.equal(items.outputMode.value, "SixteenBit");
  assert.equal(items.frameBlank, undefined);
  assert.equal(items.grayRange, undefined);
});

test("vector chip carries scan path and the gray level filter range and mode", () => {
  const items = byId(summarizeScanParams("vector", {
    pattern: "default",
    vector_resolution: 512,
    scan_path: "horizontal_sawtooth",
    dwell: 16,
    latency_bytes: 8196,
    output_mode: "SixteenBit",
    gray_level_range: [200, 40],
    gray_level_skipped: false,
  }));
  assert.equal(items.resolution.value, "512×512");
  assert.equal(items.scanPath.valueKey, "vector.scanPath.horizontal_sawtooth");
  assert.equal(items.grayRange.value, "40–200");
  assert.equal(items.grayMode.valueKey, "roi.grayScale.confirm.mode.spot");
});

test("vector chip omits gray filter entries when the filter is off", () => {
  const items = byId(summarizeScanParams("vector", {
    pattern: "default", vector_resolution: 256, scan_path: "vertical_raster", dwell: 1, latency_bytes: 8196,
  }));
  assert.equal(items.grayRange, undefined);
  assert.equal(items.grayMode, undefined);
});

test("custom vector pattern shows the point count instead of a dwell", () => {
  const items = byId(summarizeScanParams("vector", {
    pattern: "custom", points: [[0, 0, 2], [1, 1, 2], [2, 2, 2]], dwell: 16, latency_bytes: 8196,
  }));
  assert.equal(items.resolution.valueKey, "canvas.scanParams.customPattern");
  assert.equal(items.resolution.suffix, " (3)");
  assert.equal(items.dwell, undefined);
  assert.equal(items.scanPath, undefined);
});

test("pixel dwell switches between ns and µs", () => {
  assert.equal(formatPixelDwell(0), "125.0 ns/px");
  assert.equal(formatPixelDwell(7), "1.00 µs/px");
});

test("burned-in chip segments match the on-screen label/value text", async () => {
  const { scanParamChipSegments } = await import("../.test-dist/lib/scanParamChip.js");
  const summary = summarizeScanParams(
    "vector",
    { pattern: "default", vector_resolution: 1024, scan_path: "horizontal_sawtooth", dwell: 2, latency_bytes: 8192 },
    { beamEnergyEv: 1000 },
  );
  const dict = {
    "canvas.scanParams.beamEnergy": "Beam",
    "canvas.scanParams.resolution": "Res",
    "canvas.scanParams.scanPath": "Path",
    "canvas.scanParams.dwell": "Dwell",
    "canvas.scanParams.latency": "Latency",
    "vector.scanPath.horizontal_sawtooth": "Horizontal sawtooth",
  };
  const segments = scanParamChipSegments(summary.items, (k) => dict[k] ?? k);
  assert.deepEqual(segments, [
    "Beam 1000 eV",
    "Res 1024×1024",
    "Path Horizontal sawtooth",
    "Dwell 2 (375.0 ns/px)",
    "Latency 8192 B",
  ]);
});

test("chip segments wrap greedily without splitting a segment", async () => {
  const { wrapScanParamSegments } = await import("../.test-dist/lib/scanParamChip.js");
  const measure = (s) => s.length;
  assert.deepEqual(wrapScanParamSegments(["aaaa", "bbbb", "cccc"], 11, measure, " "), ["aaaa bbbb", "cccc"]);
  assert.deepEqual(wrapScanParamSegments(["a-very-long-segment", "b"], 5, measure, " "), ["a-very-long-segment", "b"]);
  assert.deepEqual(wrapScanParamSegments([], 10, measure), []);
});

test("small scans are upscaled by an integer factor before overlays are burned in", async () => {
  const { exportScaleFactor } = await import("../.test-dist/lib/scanParamChip.js");
  assert.equal(exportScaleFactor(128, 128), 8);
  assert.equal(exportScaleFactor(256, 256), 4);
  assert.equal(exportScaleFactor(300, 300), 4);
  assert.equal(exportScaleFactor(1024, 1024), 1);
  assert.equal(exportScaleFactor(2048, 2048), 1);
  assert.equal(exportScaleFactor(0, 0), 1);
});
