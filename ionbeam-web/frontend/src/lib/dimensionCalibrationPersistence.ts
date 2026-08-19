export const DIMENSION_CALIBRATION_STORAGE_KEY = "ionbeam.dimensionCalibration.v1";

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
    return parsed as unknown as DimensionCalibrationValues;
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
  return JSON.stringify(
    Object.fromEntries(keys.map((key) => [key, calibration[key]]))
  );
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
