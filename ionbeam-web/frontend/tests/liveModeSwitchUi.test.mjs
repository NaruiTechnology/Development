import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

// Switching Parallel/Sequential on a Live scan hands one stream over to the
// next. The panel must stay in its live-scan state across that gap, otherwise
// wedge borders and enable/disable colors flicker.
test("Parallel/Sequential handover keeps the panel and ROI overlay in the live-scan state", () => {
  const app = read("App.tsx");
  assert.match(app, /const scanActive = phase === "running" \|\| phase === "stopping" \|\| streamRestarting;/);
  assert.match(app, /\(phase === "stopping" && !streamRestarting\)/);

  const canvas = read("components/ImageCanvas.tsx");
  const overlays = canvas.match(/<ScanRegionOverlay disabled=\{!streamRestarting && /g) ?? [];
  assert.equal(overlays.length, 2);

  const controls = read("components/ScanControls.tsx");
  assert.match(controls, /infiniteScanActive \|\| targetGrayRunning \|\| streamRestarting;/);
});
