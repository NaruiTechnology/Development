import test from "node:test";
import assert from "node:assert/strict";

import {
  DAC_CENTER,
  DAC_MAX,
  NO_CORRECTION,
  SCAN_GEOMETRY_KEYS,
  buildScanGeometry,
  dacToWorld,
  decompose,
  dimensionBoundsFromGeometry,
  fitFiducials,
  foldScaleIntoHfov,
  hardwareTransform,
  interpolateHfovM,
  parseScanGeometryConfig,
  pixelToDac,
  pixelToWorld,
  resolveScanGeometryInputs,
  scanGeometryResults,
  toAppliedGeometry,
  worldRectToDacROI,
  worldToDac,
  worldToPixel,
} from "../.test-dist/lib/scanGeometry.js";
import { worldSelectionToDacROI } from "../.test-dist/lib/roiDac.js";

const K = SCAN_GEOMETRY_KEYS.FIB;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (tol ${tol})`);

function resolve(profileValues = {}, overrides = {}, magCalibration = {}, stream = { resolution: 1024, dwell: 15 }) {
  return resolveScanGeometryInputs({ type: "FIB", profileValues, magCalibration, stream, overrides: { magnification: 1000, ...overrides } });
}

test("HFOV interpolation: exact points, log-log between, 1/mag outside", () => {
  const pts = { 1000: 100e-6, 10000: 10e-6 };
  close(interpolateHfovM(pts, 1000), 100e-6, 1e-15);
  close(interpolateHfovM(pts, 3162.2776601683795), 31.6227766e-6, 1e-12, "geometric midpoint");
  close(interpolateHfovM(pts, 500), 200e-6, 1e-15, "below table");
  close(interpolateHfovM(pts, 20000), 5e-6, 1e-15, "above table");
  assert.equal(interpolateHfovM({}, 1000), null);
});

test("inputs: profile beats streamData, overrides beat profile, sources are reported", () => {
  const r = resolve({ [K.pixelsX]: 2048, [K.pixelsY]: 1536, [K.rotationOffsetDeg]: 1.5, [K.yxAspect]: 1.02 });
  assert.equal(r.inputs.pixelsX, 2048);
  assert.equal(r.inputs.pixelsY, 1536);
  assert.equal(r.sources.pixelsX, "profile");
  assert.equal(r.inputs.rotationOffsetDeg, 1.5);
  assert.equal(r.inputs.yxAspect, 1.02);

  const o = resolve({ [K.pixelsX]: 2048 }, { pixelsX: 512 });
  assert.equal(o.inputs.pixelsX, 512);
  assert.equal(o.sources.pixelsX, "override");
  assert.equal(o.inputs.pixelsY, 1024);
  assert.equal(o.sources.pixelsY, "streamData");

  const alt = resolve({ [K.scanWidth]: 768, [K.scanLines]: 512 });
  assert.deepEqual([alt.inputs.pixelsX, alt.inputs.pixelsY], [768, 512]);
});

test("inputs: unset vendor aspect (0) falls back to 1 with a warning; HFOV source order", () => {
  const r = resolve({ [K.yxAspect]: 0 });
  assert.equal(r.inputs.yxAspect, 1);
  assert.ok(r.warnings.includes("yxAspect_ignored"));

  assert.equal(resolve({}, {}, { 1000: 120e-6 }).hfovSource, "magCalibration");
  close(resolve({}, {}, { 1000: 120e-6 }).inputs.hfovUm, 120, 1e-9);
  const vendor = resolve({ [K.photoImageHeightMm]: 96 });
  assert.equal(vendor.hfovSource, "vendorEstimate");
  close(vendor.inputs.hfovUm, 96, 1e-9, "96 mm / 1000 = 96 µm");
  assert.equal(resolve({}, { hfovUm: 50 }, { 1000: 120e-6 }).hfovSource, "override");
  assert.equal(resolve().hfovSource, "default");
});

test("nominal geometry: scale factor, pixel size, FOV, centre at stage origin", () => {
  const { inputs } = resolve({}, { hfovUm: 163.84, stageOriginUm: [100, -50] });
  const g = buildScanGeometry(inputs);
  const r = scanGeometryResults(g);
  close(r.scaleUmPerCode[0], 0.01, 1e-12, "163.84 µm / 16384 codes");
  close(r.pixelSizeNm[0], 160, 1e-9, "16 codes/px at 1024 px");
  close(r.fovUm[1], 163.84, 1e-9);
  close(r.center[0], 100, 1e-9);
  close(r.center[1], -50, 1e-9);
  assert.equal(r.rotationDeg, 0);
  assert.equal(r.mirrored, false);
  // round trips
  const w = dacToWorld(g, [1234, 15000]);
  const d = worldToDac(g, w);
  close(d[0], 1234, 1e-7);
  close(d[1], 15000, 1e-7);
  const p = worldToPixel(g, pixelToWorld(g, [10, 900]));
  close(p[0], 10, 1e-9);
  close(p[1], 900, 1e-9);
  assert.deepEqual(pixelToDac(inputs, [512, 1]), [8192, 16]);
});

test("rotation, aspect and tilt enter the model", () => {
  const { inputs } = resolve({ [K.rotationOffsetDeg]: 10, [K.yxAspect]: 1.1 }, { hfovUm: 100, scanRotationDeg: 5 });
  const r = scanGeometryResults(buildScanGeometry(inputs));
  close(r.rotationDeg, 15, 1e-9);
  close(r.fovUm[1] / r.fovUm[0], 1.1, 1e-9);

  const tilted = resolve({ [K.beamTiltDeg]: 52 }, { hfovUm: 100, tiltCorrection: { enabled: true, stageTiltDeg: 0 } });
  const rt = scanGeometryResults(buildScanGeometry(tilted.inputs));
  close(rt.fovUm[1], 100 / Math.cos((52 * Math.PI) / 180), 1e-9);
  const flat = resolve({ [K.beamTiltDeg]: 52 }, { hfovUm: 100, tiltCorrection: { enabled: true, stageTiltDeg: 52 } });
  close(scanGeometryResults(buildScanGeometry(flat.inputs)).fovUm[1], 100, 1e-9);
});

test("hardware transform matches the gateware (swap, then 16383 - code)", () => {
  assert.deepEqual(hardwareTransform({ xflip: false, yflip: false, rotate90: false }), [1, 0, 0, 1]);
  const t = hardwareTransform({ xflip: true, yflip: false, rotate90: true });
  // commanded (x, y) -> output x' = 16383 - y, y' = x ; around the centre: (u, v) -> (-v, u)
  const u = 100, v = 250;
  assert.deepEqual([t[0] * u + t[1] * v, t[2] * u + t[3] * v], [-v, u]);
  const { inputs } = resolve({}, { hfovUm: 100 }, {}, { resolution: 1024, transforms: { xflip: true } });
  assert.equal(scanGeometryResults(buildScanGeometry(inputs)).mirrored, true);
});

/** Synthesize fiducials from a known "true" frame and check the fit recovers it. */
function trueFrame() {
  const { inputs } = resolve({}, { hfovUm: 100, stageOriginUm: [2000, 3000] });
  // truth: 3 % bigger in X, 1 % smaller in Y, rotated 0.8°, slight shear, centre off by (+40, -25) codes
  const th = (0.8 * Math.PI) / 180;
  const R = [Math.cos(th), -Math.sin(th), Math.sin(th), Math.cos(th)];
  const U = [1.03, 0.004, 0, 0.99];
  const C = [R[0] * U[0] + R[1] * U[2], R[0] * U[1] + R[1] * U[3], R[2] * U[0] + R[3] * U[2], R[2] * U[1] + R[3] * U[3]];
  return { inputs, truth: buildScanGeometry(inputs, { matrix: C, dacOffset: [40, -25] }), C };
}

test("affine fit recovers scale, rotation, shear and offset exactly from clean fiducials", () => {
  const { inputs, truth, C } = trueFrame();
  const pixels = [[50, 60], [980, 40], [990, 1000], [30, 970], [512, 512]];
  const fids = pixels.map(([u, v], k) => {
    const w = pixelToWorld(truth, [u, v]);
    return { id: `p${k}`, space: "pixel", u, v, worldX: w[0], worldY: w[1], enabled: true };
  });
  const nominal = buildScanGeometry(inputs, NO_CORRECTION);
  const fit = fitFiducials(nominal, fids, "affine");
  assert.equal(fit.points, 5);
  assert.ok(fit.rmsUm < 1e-9, `rms ${fit.rmsUm}`);
  fit.correction.matrix.forEach((v, k) => close(v, C[k], 1e-9, `C[${k}]`));
  close(fit.correction.dacOffset[0], 40, 1e-6);
  close(fit.correction.dacOffset[1], -25, 1e-6);
  close(fit.change.rotationDeg, 0.8, 1e-9);
  close(fit.change.scaleX, 1.03, 1e-9);
  close(fit.change.shear, 0.004 / 1.03, 1e-9);

  // the rectified geometry now reproduces the truth everywhere
  const rect = buildScanGeometry(inputs, fit.correction);
  for (const d of [[0, 0], [DAC_MAX, 0], [DAC_MAX, DAC_MAX], [7000, 12000]]) {
    const a = dacToWorld(rect, d), b = dacToWorld(truth, d);
    close(a[0], b[0], 1e-7);
    close(a[1], b[1], 1e-7);
  }
});

test("correction is magnification-independent: refit at ×1000, still valid at ×5000", () => {
  const { C } = trueFrame();
  const at = (mag) => resolve({}, { magnification: mag, stageOriginUm: [0, 0] }, { 1000: 100e-6, 10000: 10e-6 }).inputs;
  const truth5k = buildScanGeometry(at(5000), { matrix: C, dacOffset: [40, -25] });
  const truth1k = buildScanGeometry(at(1000), { matrix: C, dacOffset: [40, -25] });
  const fids = [[0, 0], [16000, 300], [15800, 16000], [200, 15900]].map(([u, v], k) => {
    const w = dacToWorld(truth1k, [u, v]);
    return { id: `d${k}`, space: "dac", u, v, worldX: w[0], worldY: w[1], enabled: true };
  });
  const fit = fitFiducials(buildScanGeometry(at(1000)), fids);
  const at5k = buildScanGeometry(at(5000), fit.correction);
  const a = dacToWorld(at5k, [3000, 9000]), b = dacToWorld(truth5k, [3000, 9000]);
  close(a[0], b[0], 1e-8);
  close(a[1], b[1], 1e-8);
});

test("similarity fit: two points, rotation + scale; residuals reported for noisy points", () => {
  const { inputs } = resolve({}, { hfovUm: 100 });
  const nominal = buildScanGeometry(inputs);
  const th = (2 * Math.PI) / 180;
  const C = [1.05 * Math.cos(th), -1.05 * Math.sin(th), 1.05 * Math.sin(th), 1.05 * Math.cos(th)];
  const truth = buildScanGeometry(inputs, { matrix: C, dacOffset: [0, 0] });
  const mk = (u, v, k, noise = [0, 0]) => {
    const w = dacToWorld(truth, [u, v]);
    return { id: `s${k}`, space: "dac", u, v, worldX: w[0] + noise[0], worldY: w[1] + noise[1], enabled: true };
  };
  const two = fitFiducials(nominal, [mk(1000, 1000, 0), mk(15000, 14000, 1)], "similarity");
  close(two.change.rotationDeg, 2, 1e-9);
  close(two.change.scaleX, 1.05, 1e-9);
  close(two.change.scaleY, 1.05, 1e-9);

  const noisy = fitFiducials(nominal, [mk(1000, 1000, 0, [0.05, 0]), mk(15000, 1000, 1), mk(15000, 15000, 2, [0, -0.05]), mk(1000, 15000, 3)], "affine");
  assert.ok(noisy.rmsUm > 0 && noisy.maxUm < 0.05 && noisy.maxUm >= noisy.rmsUm);
  assert.equal(noisy.residuals.length, 4);
});

test("fit input errors: too few or collinear fiducials, disabled rows ignored", () => {
  const nominal = buildScanGeometry(resolve({}, { hfovUm: 100 }).inputs);
  const f = (u, v, k, enabled = true) => ({ id: `c${k}`, space: "dac", u, v, worldX: u / 100, worldY: v / 100, enabled });
  assert.throws(() => fitFiducials(nominal, [f(0, 0, 0), f(100, 100, 1)], "affine"), /at least 3/);
  assert.throws(() => fitFiducials(nominal, [f(0, 0, 0), f(100, 100, 1), f(200, 200, 2)], "affine"), /collinear/);
  assert.throws(() => fitFiducials(nominal, [f(0, 0, 0), f(100, 0, 1), f(0, 100, 2, false)], "affine"), /at least 3/);
  assert.throws(() => fitFiducials(nominal, [{ ...f(0, 0, 0), worldX: NaN }, f(100, 0, 1), f(0, 100, 2)], "affine"), /at least 3/);
});

test("folding the isotropic scale into HFOV keeps the mapping unchanged", () => {
  const { inputs, C } = trueFrame();
  const corr = { matrix: C, dacOffset: [40, -25] };
  const before = buildScanGeometry(inputs, corr);
  const folded = foldScaleIntoHfov(inputs, corr);
  const after = buildScanGeometry({ ...inputs, hfovUm: folded.hfovUm }, folded.correction);
  close(Math.abs(folded.correction.matrix[0] * folded.correction.matrix[3] - folded.correction.matrix[1] * folded.correction.matrix[2]), 1, 1e-12);
  for (const d of [[0, 0], [DAC_MAX, 5000]]) {
    const a = dacToWorld(before, d), b = dacToWorld(after, d);
    close(a[0], b[0], 1e-8);
    close(a[1], b[1], 1e-8);
  }
});

test("decompose handles rotation, shear and mirroring", () => {
  const p = decompose([0, -2, 3, 0]); // 90° rotation of diag(3, 2)
  close(p.rotationDeg, 90, 1e-9);
  close(p.scaleX, 3, 1e-12);
  close(p.scaleY, 2, 1e-12);
  assert.equal(p.mirrored, false);
  assert.equal(decompose([1, 0, 0, -1]).mirrored, true);
});

test("ROI: rectified world rectangle -> enclosing DAC range; linear mapping unchanged without geometry", () => {
  const g = buildScanGeometry(resolve({}, { hfovUm: 163.84 }).inputs);
  // stage origin 0 -> the frame spans -81.92..81.92 µm
  const roi = worldRectToDacROI(g.inverse, { x_start: -81.92, x_end: 0, y_start: 0, y_end: 81.92 });
  assert.deepEqual(roi, { x_start: 0, x_end: 8192, y_start: 8192, y_end: DAC_MAX });

  const rotated = buildScanGeometry(resolve({ [K.rotationOffsetDeg]: 45 }, { hfovUm: 100 }).inputs);
  const r2 = worldRectToDacROI(rotated.inverse, { x_start: -1, x_end: 1, y_start: -1, y_end: 1 });
  const half = Math.SQRT2 * 163.84; // 1 µm = 163.84 codes; a rotated square needs √2 more
  close(r2.x_end - r2.x_start, 2 * half, 2);
  close((r2.x_end + r2.x_start) / 2, DAC_CENTER, 1);

  const applied = toAppliedGeometry(g, 7);
  assert.equal(applied.profileRevision, 7);
  const fov = { x_origin: 0, x_end: 100, y_origin: 0, y_end: 100 };
  const linear = worldSelectionToDacROI({ x_start: 0, x_end: 50, y_start: 0, y_end: 100 }, fov);
  assert.deepEqual(linear, { x_start: 0, x_end: 8192, y_start: 0, y_end: DAC_MAX });
  const viaGeometry = worldSelectionToDacROI({ x_start: -81.92, x_end: 0, y_start: 0, y_end: 81.92 }, { ...fov, scanGeometry: applied });
  assert.deepEqual(viaGeometry, roi);
  assert.deepEqual(worldSelectionToDacROI({ x_start: 0, x_end: 50, y_start: 0, y_end: 100 }, { ...fov, scanGeometry: null }), linear);
});

test("dimension bounds and stored config round trip; invalid configs are rejected", () => {
  const { inputs } = resolve({}, { hfovUm: 100, stageOriginUm: [10, 20] });
  const g = buildScanGeometry(inputs);
  const b = dimensionBoundsFromGeometry(g);
  // corners are DAC 0 and 16383 around the centre 8191.5 -> ±8191.5 codes × 100/16384 µm
  close(b.x_origin, 10 - (8191.5 * 100) / 16384, 1e-6);
  close(b.x_end, 10 + (8191.5 * 100) / 16384, 1e-6);
  assert.equal(b.scale_unit, "um");

  const cfg = { version: 1, enabled: true, beam: "ion", equipment_id: 3, equipment_type: "FIB", profile_revision: 4, inputs, correction: NO_CORRECTION, fit: null, applied_at: "", applied_by: "" };
  const parsed = parseScanGeometryConfig(JSON.parse(JSON.stringify(cfg)));
  assert.ok(parsed);
  assert.deepEqual(parsed.inputs, inputs);
  assert.equal(parseScanGeometryConfig(null), null);
  assert.equal(parseScanGeometryConfig({ ...cfg, correction: { matrix: [0, 0, 0, 0], dacOffset: [0, 0] } }), null);
  assert.equal(parseScanGeometryConfig({ ...cfg, inputs: { ...inputs, hfovUm: -1 } }), null);
});
