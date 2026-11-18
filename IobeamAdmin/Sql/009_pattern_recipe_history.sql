-- Preserve every replaced recipe document, including the CSV import being restored.
CREATE TABLE IF NOT EXISTS ionbeam_asset.pattern_recipe_history (
 equipment_id integer NOT NULL REFERENCES ionbeam_asset.equipment(id) ON DELETE CASCADE,
 pattern_key text NOT NULL, revision integer NOT NULL,
 collections jsonb NOT NULL, source_sha256 text NOT NULL,
 updated_at timestamptz NOT NULL, updated_by integer,
 archived_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (equipment_id, pattern_key, revision)
);
CREATE OR REPLACE FUNCTION ionbeam_asset.archive_pattern_recipe() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 INSERT INTO ionbeam_asset.pattern_recipe_history(equipment_id,pattern_key,revision,collections,source_sha256,updated_at,updated_by)
 VALUES(OLD.equipment_id,OLD.pattern_key,OLD.revision,OLD.collections,OLD.source_sha256,OLD.updated_at,OLD.updated_by)
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $body$;
DROP TRIGGER IF EXISTS pattern_recipe_archive_update ON ionbeam_asset.pattern_recipe;
CREATE TRIGGER pattern_recipe_archive_update BEFORE UPDATE ON ionbeam_asset.pattern_recipe
 FOR EACH ROW EXECUTE FUNCTION ionbeam_asset.archive_pattern_recipe();
