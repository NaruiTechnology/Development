export const DIMENSION_CALIBRATION_STORAGE_KEY = "ionbeam.dimensionCalibration.v1";
const NUMERIC_KEYS = [
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
function parseSource(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const v = value;
    if (v.kind === "manual" && typeof v.set_at === "string") {
        return { kind: "manual", set_at: v.set_at };
    }
    if (v.kind === "scanGeometry" &&
        typeof v.equipment_id === "number" &&
        (v.equipment_type === "FIB" || v.equipment_type === "SEM") &&
        (v.profile_revision === null || typeof v.profile_revision === "number") &&
        typeof v.applied_at === "string") {
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
export function parseDimensionCalibration(raw) {
    if (!raw)
        return null;
    try {
        const value = JSON.parse(raw);
        const parsed = {};
        for (const key of NUMERIC_KEYS) {
            const candidate = value[key];
            if (typeof candidate !== "number" || !Number.isFinite(candidate))
                return null;
            parsed[key] = candidate;
        }
        const scaleUnit = typeof value.scale_unit === "string"
            ? value.scale_unit.trim()
            : "";
        if (!scaleUnit ||
            Number(parsed.x_end) <= Number(parsed.x_origin) ||
            Number(parsed.y_end) <= Number(parsed.y_origin) ||
            Number(parsed.viewport_x_end) <= Number(parsed.viewport_x_start) ||
            Number(parsed.viewport_y_end) <= Number(parsed.viewport_y_start)) {
            return null;
        }
        parsed.scale_unit = scaleUnit;
        const result = parsed;
        const source = parseSource(value.source);
        if (source)
            result.source = source;
        return result;
    }
    catch {
        return null;
    }
}
export function serializeDimensionCalibration(calibration) {
    const keys = [
        ...NUMERIC_KEYS,
        "scale_unit",
    ];
    const base = Object.fromEntries(keys.map((key) => [key, calibration[key]]));
    return JSON.stringify(calibration.source ? { ...base, source: calibration.source } : base);
}
/** `2026-01-02 03:04:05` — same plain rendering CalibrationPanel already uses for profile timestamps. */
export function shortTimestamp(iso) {
    return iso.replace("T", " ").slice(0, 19);
}
export function loadDimensionCalibration() {
    if (typeof window === "undefined")
        return null;
    try {
        return parseDimensionCalibration(window.localStorage.getItem(DIMENSION_CALIBRATION_STORAGE_KEY));
    }
    catch {
        return null;
    }
}
export function persistDimensionCalibration(calibration) {
    if (typeof window === "undefined")
        return;
    try {
        window.localStorage.setItem(DIMENSION_CALIBRATION_STORAGE_KEY, serializeDimensionCalibration(calibration));
    }
    catch {
        /* localStorage may be disabled or full */
    }
}
