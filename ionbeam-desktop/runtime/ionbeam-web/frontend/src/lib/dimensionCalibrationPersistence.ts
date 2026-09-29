export const DIMENSION_CALIBRATION_STORAGE_KEY = "ionbeam.dimensionCalibration.v1";

/**
 * Which UI last set the active dimension calibration — surfaced as a badge in the
 * Dimension Cal wedge (ROICalibrationCard) so an operator can tell whether the current
 * X/Y mapping came from their own image measurement or from CONFIGURATION > Admin >
 * Calibration > Scan geometry. Both write to the same values (see dimensionCalibrationSlice),
 * so this is metadata only — it does not affect what's applied, only what's displayed
 * and whether a confirmation is asked for before one source overwrites the other.
 */
export type DimensionCalibrationSource =
  | { kind: "manual"; set_at: string }
  | {
      kind: "scanGeometry";
      equipment_id: number;
      equipment_type: "FIB" | "SEM";
      profile_revision: number | null;
      applied_at: string;
    };

export interface DimensionCalibrationValues {
  x_origin: number;
  x_end: number;
  y_origin: number;
  y_end: number;
  viewport_x_start: number;
  viewport_x_end: number;
  viewport_y_start: number;
  viewport_y_end: number;
  scale_unit: string;
  /** Absent for values saved before this field existed, or never explicitly tagged. */
  source?: DimensionCalibrationSource;
}

const NUMERIC_KEYS: ReadonlyArray<keyof DimensionCalibrationValues> = [
  "x_origin",
  "x_end",
  "y_origin",
  "y_end",
  "viewport_x_start",
  "viewport_x_end",
  "viewport_y_start",
  "viewport_y_end",
];

/** Best-effort parse: malformed/unrecognised source is dropped rather than invalidating the whole record. */
function parseSource(value: unknown): DimensionCalibrationSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind === "manual" && typeof v.set_at === "string") {
    return { kind: "manual", set_at: v.set_at };
  }
  if (
    v.kind === "scanGeometry" &&
    typeof v.equipment_id === "number" &&
    (v.equipment_type === "FIB" || v.equipment_type === "SEM") &&
    (v.profile_revision === null || typeof v.profile_revision === "number") &&
    typeof v.applied_at === "string"
  ) {
    return {
      kind: "scanGeometry",
      equipment_id: v.equipment_id,
      equipment_type: v.equipment_type,
      profile_revision: v.profile_revision,
      applied_at: v.applied_at,
    };
  }
  return undefined;
}

export function parseDimensionCalibration(
  raw: string | null
): DimensionCalibrationValues | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const parsed = {} as Record<string, number | string>;
    for (const key of NUMERIC_KEYS) {
      const candidate = value[key];
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) return null;
      parsed[key] = candidate;
    }
    const scaleUnit = typeof value.scale_unit === "string"
      ? value.scale_unit.trim()
      : "";
    if (
      !scaleUnit ||
      Number(parsed.x_end) <= Number(parsed.x_origin) ||
      Number(parsed.y_end) <= Number(parsed.y_origin) ||
      Number(parsed.viewport_x_end) <= Number(parsed.viewport_x_start) ||
      Number(parsed.viewport_y_end) <= Number(parsed.viewport_y_start)
    ) {
      return null;
    }
    parsed.scale_unit = scaleUnit;
    const result = parsed as unknown as DimensionCalibrationValues;
    const source = parseSource(value.source);
    if (source) result.source = source;
    return result;
  } catch {
    return null;
  }
}

export function serializeDimensionCalibration(
  calibration: DimensionCalibrationValues
): string {
  const keys: ReadonlyArray<keyof DimensionCalibrationValues> = [
    ...NUMERIC_KEYS,
    "scale_unit",
  ];
  const base = Object.fromEntries(keys.map((key) => [key, calibration[key]]));
  return JSON.stringify(calibration.source ? { ...base, source: calibration.source } : base);
}

/** `2026-01-02 03:04:05` — same plain rendering CalibrationPanel already uses for profile timestamps. */
export function shortTimestamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}

export function loadDimensionCalibration(): DimensionCalibrationValues | null {
  if (typeof window === "undefined") return null;
  try {
    return parseDimensionCalibration(
      window.localStorage.getItem(DIMENSION_CALIBRATION_STORAGE_KEY)
    );
  } catch {
    return null;
  }
}

export function persistDimensionCalibration(
  calibration: DimensionCalibrationValues
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      DIMENSION_CALIBRATION_STORAGE_KEY,
      serializeDimensionCalibration(calibration)
    );
  } catch {
    /* localStorage may be disabled or full */
  }
}
