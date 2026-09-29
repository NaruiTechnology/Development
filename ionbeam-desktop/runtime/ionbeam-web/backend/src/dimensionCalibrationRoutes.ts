/**
 * HTTP API of the Dimension Cal server-side setting (CONFIGURATION > Calibrate > DIMENTION CAL).
 *
 *   GET /api/admin/iobeam/dimension-calibration/:equipmentId   current mapping for this equipment, or null
 *   PUT /api/admin/iobeam/dimension-calibration/:equipmentId   save it (from a manual measurement, or from
 *                                                               CONFIGURATION > Admin > Calibration's
 *                                                               "Go to Dimension Cal" shortcut)
 *
 * One row per equipment, not versioned — see IobeamAdmin/Sql/005_dimension_calibration_schema.sql. Any
 * signed-in account may read or write it; unlike the calibration-parameter catalog there's no per-field
 * role gate here, matching the DIMENTION CAL wedge itself (its own "Confirm" button has none either).
 */
import type express from "express";

import type { AdminUser } from "./adminDbRepository";
import {
  getDimensionCalibrationFromDb,
  saveDimensionCalibrationToDb,
  type DimensionCalibrationInput,
  type DimensionCalibrationRow,
} from "./dimensionCalibrationRepository";

export interface DimensionCalibrationRouteDeps {
  currentActor(req: express.Request): Promise<AdminUser | null>;
  sendError(res: express.Response, err: unknown): void;
}

const BASE = "/api/admin/iobeam/dimension-calibration";
const NUMERIC_FIELDS = [
  "x_origin",
  "x_end",
  "y_origin",
  "y_end",
  "viewport_x_start",
  "viewport_x_end",
  "viewport_y_start",
  "viewport_y_end",
] as const;

/**
 * The DB row is flat (source_kind / source_equipment_type / source_profile_revision / source_at as
 * separate columns); the frontend's DimensionCalibrationValues nests those under `source`. Without this,
 * a GET silently drops the provenance tag (source ends up undefined) every time it's loaded fresh — the
 * "Dimension Cal is currently ___" line in Scan geometry would go blank on every reload even though a
 * value really is saved.
 */
function toWireFormat(row: DimensionCalibrationRow) {
  const base = {
    x_origin: row.x_origin,
    x_end: row.x_end,
    y_origin: row.y_origin,
    y_end: row.y_end,
    viewport_x_start: row.viewport_x_start,
    viewport_x_end: row.viewport_x_end,
    viewport_y_start: row.viewport_y_start,
    viewport_y_end: row.viewport_y_end,
    scale_unit: row.scale_unit,
  };
  if (row.source_kind === "manual") {
    return { ...base, source: { kind: "manual" as const, set_at: row.source_at } };
  }
  return {
    ...base,
    source: {
      kind: "scanGeometry" as const,
      equipment_id: row.equipment_id,
      equipment_type: row.source_equipment_type as "FIB" | "SEM",
      profile_revision: row.source_profile_revision,
      applied_at: row.source_at,
    },
  };
}

export function registerDimensionCalibrationRoutes(app: express.Express, deps: DimensionCalibrationRouteDeps): void {
  app.get(`${BASE}/:equipmentId`, async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      const actor = await deps.currentActor(req);
      if (!actor || !actor.is_active) {
        res.status(401).json({ ok: false, error: "sign in to use dimension calibration" });
        return;
      }
      const equipmentId = parseEquipmentId(req.params.equipmentId);
      if (equipmentId === null) {
        res.status(400).json({ ok: false, error: "invalid equipment id" });
        return;
      }
      const row = await getDimensionCalibrationFromDb(equipmentId);
      res.json({ ok: true, calibration: row ? toWireFormat(row) : null });
    } catch (err) {
      deps.sendError(res, err);
    }
  });

  app.put(`${BASE}/:equipmentId`, async (req, res) => {
    try {
      const actor = await deps.currentActor(req);
      if (!actor || !actor.is_active) {
        res.status(401).json({ ok: false, error: "sign in to use dimension calibration" });
        return;
      }
      const equipmentId = parseEquipmentId(req.params.equipmentId);
      if (equipmentId === null) {
        res.status(400).json({ ok: false, error: "invalid equipment id" });
        return;
      }
      const input = readInput(req.body, equipmentId, actor.id);
      if (!input) {
        res.status(400).json({ ok: false, error: "malformed dimension calibration payload" });
        return;
      }
      const row = await saveDimensionCalibrationToDb(input);
      res.json({ ok: true, calibration: toWireFormat(row) });
    } catch (err) {
      deps.sendError(res, err);
    }
  });
}

function parseEquipmentId(raw: unknown): number | null {
  const id = Number.parseInt(String(raw), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function readInput(body: unknown, equipmentId: number, actorId: number | null): DimensionCalibrationInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const v: Partial<Record<(typeof NUMERIC_FIELDS)[number], number>> = {};
  for (const field of NUMERIC_FIELDS) {
    const value = b[field];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    v[field] = value;
  }
  const scaleUnit = typeof b.scale_unit === "string" ? b.scale_unit.trim() : "";
  if (!scaleUnit) return null;
  const source = b.source;
  if (!source || typeof source !== "object") return null;
  const s = source as Record<string, unknown>;

  const base = {
    equipment_id: equipmentId,
    x_origin: v.x_origin!,
    x_end: v.x_end!,
    y_origin: v.y_origin!,
    y_end: v.y_end!,
    viewport_x_start: v.viewport_x_start!,
    viewport_x_end: v.viewport_x_end!,
    viewport_y_start: v.viewport_y_start!,
    viewport_y_end: v.viewport_y_end!,
    scale_unit: scaleUnit,
    updated_by: actorId,
  };

  if (s.kind === "manual") {
    return {
      ...base,
      source_kind: "manual",
      source_equipment_type: null,
      source_profile_revision: null,
      source_at: typeof s.set_at === "string" ? s.set_at : new Date().toISOString(),
    };
  }
  if (s.kind === "scanGeometry" && (s.equipment_type === "FIB" || s.equipment_type === "SEM")) {
    return {
      ...base,
      source_kind: "scanGeometry",
      source_equipment_type: s.equipment_type,
      source_profile_revision: typeof s.profile_revision === "number" ? s.profile_revision : null,
      source_at: typeof s.applied_at === "string" ? s.applied_at : new Date().toISOString(),
    };
  }
  return null;
}
