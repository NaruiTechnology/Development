/**
 * Scan geometry: turns the FIB / SEM calibration profile (CONFIGURATION > Admin > Calibration) into the
 * mapping between scan DAC codes, image pixels and world coordinates (µm), and rectifies it with fiducials.
 *
 *   commanded DAC d (0..16383, what the service streams)
 *     -> hardware transform H           (streamData transforms: rotate90 = swap, xflip / yflip = 16383 - code)
 *     -> nominal column model N         (HFOV(mag) / 16384 per code, Y/X aspect, rotation, tilt foreshortening)
 *     -> fiducial correction C, δ       (least-squares rectification: residual scale / rotation / shear / offset)
 *     -> + stage origin t               (world position of the scan centre)
 *
 *   world = t + C · N · H · (d - c - δ)        c = 8191.5 (DAC centre), δ in DAC codes
 *
 * δ is kept in DAC codes and C is dimensionless, so a fit made at one magnification still holds at another:
 * only N changes with the magnification (through HFOV).
 *
 * Vendor values are read from the active calibration profile and snapshotted (with the profile revision) when the
 * geometry is applied, so a scan never changes because someone edited the profile - the panel flags the snapshot
 * as stale instead.
 */
import type { CalibrationEquipmentType } from "../types/calibration";

export const DAC_CODES = 16384;
export const DAC_MAX = DAC_CODES - 1;
/** Centre of the 14-bit range; a flip (16383 - code) is exactly a negation around it. */
export const DAC_CENTER = DAC_MAX / 2;
/** Vendor spot-park registers are 16-bit ("16bitsFEITAD"); the Glasgow scan DAC is 14-bit. */
export const VENDOR_SPOT_DAC_CODES = 65536;
export const SCAN_GEOMETRY_VERSION = 1;

/** Row-major 2x2 matrix [a11, a12, a21, a22]. */
export type Mat2 = [number, number, number, number];
export type Vec2 = [number, number];
/** world = a · dac + b (world in µm, dac in commanded codes). */
export interface Affine2 {
  a: Mat2;
  b: Vec2;
}

// ---- parameter roles -> catalog keys ------------------------------------------------------------

export type GeometryRole =
  | "pixelsX"
  | "pixelsY"
  | "scanWidth"
  | "scanLines"
  | "vendorDwell"
  | "rotationOffsetDeg"
  | "yxAspect"
  | "photoImageHeightMm"
  | "beamTiltDeg"
  | "spotParkX"
  | "spotParkY";

/** Which calibration-profile parameter feeds which role. Only keys whose meaning is documented are mapped. */
export const SCAN_GEOMETRY_KEYS: Record<CalibrationEquipmentType, Partial<Record<GeometryRole, string>>> = {
  FIB: {
    pixelsX: "REG.UI1280.APP.Detectors.ACB.IonBEAM.ScanX",
    pixelsY: "REG.UI1280.APP.Detectors.ACB.IonBEAM.ScanY",
    scanWidth: "REG.UI1280.APP.Detectors.ACB.IonBEAM.ScanWidth",
    scanLines: "REG.UI1280.APP.Detectors.ACB.IonBEAM.ScanLines",
    vendorDwell: "REG.UI1280.APP.Detectors.ACB.IonBEAM.Dwell",
    rotationOffsetDeg: "IONF_ROT_OFFSET",
    yxAspect: "IONF_MAG_YX_ASPECT",
    photoImageHeightMm: "IONF_PHOTO_IMG_SIZE_Y",
    beamTiltDeg: "IONF_IBEAM_TILT",
    spotParkX: "REG.BehaviorServer.16bitsFEITAD.DacSetSpotXIonBeam",
    spotParkY: "REG.BehaviorServer.16bitsFEITAD.DacSetSpotYIonBeam",
  },
  SEM: {
    pixelsX: "REG.UI1280.APP.Detectors.ACB.EBEAM.ScanX",
    pixelsY: "REG.UI1280.APP.Detectors.ACB.EBEAM.ScanY",
    scanWidth: "REG.UI1280.APP.Detectors.ACB.EBEAM.ScanWidth",
    scanLines: "REG.UI1280.APP.Detectors.ACB.EBEAM.ScanLines",
    vendorDwell: "REG.UI1280.APP.Detectors.ACB.EBEAM.Dwell",
  },
};

export function geometryParameterKeys(type: CalibrationEquipmentType): string[] {
  return Object.values(SCAN_GEOMETRY_KEYS[type]).filter((k): k is string => typeof k === "string");
}

// ---- inputs ---------------------------------------------------------------------------------------

export type InputSource = "profile" | "override" | "magCalibration" | "vendorEstimate" | "streamData" | "default";

export interface ScanGeometryInputs {
  equipmentType: CalibrationEquipmentType;
  magnification: number;
  /** Full-DAC-range horizontal field of view at `magnification`, µm. */
  hfovUm: number;
  pixelsX: number;
  pixelsY: number;
  /** Glasgow dwell (streamData rasterScan.dwell): N averages N+1 ADC samples. */
  dwell: number;
  adcHalfPeriod: number;
  /** Vendor ACB dwell, reference only (vendor units). */
  vendorDwell: number | null;
  rotationOffsetDeg: number;
  scanRotationDeg: number;
  yxAspect: number;
  tiltCorrection: { enabled: boolean; beamTiltDeg: number; stageTiltDeg: number };
  transforms: { xflip: boolean; yflip: boolean; rotate90: boolean };
  stageOriginUm: Vec2;
  /** Vendor spot-park position (16-bit vendor DAC), if stored. */
  spotPark: Vec2 | null;
}

export interface ScanGeometryOverrides {
  magnification?: number;
  hfovUm?: number | null;
  pixelsX?: number | null;
  pixelsY?: number | null;
  scanRotationDeg?: number;
  stageOriginUm?: Vec2;
  tiltCorrection?: { enabled: boolean; stageTiltDeg: number };
}

export interface StreamScanDefaults {
  resolution?: number;
  dwell?: number;
  adcHalfPeriod?: number;
  transforms?: { xflip?: boolean; yflip?: boolean; rotate90?: boolean };
}

export interface ResolvedInputs {
  inputs: ScanGeometryInputs;
  sources: Partial<Record<keyof ScanGeometryInputs | "hfov", InputSource>>;
  hfovSource: InputSource;
  warnings: string[];
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function positiveInt(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 1 && n <= 1_000_000 ? Math.round(n) : null;
}

/**
 * Horizontal FOV (m) at `mag` from a measured table { mag: m_per_fov }. Interpolates log-log between the two
 * nearest points (FOV ∝ 1/mag is a straight line there); outside the table it extrapolates with FOV ∝ 1/mag from
 * the nearest point. Null when the table is empty.
 */
export function interpolateHfovM(points: Record<string, number>, mag: number): number | null {
  const pts = Object.entries(points)
    .map(([m, f]) => [Number(m), Number(f)] as const)
    .filter(([m, f]) => Number.isFinite(m) && m > 0 && Number.isFinite(f) && f > 0)
    .sort((a, b) => a[0] - b[0]);
  if (pts.length === 0 || !(mag > 0)) return null;
  if (mag <= pts[0][0]) return (pts[0][1] * pts[0][0]) / mag;
  const last = pts[pts.length - 1];
  if (mag >= last[0]) return (last[1] * last[0]) / mag;
  for (let i = 1; i < pts.length; i++) {
    const [m1, f1] = pts[i];
    if (mag <= m1) {
      const [m0, f0] = pts[i - 1];
      const t = (Math.log(mag) - Math.log(m0)) / (Math.log(m1) - Math.log(m0));
      return Math.exp(Math.log(f0) + t * (Math.log(f1) - Math.log(f0)));
    }
  }
  return null;
}

/**
 * Collect the geometry inputs. Precedence per value: explicit override > calibration profile > streamData > default.
 * HFOV: override > measured magnification calibration > vendor estimate (photo image height / mag).
 */
export function resolveScanGeometryInputs(args: {
  type: CalibrationEquipmentType;
  profileValues: Record<string, unknown>;
  magCalibration: Record<string, number>;
  stream: StreamScanDefaults;
  overrides: ScanGeometryOverrides;
}): ResolvedInputs {
  const { type, profileValues, magCalibration, stream, overrides } = args;
  const keys = SCAN_GEOMETRY_KEYS[type];
  const sources: ResolvedInputs["sources"] = {};
  const warnings: string[] = [];
  const fromProfile = (role: GeometryRole): unknown => (keys[role] ? profileValues[keys[role] as string] : undefined);

  const magnification = num(overrides.magnification) ?? 1000;

  // pixels
  const pick = (override: unknown, primary: GeometryRole, alt: GeometryRole, name: "pixelsX" | "pixelsY"): number => {
    const o = positiveInt(override);
    if (o !== null) return (sources[name] = "override"), o;
    const p = positiveInt(fromProfile(primary)) ?? positiveInt(fromProfile(alt));
    if (p !== null) return (sources[name] = "profile"), p;
    const s = positiveInt(stream.resolution);
    if (s !== null) return (sources[name] = "streamData"), s;
    return (sources[name] = "default"), 1024;
  };
  const pixelsX = pick(overrides.pixelsX, "pixelsX", "scanWidth", "pixelsX");
  const pixelsY = pick(overrides.pixelsY, "pixelsY", "scanLines", "pixelsY");
  if (pixelsX > DAC_CODES || pixelsY > DAC_CODES) warnings.push("pixels_exceed_dac");

  // scalar vendor values
  const scalar = (role: GeometryRole, name: keyof ScanGeometryInputs, fallback: number, valid: (n: number) => boolean) => {
    const p = num(fromProfile(role));
    if (p !== null && valid(p)) return (sources[name] = "profile"), p;
    if (p !== null) warnings.push(`${String(name)}_ignored`);
    return (sources[name] = "default"), fallback;
  };
  const rotationOffsetDeg = scalar("rotationOffsetDeg", "rotationOffsetDeg", 0, (n) => Math.abs(n) <= 360);
  // An unset vendor aspect is stored as 0 on many machines: treat it as "no correction".
  const yxAspect = scalar("yxAspect", "yxAspect", 1, (n) => n > 0.2 && n < 5);
  const beamTiltDeg = scalar("beamTiltDeg", "tiltCorrection", 52, (n) => n >= 0 && n < 90);

  // HFOV
  let hfovUm: number;
  let hfovSource: InputSource;
  const hfovOverride = num(overrides.hfovUm);
  const measured = interpolateHfovM(magCalibration, magnification);
  const photoMm = num(fromProfile("photoImageHeightMm"));
  if (hfovOverride !== null && hfovOverride > 0) {
    hfovUm = hfovOverride;
    hfovSource = "override";
  } else if (measured !== null) {
    hfovUm = measured * 1e6;
    hfovSource = "magCalibration";
  } else if (photoMm !== null && photoMm > 0) {
    // FEI magnification is referenced to the photo image: height(mm) / mag = field height. The Glasgow frame is
    // square in DAC codes, so the horizontal field is the vertical one divided by the Y/X aspect.
    hfovUm = ((photoMm * 1e3) / magnification) / yxAspect;
    hfovSource = "vendorEstimate";
    warnings.push("hfov_vendor_estimate");
  } else {
    hfovUm = 127_000 / magnification; // 127 mm (Polaroid 4x5) reference width
    hfovSource = "default";
    warnings.push("hfov_default");
  }
  sources.hfov = hfovSource;

  const spx = num(fromProfile("spotParkX"));
  const spy = num(fromProfile("spotParkY"));
  const tilt = overrides.tiltCorrection ?? { enabled: false, stageTiltDeg: beamTiltDeg };

  const inputs: ScanGeometryInputs = {
    equipmentType: type,
    magnification,
    hfovUm,
    pixelsX,
    pixelsY,
    dwell: num(stream.dwell) ?? 2,
    adcHalfPeriod: num(stream.adcHalfPeriod) ?? 3,
    vendorDwell: num(fromProfile("vendorDwell")),
    rotationOffsetDeg,
    scanRotationDeg: num(overrides.scanRotationDeg) ?? 0,
    yxAspect,
    tiltCorrection: { enabled: Boolean(tilt.enabled), beamTiltDeg, stageTiltDeg: num(tilt.stageTiltDeg) ?? beamTiltDeg },
    transforms: {
      xflip: Boolean(stream.transforms?.xflip),
      yflip: Boolean(stream.transforms?.yflip),
      rotate90: Boolean(stream.transforms?.rotate90),
    },
    stageOriginUm: overrides.stageOriginUm ?? [0, 0],
    spotPark: spx !== null && spy !== null ? [spx, spy] : null,
  };
  return { inputs, sources, hfovSource, warnings };
}

// ---- 2x2 algebra ----------------------------------------------------------------------------------

export const IDENTITY: Mat2 = [1, 0, 0, 1];
export const mul = (p: Mat2, q: Mat2): Mat2 => [
  p[0] * q[0] + p[1] * q[2],
  p[0] * q[1] + p[1] * q[3],
  p[2] * q[0] + p[3] * q[2],
  p[2] * q[1] + p[3] * q[3],
];
export const det = (m: Mat2): number => m[0] * m[3] - m[1] * m[2];
export function inv(m: Mat2): Mat2 {
  const d = det(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-300) throw new Error("singular geometry matrix");
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d];
}
export const apply = (m: Mat2, v: Vec2): Vec2 => [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];
const rot = (deg: number): Mat2 => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r)];
};

/** The gateware's transform (busController): swap when rotate90, then 16383 - code per flipped axis. */
export function hardwareTransform(t: { xflip: boolean; yflip: boolean; rotate90: boolean }): Mat2 {
  const swap: Mat2 = t.rotate90 ? [0, 1, 1, 0] : IDENTITY;
  const flip: Mat2 = [t.xflip ? -1 : 1, 0, 0, t.yflip ? -1 : 1];
  return mul(flip, swap);
}

/** Foreshortening of a surface seen at (beam tilt - stage tilt) off its normal; stretches Y. */
export function tiltFactor(t: ScanGeometryInputs["tiltCorrection"]): number {
  if (!t.enabled) return 1;
  const angle = Math.abs(t.beamTiltDeg - t.stageTiltDeg);
  if (!(angle < 89)) throw new Error("tilt correction angle must be below 89°");
  return 1 / Math.cos((angle * Math.PI) / 180);
}

/** N·H: µm of world per commanded DAC code (centred), before fiducial correction. */
export function nominalMatrix(i: ScanGeometryInputs): Mat2 {
  const kx = i.hfovUm / DAC_CODES;
  const ky = kx * i.yxAspect * tiltFactor(i.tiltCorrection);
  const scale: Mat2 = [kx, 0, 0, ky];
  return mul(mul(rot(i.rotationOffsetDeg + i.scanRotationDeg), scale), hardwareTransform(i.transforms));
}

// ---- correction + full geometry --------------------------------------------------------------------

export interface GeometryCorrection {
  /** Dimensionless world-frame correction C. */
  matrix: Mat2;
  /** Electrical centre offset δ, DAC codes. */
  dacOffset: Vec2;
}
export const NO_CORRECTION: GeometryCorrection = { matrix: IDENTITY, dacOffset: [0, 0] };

export interface ScanGeometry {
  inputs: ScanGeometryInputs;
  correction: GeometryCorrection;
  /** commanded DAC -> world µm */
  forward: Affine2;
  /** world µm -> commanded DAC */
  inverse: Affine2;
}

export function buildScanGeometry(inputs: ScanGeometryInputs, correction: GeometryCorrection = NO_CORRECTION): ScanGeometry {
  if (!(inputs.hfovUm > 0) || !Number.isFinite(inputs.hfovUm)) throw new Error("HFOV must be a positive number");
  const a = mul(correction.matrix, nominalMatrix(inputs));
  // world = t + A (d - c - δ)  =>  b = t - A (c + δ)
  const shifted = apply(a, [DAC_CENTER + correction.dacOffset[0], DAC_CENTER + correction.dacOffset[1]]);
  const b: Vec2 = [inputs.stageOriginUm[0] - shifted[0], inputs.stageOriginUm[1] - shifted[1]];
  const ai = inv(a);
  const bi = apply(ai, b);
  return { inputs, correction, forward: { a, b }, inverse: { a: ai, b: [-bi[0], -bi[1]] } };
}

export const transform = (f: Affine2, p: Vec2): Vec2 => {
  const v = apply(f.a, p);
  return [v[0] + f.b[0], v[1] + f.b[1]];
};
export const dacToWorld = (g: ScanGeometry, d: Vec2): Vec2 => transform(g.forward, d);
export const worldToDac = (g: ScanGeometry, w: Vec2): Vec2 => transform(g.inverse, w);

/** Commanded DAC code of image pixel (col,row): the raster streams code = index · 16384 / N. */
export function pixelToDac(i: Pick<ScanGeometryInputs, "pixelsX" | "pixelsY">, p: Vec2): Vec2 {
  return [(p[0] * DAC_CODES) / i.pixelsX, (p[1] * DAC_CODES) / i.pixelsY];
}
export function dacToPixel(i: Pick<ScanGeometryInputs, "pixelsX" | "pixelsY">, d: Vec2): Vec2 {
  return [(d[0] * i.pixelsX) / DAC_CODES, (d[1] * i.pixelsY) / DAC_CODES];
}
export const pixelToWorld = (g: ScanGeometry, p: Vec2): Vec2 => dacToWorld(g, pixelToDac(g.inputs, p));
export const worldToPixel = (g: ScanGeometry, w: Vec2): Vec2 => dacToPixel(g.inputs, worldToDac(g, w));

export interface AffineParts {
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  /** x-shear, dimensionless */
  shear: number;
  mirrored: boolean;
}

/** A = R(θ) · [[sx, sx·k],[0, sy]] ; sy < 0 means a mirrored frame. */
export function decompose(a: Mat2): AffineParts {
  const sx = Math.hypot(a[0], a[2]);
  const theta = Math.atan2(a[2], a[0]);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const r12 = c * a[1] + s * a[3];
  const sy = -s * a[1] + c * a[3];
  return { scaleX: sx, scaleY: Math.abs(sy), rotationDeg: (theta * 180) / Math.PI, shear: sx > 0 ? r12 / sx : 0, mirrored: sy < 0 };
}

// ---- derived results -------------------------------------------------------------------------------

export interface ScanGeometryResults {
  pixels: Vec2;
  dacPerPixel: Vec2;
  /** µm per DAC code along the frame's own X / Y axis */
  scaleUmPerCode: Vec2;
  pixelSizeNm: Vec2;
  fovUm: Vec2;
  rotationDeg: number;
  shear: number;
  mirrored: boolean;
  corners: { topLeft: Vec2; topRight: Vec2; bottomRight: Vec2; bottomLeft: Vec2 };
  center: Vec2;
  worldBounds: { x0: number; x1: number; y0: number; y1: number };
  frameSeconds: number;
  pixelDwellNs: number;
  spotParkDac: Vec2 | null;
  spotParkWorld: Vec2 | null;
}

export function scanGeometryResults(g: ScanGeometry): ScanGeometryResults {
  const i = g.inputs;
  const parts = decompose(g.forward.a);
  const dpp: Vec2 = [DAC_CODES / i.pixelsX, DAC_CODES / i.pixelsY];
  const corners = {
    topLeft: dacToWorld(g, [0, 0]),
    topRight: dacToWorld(g, [DAC_MAX, 0]),
    bottomRight: dacToWorld(g, [DAC_MAX, DAC_MAX]),
    bottomLeft: dacToWorld(g, [0, DAC_MAX]),
  };
  const xs = Object.values(corners).map((c) => c[0]);
  const ys = Object.values(corners).map((c) => c[1]);
  // Glasgow revC3: one ADC conversion is 2·adcHalfPeriod clocks at 48 MHz, a pixel is dwell+1 conversions.
  const half = i.adcHalfPeriod >= 3 ? i.adcHalfPeriod : 3;
  const pixelDwellNs = ((2 * half * 1e9) / 48_000_000) * (Math.max(0, Math.trunc(i.dwell)) + 1);
  const spotParkDac: Vec2 | null = i.spotPark
    ? [(i.spotPark[0] * DAC_CODES) / VENDOR_SPOT_DAC_CODES, (i.spotPark[1] * DAC_CODES) / VENDOR_SPOT_DAC_CODES]
    : null;
  return {
    pixels: [i.pixelsX, i.pixelsY],
    dacPerPixel: dpp,
    scaleUmPerCode: [parts.scaleX, parts.scaleY],
    pixelSizeNm: [parts.scaleX * dpp[0] * 1e3, parts.scaleY * dpp[1] * 1e3],
    fovUm: [parts.scaleX * DAC_CODES, parts.scaleY * DAC_CODES],
    rotationDeg: parts.rotationDeg,
    shear: parts.shear,
    mirrored: parts.mirrored,
    corners,
    center: dacToWorld(g, [DAC_CENTER, DAC_CENTER]),
    worldBounds: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) },
    frameSeconds: (i.pixelsX * i.pixelsY * pixelDwellNs) / 1e9,
    pixelDwellNs,
    spotParkDac,
    spotParkWorld: spotParkDac ? dacToWorld(g, spotParkDac) : null,
  };
}

// ---- fiducial rectification ------------------------------------------------------------------------

export interface Fiducial {
  id: string;
  /** "pixel" = image column/row on the current pixel grid, "dac" = commanded DAC codes */
  space: "pixel" | "dac";
  u: number;
  v: number;
  /** known world position, µm */
  worldX: number;
  worldY: number;
  enabled: boolean;
}

export type FitModel = "similarity" | "affine";

export interface FitResult {
  model: FitModel;
  /** fitted commanded DAC -> world */
  affine: Affine2;
  correction: GeometryCorrection;
  residuals: Array<{ id: string; dx: number; dy: number; distance: number }>;
  rmsUm: number;
  maxUm: number;
  /** what the correction does relative to the nominal model */
  change: { scaleX: number; scaleY: number; rotationDeg: number; shear: number; mirrored: boolean; offsetUm: Vec2 };
  points: number;
}

function solve3(m: number[][], r: number[]): number[] {
  // Gaussian elimination with partial pivoting (3x3 normal equations).
  const a = m.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let i = c + 1; i < 3; i++) if (Math.abs(a[i][c]) > Math.abs(a[p][c])) p = i;
    if (Math.abs(a[p][c]) < 1e-12) throw new Error("fiducials are collinear - add a point off the line");
    [a[c], a[p]] = [a[p], a[c]];
    for (let i = 0; i < 3; i++) {
      if (i === c) continue;
      const f = a[i][c] / a[c][c];
      for (let j = c; j < 4; j++) a[i][j] -= f * a[c][j];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

/** Least-squares fit of commanded DAC -> world from fiducials (≥2 similarity, ≥3 affine). */
export function fitFiducials(g: ScanGeometry, fiducials: Fiducial[], model: FitModel = "affine"): FitResult {
  const pts = fiducials
    .filter((f) => f.enabled && [f.u, f.v, f.worldX, f.worldY].every(Number.isFinite))
    .map((f) => ({ id: f.id, d: f.space === "pixel" ? pixelToDac(g.inputs, [f.u, f.v]) : ([f.u, f.v] as Vec2), w: [f.worldX, f.worldY] as Vec2 }));
  const need = model === "affine" ? 3 : 2;
  if (pts.length < need) throw new Error(`${model} fit needs at least ${need} fiducials (have ${pts.length})`);

  // centre both point sets (conditioning: DAC codes are ~1e4, µm can be ~1e-2)
  const n = pts.length;
  const md: Vec2 = [pts.reduce((s, p) => s + p.d[0], 0) / n, pts.reduce((s, p) => s + p.d[1], 0) / n];
  const mw: Vec2 = [pts.reduce((s, p) => s + p.w[0], 0) / n, pts.reduce((s, p) => s + p.w[1], 0) / n];
  const c = pts.map((p) => ({ id: p.id, d: [p.d[0] - md[0], p.d[1] - md[1]] as Vec2, w: [p.w[0] - mw[0], p.w[1] - mw[1]] as Vec2 }));

  let a: Mat2;
  if (model === "similarity") {
    // w = [[p, -q],[q, p]] d   (p = s cosθ, q = s sinθ), optionally mirrored if that fits better
    const fitSim = (mirror: boolean): { a: Mat2; err: number } => {
      let num1 = 0, num2 = 0, den = 0;
      for (const { d, w } of c) {
        const dy = mirror ? -d[1] : d[1];
        num1 += d[0] * w[0] + dy * w[1];
        num2 += d[0] * w[1] - dy * w[0];
        den += d[0] * d[0] + dy * dy;
      }
      if (den < 1e-12) throw new Error("fiducials coincide - spread them over the field");
      const p = num1 / den, q = num2 / den;
      const m: Mat2 = mirror ? [p, q, q, -p] : [p, -q, q, p];
      const err = c.reduce((s, { d, w }) => { const e = apply(m, d); return s + (e[0] - w[0]) ** 2 + (e[1] - w[1]) ** 2; }, 0);
      return { a: m, err };
    };
    const plain = fitSim(false);
    const mirrored = fitSim(true);
    // pick the better handedness; on a tie (e.g. two points) keep the handedness of the nominal model
    const tie = Math.abs(plain.err - mirrored.err) <= 1e-9 * (plain.err + mirrored.err) + 1e-18;
    a = tie ? (det(nominalMatrix(g.inputs)) < 0 ? mirrored.a : plain.a) : plain.err < mirrored.err ? plain.a : mirrored.a;
  } else {
    const sxx = c.reduce((s, p) => s + p.d[0] * p.d[0], 0);
    const sxy = c.reduce((s, p) => s + p.d[0] * p.d[1], 0);
    const syy = c.reduce((s, p) => s + p.d[1] * p.d[1], 0);
    const normal = [[sxx, sxy, 0], [sxy, syy, 0], [0, 0, n]];
    const row = (k: 0 | 1) => solve3(normal, [c.reduce((s, p) => s + p.d[0] * p.w[k], 0), c.reduce((s, p) => s + p.d[1] * p.w[k], 0), 0]);
    const rx = row(0);
    const ry = row(1);
    a = [rx[0], rx[1], ry[0], ry[1]];
  }
  if (!Number.isFinite(det(a)) || Math.abs(det(a)) < 1e-30) throw new Error("fit is degenerate - check the fiducial coordinates");
  const am = apply(a, md);
  const b: Vec2 = [mw[0] - am[0], mw[1] - am[1]];
  const affine: Affine2 = { a, b };

  const residuals = pts.map((p) => {
    const e = transform(affine, p.d);
    const dx = e[0] - p.w[0];
    const dy = e[1] - p.w[1];
    return { id: p.id, dx, dy, distance: Math.hypot(dx, dy) };
  });
  const rmsUm = Math.sqrt(residuals.reduce((s, r) => s + r.distance ** 2, 0) / residuals.length);
  const maxUm = Math.max(...residuals.map((r) => r.distance));

  // Express as a correction on top of the nominal model: A = C·N  =>  C = A·N⁻¹ ;  b = t - A(c + δ)  =>  δ = A⁻¹(t - b) - c
  const nominal = nominalMatrix(g.inputs);
  const C = mul(a, inv(nominal));
  const t = g.inputs.stageOriginUm;
  const back = apply(inv(a), [t[0] - b[0], t[1] - b[1]]);
  const dacOffset: Vec2 = [back[0] - DAC_CENTER, back[1] - DAC_CENTER];
  const parts = decompose(C);
  const centreNow = transform(affine, [DAC_CENTER, DAC_CENTER]);
  const centreNominal = dacToWorld(buildScanGeometry(g.inputs, NO_CORRECTION), [DAC_CENTER, DAC_CENTER]);
  return {
    model,
    affine,
    correction: { matrix: C, dacOffset },
    residuals,
    rmsUm,
    maxUm,
    change: {
      scaleX: parts.scaleX,
      scaleY: parts.scaleY,
      rotationDeg: parts.rotationDeg,
      shear: parts.shear,
      mirrored: parts.mirrored,
      offsetUm: [centreNow[0] - centreNominal[0], centreNow[1] - centreNominal[1]],
    },
    points: pts.length,
  };
}

/**
 * Move the isotropic part of a correction into the HFOV (so it lands in the magnification calibration) and keep
 * only the residual anisotropy / rotation / shear in C. Returns the new HFOV and the reduced correction.
 */
export function foldScaleIntoHfov(inputs: ScanGeometryInputs, correction: GeometryCorrection): { hfovUm: number; correction: GeometryCorrection } {
  const s = Math.sqrt(Math.abs(det(correction.matrix)));
  if (!(s > 0) || !Number.isFinite(s)) return { hfovUm: inputs.hfovUm, correction };
  const m = correction.matrix;
  // δ is in DAC codes: unaffected by moving the scale from C into N.
  return { hfovUm: inputs.hfovUm * s, correction: { matrix: [m[0] / s, m[1] / s, m[2] / s, m[3] / s], dacOffset: correction.dacOffset } };
}

// ---- ROI integration --------------------------------------------------------------------------------

export interface WorldRect {
  x_start: number;
  x_end: number;
  y_start: number;
  y_end: number;
}

/**
 * World rectangle -> the axis-aligned DAC range the service can scan (0..16383). With a rotated or sheared frame
 * the rectangle maps to a parallelogram; the smallest enclosing DAC rectangle is returned (the scan covers it).
 */
export function worldRectToDacROI(forwardInverse: Affine2, sel: WorldRect): WorldRect {
  const xs = [sel.x_start, sel.x_end];
  const ys = [sel.y_start, sel.y_end];
  const pts = xs.flatMap((x) => ys.map((y) => transform(forwardInverse, [x, y])));
  const clamp = (v: number) => Math.max(0, Math.min(DAC_MAX, Math.round(v)));
  const x0 = clamp(Math.min(...pts.map((p) => p[0])));
  const x1 = clamp(Math.max(...pts.map((p) => p[0])));
  const y0 = clamp(Math.min(...pts.map((p) => p[1])));
  const y1 = clamp(Math.max(...pts.map((p) => p[1])));
  return { x_start: x0, x_end: Math.min(DAC_MAX, Math.max(x0 + 1, x1)), y_start: y0, y_end: Math.min(DAC_MAX, Math.max(y0 + 1, y1)) };
}

/** Transform kept in the ROI state (serialisable) so scans use the rectified mapping. */
export interface AppliedScanGeometry {
  enabled: boolean;
  unit: "um";
  forward: Affine2;
  inverse: Affine2;
  magnification: number;
  pixels: Vec2;
  pixelSizeNm: Vec2;
  profileRevision: number | null;
}

export function toAppliedGeometry(g: ScanGeometry, profileRevision: number | null): AppliedScanGeometry {
  const r = scanGeometryResults(g);
  return {
    enabled: true,
    unit: "um",
    forward: g.forward,
    inverse: g.inverse,
    magnification: g.inputs.magnification,
    pixels: r.pixels,
    pixelSizeNm: r.pixelSizeNm,
    profileRevision,
  };
}

/** Dimension-calibration bounds (ROI editor axes, µm) that enclose the rectified scan frame. */
export function dimensionBoundsFromGeometry(g: ScanGeometry): { x_origin: number; x_end: number; y_origin: number; y_end: number; scale_unit: string } {
  const b = scanGeometryResults(g).worldBounds;
  const round = (v: number) => Number(v.toPrecision(9));
  return { x_origin: round(b.x0), x_end: round(b.x1), y_origin: round(b.y0), y_end: round(b.y1), scale_unit: "um" };
}

// ---- persisted configuration (streamData.json actionData.scanGeometry) -------------------------------

export interface ScanGeometryConfig {
  version: number;
  enabled: boolean;
  beam: "ion" | "ebeam";
  equipment_id: number | null;
  equipment_type: CalibrationEquipmentType;
  profile_revision: number | null;
  /** snapshot of every resolved input, so scans do not change when the profile is edited later */
  inputs: ScanGeometryInputs;
  correction: GeometryCorrection;
  fit: {
    model: FitModel;
    rms_um: number;
    max_um: number;
    points: Fiducial[];
    magnification: number;
    fitted_at: string;
  } | null;
  applied_at: string;
  applied_by: string;
}

const isVec2 = (v: unknown): v is Vec2 => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const isMat2 = (v: unknown): v is Mat2 => Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Validate a stored config; null when absent or unusable (the scan then falls back to the linear ROI mapping). */
export function parseScanGeometryConfig(raw: unknown): ScanGeometryConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const i = r.inputs as Record<string, unknown> | undefined;
  const c = r.correction as Record<string, unknown> | undefined;
  if (!i || !c || !isMat2(c.matrix) || !isVec2(c.dacOffset) || Math.abs(det(c.matrix)) < 1e-12) return null;
  const n = (k: string) => (typeof i[k] === "number" && Number.isFinite(i[k]) ? (i[k] as number) : NaN);
  const required = ["magnification", "hfovUm", "pixelsX", "pixelsY", "rotationOffsetDeg", "scanRotationDeg", "yxAspect", "dwell", "adcHalfPeriod"];
  if (required.some((k) => Number.isNaN(n(k)))) return null;
  if (!(n("hfovUm") > 0) || !(n("pixelsX") >= 1) || !(n("pixelsY") >= 1) || !(n("yxAspect") > 0)) return null;
  const tc = (i.tiltCorrection ?? {}) as Record<string, unknown>;
  const tr = (i.transforms ?? {}) as Record<string, unknown>;
  const inputs: ScanGeometryInputs = {
    equipmentType: i.equipmentType === "SEM" ? "SEM" : "FIB",
    magnification: n("magnification"),
    hfovUm: n("hfovUm"),
    pixelsX: Math.round(n("pixelsX")),
    pixelsY: Math.round(n("pixelsY")),
    dwell: n("dwell"),
    adcHalfPeriod: n("adcHalfPeriod"),
    vendorDwell: typeof i.vendorDwell === "number" ? i.vendorDwell : null,
    rotationOffsetDeg: n("rotationOffsetDeg"),
    scanRotationDeg: n("scanRotationDeg"),
    yxAspect: n("yxAspect"),
    tiltCorrection: {
      enabled: tc.enabled === true,
      beamTiltDeg: typeof tc.beamTiltDeg === "number" ? tc.beamTiltDeg : 52,
      stageTiltDeg: typeof tc.stageTiltDeg === "number" ? tc.stageTiltDeg : 52,
    },
    transforms: { xflip: tr.xflip === true, yflip: tr.yflip === true, rotate90: tr.rotate90 === true },
    stageOriginUm: isVec2(i.stageOriginUm) ? i.stageOriginUm : [0, 0],
    spotPark: isVec2(i.spotPark) ? i.spotPark : null,
  };
  try {
    buildScanGeometry(inputs, { matrix: c.matrix, dacOffset: c.dacOffset });
  } catch {
    return null;
  }
  return {
    version: typeof r.version === "number" ? r.version : SCAN_GEOMETRY_VERSION,
    enabled: r.enabled === true,
    beam: r.beam === "ebeam" ? "ebeam" : "ion",
    equipment_id: typeof r.equipment_id === "number" ? r.equipment_id : null,
    equipment_type: r.equipment_type === "SEM" ? "SEM" : "FIB",
    profile_revision: typeof r.profile_revision === "number" ? r.profile_revision : null,
    inputs,
    correction: { matrix: c.matrix, dacOffset: c.dacOffset },
    fit: (r.fit as ScanGeometryConfig["fit"]) ?? null,
    applied_at: typeof r.applied_at === "string" ? r.applied_at : "",
    applied_by: typeof r.applied_by === "string" ? r.applied_by : "",
  };
}

export function geometryFromConfig(config: ScanGeometryConfig): ScanGeometry {
  return buildScanGeometry(config.inputs, config.correction);
}
