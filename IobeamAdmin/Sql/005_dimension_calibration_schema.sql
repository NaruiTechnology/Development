-- =====================================================================================================
-- 005_dimension_calibration_schema.sql  -  Dimension Cal (CONFIGURATION > Calibrate > DIMENTION CAL)
--
-- Loaded after 001/002/003 by applyAdminDatabaseSetup(); fully idempotent, like the others. Objects live
-- in the existing `ionbeam_asset` schema, next to ionbeam_asset.equipment.
--
-- One row per equipment: the current world-coordinate (µm) mapping used to convert an ROI selection to
-- DAC codes (see frontend lib/roiDac.ts). Deliberately NOT versioned/audited like calibration_* (003) —
-- this is a single current setting, not a parameter catalog. `source_kind` records whether it was last
-- set by the operator measuring an image (DIMENTION CAL "Confirm") or computed from the equipment's
-- calibration profile (CONFIGURATION > Admin > Calibration, "Go to Dimension Cal"), so the UI can show
-- where the active numbers came from and warn before one source overwrites the other.
--
-- Public functions (jsonb in/out, called by ionbeam-web/backend/src/dimensionCalibrationRepository.ts):
--   fn_get_dimension_calibration(payload)     payload: {equipment_id}                 -> row or null
--   fn_upsert_dimension_calibration(payload)  payload: the row (see column list below) -> saved row
-- =====================================================================================================
CREATE SCHEMA IF NOT EXISTS ionbeam_asset;
SET search_path TO ionbeam_asset, iobeam_admin, public;

CREATE TABLE IF NOT EXISTS ionbeam_asset.dimension_calibration (
    equipment_id             integer          PRIMARY KEY REFERENCES ionbeam_asset.equipment(id) ON DELETE CASCADE,
    x_origin                 double precision NOT NULL,
    x_end                    double precision NOT NULL,
    y_origin                 double precision NOT NULL,
    y_end                    double precision NOT NULL,
    viewport_x_start         double precision NOT NULL,
    viewport_x_end           double precision NOT NULL,
    viewport_y_start         double precision NOT NULL,
    viewport_y_end           double precision NOT NULL,
    scale_unit               varchar(10)      NOT NULL,
    source_kind              varchar(20)      NOT NULL CHECK (source_kind IN ('manual', 'scanGeometry')),
    source_equipment_type    varchar(3)       CHECK (source_equipment_type IN ('FIB', 'SEM')),
    source_profile_revision  integer,
    source_at                timestamp(6)     NOT NULL,
    updated_by               integer          REFERENCES iobeam_admin."user"(id),
    updated_at                timestamp(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION fn_get_dimension_calibration(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    eq_id  integer := (payload ->> 'equipment_id')::integer;
    result jsonb;
BEGIN
    SELECT to_jsonb(d) INTO result
      FROM ionbeam_asset.dimension_calibration d
     WHERE d.equipment_id = eq_id;
    RETURN result; -- null when this equipment has never had one saved
END;
$$;

CREATE OR REPLACE FUNCTION fn_upsert_dimension_calibration(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    result ionbeam_asset.dimension_calibration;
BEGIN
    INSERT INTO ionbeam_asset.dimension_calibration AS d (
        equipment_id, x_origin, x_end, y_origin, y_end,
        viewport_x_start, viewport_x_end, viewport_y_start, viewport_y_end,
        scale_unit, source_kind, source_equipment_type, source_profile_revision, source_at,
        updated_by, updated_at
    ) VALUES (
        (payload ->> 'equipment_id')::integer,
        (payload ->> 'x_origin')::double precision,
        (payload ->> 'x_end')::double precision,
        (payload ->> 'y_origin')::double precision,
        (payload ->> 'y_end')::double precision,
        (payload ->> 'viewport_x_start')::double precision,
        (payload ->> 'viewport_x_end')::double precision,
        (payload ->> 'viewport_y_start')::double precision,
        (payload ->> 'viewport_y_end')::double precision,
        payload ->> 'scale_unit',
        payload ->> 'source_kind',
        NULLIF(payload ->> 'source_equipment_type', ''),
        NULLIF(payload ->> 'source_profile_revision', '')::integer,
        COALESCE((payload ->> 'source_at')::timestamp, CURRENT_TIMESTAMP),
        NULLIF(payload ->> 'updated_by', '')::integer,
        CURRENT_TIMESTAMP
    )
    ON CONFLICT (equipment_id) DO UPDATE SET
        x_origin                = EXCLUDED.x_origin,
        x_end                   = EXCLUDED.x_end,
        y_origin                = EXCLUDED.y_origin,
        y_end                   = EXCLUDED.y_end,
        viewport_x_start        = EXCLUDED.viewport_x_start,
        viewport_x_end          = EXCLUDED.viewport_x_end,
        viewport_y_start        = EXCLUDED.viewport_y_start,
        viewport_y_end          = EXCLUDED.viewport_y_end,
        scale_unit               = EXCLUDED.scale_unit,
        source_kind              = EXCLUDED.source_kind,
        source_equipment_type    = EXCLUDED.source_equipment_type,
        source_profile_revision  = EXCLUDED.source_profile_revision,
        source_at                = EXCLUDED.source_at,
        updated_by               = EXCLUDED.updated_by,
        updated_at               = CURRENT_TIMESTAMP
    RETURNING d.* INTO result;
    RETURN to_jsonb(result);
END;
$$;
