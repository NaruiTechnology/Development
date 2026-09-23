/**
 * Storage of the applied scan geometry (CONFIGURATION > Admin > Calibration > Scan geometry) in streamData.json,
 * at Actions[0].streamData.actionData.scanGeometry - next to magCalibration, which it complements.
 *
 * The frontend computes the geometry (ionbeam-web/frontend/src/lib/scanGeometry.ts); this module only checks that
 * what is stored is structurally sound, so a malformed body can never reach a scan: every number finite, the
 * correction matrix invertible, sizes in range. It keeps no vendor semantics of its own.
 */
import { ConfigError } from "./configManager";

export interface StoredScanGeometry {
  version: number;
  enabled: boolean;
  beam: "ion" | "ebeam";
  equipment_id: number | null;
  equipment_type: "FIB" | "SEM";
  profile_revision: number | null;
  inputs: Record<string, unknown>;
  correction: { matrix: [number, number, number, number]; dacOffset: [number, number] };
  fit: Record<string, unknown> | null;
  applied_at: string;
  applied_by: string;
}

const MAX_FIT_POINTS = 200;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const vec = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite);

function fail(message: string): never {
  throw new ConfigError(`scan geometry: ${message}`, 422);
}

/** Validate a request body; returns the record to store. `actor` is written as applied_by. */
export function normalizeScanGeometry(body: unknown, actor: string, now: Date = new Date()): StoredScanGeometry {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("body must be a JSON object");
  const r = body as Record<string, unknown>;
  const inputs = r.inputs;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) fail("inputs missing");
  const i = inputs as Record<string, unknown>;

  const positive = ["magnification", "hfovUm", "pixelsX", "pixelsY", "yxAspect", "adcHalfPeriod"];
  for (const key of positive) if (!finite(i[key]) || (i[key] as number) <= 0) fail(`inputs.${key} must be a positive number`);
  for (const key of ["rotationOffsetDeg", "scanRotationDeg", "dwell"]) if (!finite(i[key])) fail(`inputs.${key} must be a number`);
  for (const key of ["pixelsX", "pixelsY"]) if ((i[key] as number) > 16384) fail(`inputs.${key} exceeds the 16384-code DAC range`);
  if (!vec(i.stageOriginUm, 2)) fail("inputs.stageOriginUm must be [x, y]");
  if (i.spotPark !== null && i.spotPark !== undefined && !vec(i.spotPark, 2)) fail("inputs.spotPark must be [x, y] or null");
  const tilt = (i.tiltCorrection ?? {}) as Record<string, unknown>;
  if (tilt.enabled === true) {
    if (!finite(tilt.beamTiltDeg) || !finite(tilt.stageTiltDeg)) fail("tilt correction needs beam and stage tilt");
    if (Math.abs((tilt.beamTiltDeg as number) - (tilt.stageTiltDeg as number)) >= 89) fail("tilt correction angle must be below 89°");
  }

  const c = r.correction as Record<string, unknown> | undefined;
  if (!c || !vec(c.matrix, 4) || !vec(c.dacOffset, 2)) fail("correction must be { matrix: [4 numbers], dacOffset: [2 numbers] }");
  const [a, b, cc, d] = c.matrix as number[];
  const det = a * d - b * cc;
  if (!(Math.abs(det) > 1e-9) || Math.abs(det) > 1e6) fail("correction matrix is singular or out of range");
  if ((c.dacOffset as number[]).some((v) => Math.abs(v) > 1e6)) fail("dacOffset out of range");

  let fit: Record<string, unknown> | null = null;
  if (r.fit !== null && r.fit !== undefined) {
    if (typeof r.fit !== "object" || Array.isArray(r.fit)) fail("fit must be an object or null");
    fit = r.fit as Record<string, unknown>;
    if (!Array.isArray(fit.points) || fit.points.length > MAX_FIT_POINTS) fail(`fit.points must be a list of at most ${MAX_FIT_POINTS}`);
    if (!finite(fit.rms_um) || !finite(fit.max_um)) fail("fit.rms_um / fit.max_um must be numbers");
  }

  return {
    version: finite(r.version) ? r.version : 1,
    enabled: r.enabled === true,
    beam: r.beam === "ebeam" ? "ebeam" : "ion",
    equipment_id: finite(r.equipment_id) && Number.isInteger(r.equipment_id) ? r.equipment_id : null,
    equipment_type: r.equipment_type === "SEM" ? "SEM" : "FIB",
    profile_revision: finite(r.profile_revision) ? r.profile_revision : null,
    inputs: i,
    correction: { matrix: c.matrix as StoredScanGeometry["correction"]["matrix"], dacOffset: c.dacOffset as [number, number] },
    fit,
    applied_at: now.toISOString(),
    applied_by: actor,
  };
}

function actionData(data: unknown, mutable: boolean): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    if (mutable) throw new ConfigError("stream config must be a JSON object", 500);
    return null;
  }
  const actions = (data as Record<string, unknown>).Actions;
  const first = Array.isArray(actions) ? actions[0] : null;
  const stream = first && typeof first === "object" ? (first as Record<string, unknown>).streamData : null;
  const ad = stream && typeof stream === "object" ? (stream as Record<string, unknown>).actionData : null;
  if (!ad || typeof ad !== "object" || Array.isArray(ad)) {
    if (mutable) throw new ConfigError("stream config is missing Actions[0].streamData.actionData", 500);
    return null;
  }
  return ad as Record<string, unknown>;
}

/** The stored geometry plus the stream defaults the panel needs (resolution, dwell, transforms). */
export function readScanGeometry(data: unknown): {
  scan_geometry: unknown;
  stream: { resolution: unknown; dwell: unknown; adcHalfPeriod: unknown; transforms: unknown };
} {
  const ad = actionData(data, false) ?? {};
  const raster = (ad.rasterScan ?? {}) as Record<string, unknown>;
  return {
    scan_geometry: ad.scanGeometry ?? null,
    stream: {
      resolution: raster.resolution ?? null,
      dwell: raster.dwell ?? null,
      adcHalfPeriod: ad.adcHalfPeriod ?? null,
      transforms: ad.transforms ?? null,
    },
  };
}

/** A deep copy of the config with actionData.scanGeometry replaced (or removed when `value` is null). */
export function writeScanGeometry(data: unknown, value: StoredScanGeometry | null): unknown {
  const next = JSON.parse(JSON.stringify(data)) as unknown;
  const ad = actionData(next, true) as Record<string, unknown>;
  if (value === null) delete ad.scanGeometry;
  else ad.scanGeometry = value;
  return next;
}
