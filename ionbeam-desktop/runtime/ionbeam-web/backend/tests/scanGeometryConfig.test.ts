import assert from "node:assert/strict";
import test from "node:test";

import { normalizeScanGeometry, readScanGeometry, writeScanGeometry } from "../src/scanGeometryConfig";

const inputs = {
  equipmentType: "FIB", magnification: 1000, hfovUm: 100, pixelsX: 1024, pixelsY: 1024, dwell: 15, adcHalfPeriod: 3,
  vendorDwell: null, rotationOffsetDeg: 0.5, scanRotationDeg: 0, yxAspect: 1,
  tiltCorrection: { enabled: false, beamTiltDeg: 52, stageTiltDeg: 52 },
  transforms: { xflip: false, yflip: false, rotate90: false }, stageOriginUm: [0, 0], spotPark: null,
};
const body = { version: 1, enabled: true, beam: "ion", equipment_id: 3, equipment_type: "FIB", profile_revision: 2, inputs,
  correction: { matrix: [1.01, 0, 0, 0.99], dacOffset: [12, -4] }, fit: null };
const stream = () => ({ Version: "1.0.0", Actions: [{ streamData: { actionData: { rasterScan: { resolution: 1024, dwell: 16 }, adcHalfPeriod: 3, transforms: { xflip: true } } } }] });

test("normalize: accepts a valid body and stamps actor and time", () => {
  const out = normalizeScanGeometry(body, "root", new Date("2026-09-23T00:00:00Z"));
  assert.equal(out.applied_by, "root");
  assert.equal(out.applied_at, "2026-09-23T00:00:00.000Z");
  assert.equal(out.equipment_id, 3);
  assert.deepEqual(out.correction.dacOffset, [12, -4]);
});

test("normalize: rejects malformed or unsafe bodies with 422", () => {
  const bad = [
    null,
    { ...body, inputs: { ...inputs, hfovUm: 0 } },
    { ...body, inputs: { ...inputs, pixelsX: 20000 } },
    { ...body, inputs: { ...inputs, stageOriginUm: [0] } },
    { ...body, correction: { matrix: [0, 0, 0, 0], dacOffset: [0, 0] } },
    { ...body, correction: { matrix: [1, 0, 0, 1], dacOffset: [0, Number.NaN] } },
    { ...body, inputs: { ...inputs, tiltCorrection: { enabled: true, beamTiltDeg: 95, stageTiltDeg: 0 } } },
    { ...body, fit: { points: new Array(201).fill({}), rms_um: 0, max_um: 0 } },
  ];
  for (const b of bad) assert.throws(() => normalizeScanGeometry(b, "root"), (e: { status?: number }) => e.status === 422);
});

test("read / write: stored next to magCalibration, removable, input untouched", () => {
  const data = stream();
  const empty = readScanGeometry(data);
  assert.equal(empty.scan_geometry, null);
  assert.equal(empty.stream.resolution, 1024);
  assert.deepEqual(empty.stream.transforms, { xflip: true });

  const next = writeScanGeometry(data, normalizeScanGeometry(body, "root"));
  assert.equal(readScanGeometry(data).scan_geometry, null, "original not mutated");
  assert.equal((readScanGeometry(next).scan_geometry as { equipment_id: number }).equipment_id, 3);
  assert.equal(readScanGeometry(writeScanGeometry(next, null)).scan_geometry, null);
  assert.throws(() => writeScanGeometry({ Actions: [] }, null), /missing/);
});
