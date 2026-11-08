import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MODEL_REGISTRY,
  patternAvgGray,
  patternBounds,
  cleaningLines,
  coerceParameter,
  resolveCatalogue,
  stairRects,
} from "../.test-dist/lib/processingPatterns.js";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const param = (over) => ({ name: "p", label: "P", type: "float", default: 1, min: null, max: null, step: 1, unit: "", choices: [], ...over });

test("parameters are coerced and clamped, unusable values throw", () => {
  assert.equal(coerceParameter(param({ type: "int", min: 2, max: 50 }), "7.4"), 7);
  assert.equal(coerceParameter(param({ type: "int", min: 2, max: 50 }), 999), 50);
  assert.equal(coerceParameter(param({ type: "bool" }), "yes"), true);
  assert.throws(() => coerceParameter(param(), "abc"));
  assert.throws(() => coerceParameter(param(), ""));
  assert.throws(() => coerceParameter(param({ type: "choice", choices: ["a", "b"] }), "c"));
});

test("rect models order the corners and reject empty areas", () => {
  const m = MODEL_REGISTRY.SolidBoxModel;
  const r = m.validateRoi({ x_start: 5, x_end: 1, y_start: 0, y_end: 2 });
  assert.deepEqual(r, { x_start: 1, x_end: 5, y_start: 0, y_end: 2 });
  assert.equal(m.area(r), 8);
  assert.ok(m.contains(r, 2, 1) && !m.contains(r, 9, 1));
  assert.throws(() => m.validateRoi({ x_start: 1, x_end: 1, y_start: 0, y_end: 2 }));
});

test("circle is a solid disk with a finite positive radius", () => {
  const m = MODEL_REGISTRY.CircleModel;
  const r = m.validateRoi({ cx: 5, cy: 5, radius: 3 });
  assert.ok(Math.abs(m.area(r) - Math.PI * 9) < 1e-9);
  assert.ok(m.contains(r, 5, 5) && m.contains(r, 8, 5) && !m.contains(r, 9, 5));
  for (const radius of [0, -1, Infinity, NaN, undefined]) {
    assert.throws(() => m.validateRoi({ cx: 5, cy: 5, radius }));
  }
  assert.throws(() => m.validateRoi({ cx: NaN, cy: 5, radius: 3 }));
});

test("ring is two concentric circles: radii ordered, area between them", () => {
  const m = MODEL_REGISTRY.RingModel;
  const r = m.validateRoi({ cx: 5, cy: 5, r_inner: 4, r_outer: 2 });
  assert.equal(r.r_inner, 2);
  assert.equal(r.r_outer, 4);
  assert.ok(Math.abs(m.area(r) - Math.PI * 12) < 1e-9);
  assert.ok(m.contains(r, 5, 8) && !m.contains(r, 5, 5) && !m.contains(r, 5, 10));
  assert.throws(() => m.validateRoi({ cx: 0, cy: 0, r_inner: 3, r_outer: 3 }));
});

test("free hand polygon closes, needs area", () => {
  const m = MODEL_REGISTRY.FreeHandModel;
  const r = m.validateRoi({ points: [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]] });
  assert.equal(r.points.length, 4);
  assert.equal(m.area(r), 16);
  assert.ok(m.contains(r, 2, 2) && !m.contains(r, 5, 5));
  assert.throws(() => m.validateRoi({ points: [[0, 0], [1, 1], [2, 2]] }));
});

test("stair cut splits into steps along the direction, cleaning lines honour spacing", () => {
  const roi = { x_start: 0, x_end: 10, y_start: 0, y_end: 10 };
  const steps = stairRects(roi, { steps: 5, direction: "down" });
  assert.equal(steps.length, 5);
  assert.equal(steps[0].y_end, 2);
  assert.equal(stairRects(roi, { steps: 5, direction: "up" })[0].y_start, 8);
  assert.equal(cleaningLines({ ...roi, y_end: 1 }, { spacing: 0.25, orientation: "horizontal" }).length, 4);
  assert.equal(cleaningLines(roi, { spacing: 0 }).length, 0);
  assert.ok(cleaningLines(roi, { spacing: 1e-6 }).length <= 500);
});

test("catalogue: unknown models and mismatched ROI kinds are reported, the rest kept", () => {
  const spec = (key, model, roi) => ({ key, model, caption: key, icon: "", roi, parameters: [] });
  const { specs, errors } = resolveCatalogue(
    [spec("a", "SolidBoxModel", "rect"), spec("b", "NopeModel", "rect"), spec("c", "RingModel", "rect")],
    ["backend problem"],
  );
  assert.deepEqual(specs.map((s) => s.key), ["a"]);
  assert.equal(errors.length, 3);
});

test("Processing tab is wired into the app: tab, panel, canvas overlay, launch-time load", () => {
  const app = read("App.tsx");
  assert.match(app, /type LeftTopTab = "scan" \| "processing" \| "calibrate";/);
  assert.match(app, /onClick=\{activateProcessingTopTab\}/);
  assert.match(app, /<ProcessingPatternsPanel disabled=\{scanControlsSafetyDisabled \|\| phase === "stopping" \|\| workflowRunning\} \/>/);
  assert.match(app, /<PatternOverlay disabled=\{scanControlsSafetyDisabled \|\| phase === "stopping" \|\| workflowRunning\} api=\{api\} \/>/);
  assert.match(app, /void dispatch\(fetchProcessingPatterns\(\)\)/);
  // the tab sits right after Scan, before Calibrate
  assert.ok(app.indexOf('t("tabs.scan")') < app.indexOf('t("tabs.processing")'));
  assert.ok(app.indexOf('t("tabs.processing")') < app.indexOf('t("tabs.calibrate")'));
});

test("every processing string exists in all three locales", () => {
  const keys = (file) => new Set([...read(`i18n/locales/${file}.ts`).matchAll(/"((?:tabs\.processing|card\.processingPattern|processing\.[\w.]+))":/g)].map((m) => m[1]));
  const en = keys("en");
  assert.ok(en.size > 20);
  for (const locale of ["zh-CN", "zh-TW"]) assert.deepEqual([...keys(locale)].sort(), [...en].sort());
});


test("AvgGray follows moved/resized ROI and refreshed samples, excludes ring holes", () => {
  const world = { x_origin: 0, x_end: 4, y_origin: 0, y_end: 4 };
  const pixels = Array.from({ length: 16 }, (_, i) => i);
  const rect = { x_start: 0, x_end: 2, y_start: 0, y_end: 2 };
  const avg = (roi, model = MODEL_REGISTRY.SolidBoxModel) => patternAvgGray(roi, model, 4, 4, world, i => pixels[i]);
  assert.equal(avg(rect), 2.5);
  assert.equal(avg({ ...rect, x_start: 2, x_end: 4 }), 4.5);
  assert.equal(avg({ ...rect, x_end: 4 }), 3.5);
  pixels.fill(100);
  assert.equal(avg(rect), 100);
  pixels[5] = pixels[6] = pixels[9] = pixels[10] = 0;
  assert.equal(avg({ cx: 2, cy: 2, r_inner: 1, r_outer: 2 }, MODEL_REGISTRY.RingModel), 100);
  assert.equal(patternAvgGray(rect, MODEL_REGISTRY.SolidBoxModel, 4, 4, world, () => null), null);
  assert.deepEqual(patternBounds({ cx: 2, cy: 3, radius: 2 }), { x_start: 0, x_end: 4, y_start: 1, y_end: 5 });
});
