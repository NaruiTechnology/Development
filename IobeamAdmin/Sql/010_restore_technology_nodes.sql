-- Frozen from Git HEAD stepReceipes.json. Runtime selectors use equipment database rows.
CREATE OR REPLACE FUNCTION ionbeam_asset.stair_recipe_defaults() RETURNS jsonb
 LANGUAGE sql IMMUTABLE AS $body$ SELECT '[{"SMProcess":{"model":"StairRecipeDefaults","caption":"Semiconductor Manufacturing Process","stepDefaults":{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none"},"nodes":[{"name":"28nm","steps":[{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.2,"material":"Si","removalRateUM3PerNC":0.27},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.4,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.6,"material":"Au","removalRateUM3PerNC":1.5},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.8,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":1.0,"material":"Si","removalRateUM3PerNC":0.27}]},{"name":"14nm","steps":[{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.2,"material":"Si","removalRateUM3PerNC":0.27},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.4,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.6,"material":"Au","removalRateUM3PerNC":1.5},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.8,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":1.0,"material":"Si","removalRateUM3PerNC":0.27}]},{"name":"7nm","steps":[{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.2,"material":"Si","removalRateUM3PerNC":0.27},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.4,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.6,"material":"Au","removalRateUM3PerNC":1.5},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.8,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":1.0,"material":"Si","removalRateUM3PerNC":0.27}]},{"name":"5nm","steps":[{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.2,"material":"Si","removalRateUM3PerNC":0.27},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.4,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.6,"material":"Au","removalRateUM3PerNC":1.5},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.8,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":1.0,"material":"Si","removalRateUM3PerNC":0.27}]},{"name":"2nm","steps":[{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.2,"material":"Si","removalRateUM3PerNC":0.27},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.4,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.6,"material":"Au","removalRateUM3PerNC":1.5},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.8,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":1.0,"material":"Si","removalRateUM3PerNC":0.27}]},{"name":"1nm","steps":[{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.2,"material":"Si","removalRateUM3PerNC":0.27},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.4,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.6,"material":"Au","removalRateUM3PerNC":1.5},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":0.8,"material":"SiO2","removalRateUM3PerNC":0.24},{"dwellUS":1,"overlapPercent":50,"passes":1,"after":"none","enabled":true,"depthUM":1.0,"material":"Si","removalRateUM3PerNC":0.27}]}]}}]'::jsonb $body$;

-- Restore missing original named nodes; retain edits to named nodes and custom nodes.
-- The obsolete generic Imported CSV node is archived by 009 before replacement.
CREATE OR REPLACE FUNCTION ionbeam_asset.restore_stair_technology_nodes() RETURNS integer
LANGUAGE plpgsql AS $body$
DECLARE restored integer;
BEGIN
 WITH template AS (SELECT ionbeam_asset.stair_recipe_defaults()->0->'SMProcess' AS v),
 documents AS (
   SELECT e.id, r.collections AS old_document,
    (SELECT item->'SMProcess' FROM jsonb_array_elements(coalesce(r.collections,'[]'::jsonb)) item
     WHERE item ? 'SMProcess' LIMIT 1) AS existing, template.v
   FROM ionbeam_asset.equipment e CROSS JOIN template
   LEFT JOIN ionbeam_asset.pattern_recipe r ON r.equipment_id=e.id AND r.pattern_key='stairCut'
 ), merged AS (
   SELECT id, jsonb_build_array(jsonb_build_object('SMProcess',
     v || coalesce(existing,'{}'::jsonb) || jsonb_build_object(
       'caption', CASE WHEN existing IS NULL OR existing->>'caption' LIKE 'Imported from %' THEN v->>'caption' ELSE existing->>'caption' END,
       'nodes',
       (SELECT jsonb_agg(coalesce((SELECT n FROM jsonb_array_elements(coalesce(existing->'nodes','[]'::jsonb)) n
          WHERE n->>'name'=t->>'name' LIMIT 1),t) ORDER BY ord)
        FROM jsonb_array_elements(v->'nodes') WITH ORDINALITY AS nodes(t,ord))
       || coalesce((SELECT jsonb_agg(n) FROM jsonb_array_elements(coalesce(existing->'nodes','[]'::jsonb)) n
          WHERE n->>'name'<>'Imported CSV' AND NOT EXISTS
            (SELECT 1 FROM jsonb_array_elements(v->'nodes') t WHERE t->>'name'=n->>'name')),'[]'::jsonb)
     ))) || coalesce((SELECT jsonb_agg(item) FROM jsonb_array_elements(coalesce(old_document,'[]'::jsonb)) item
       WHERE NOT item ? 'SMProcess'),'[]'::jsonb) AS collections
   FROM documents
 )
 INSERT INTO ionbeam_asset.pattern_recipe AS current(equipment_id,pattern_key,collections,source_sha256)
 SELECT id,'stairCut',collections,'3f8967b855bd48119203b58326f7613242033c6d1a16048002c32f3facb4d7a8' FROM merged WHERE true
 ON CONFLICT(equipment_id,pattern_key) DO UPDATE SET collections=EXCLUDED.collections,
    source_sha256=EXCLUDED.source_sha256,revision=current.revision+1,updated_at=clock_timestamp(),updated_by=NULL
 WHERE current.collections IS DISTINCT FROM EXCLUDED.collections;
 GET DIAGNOSTICS restored=ROW_COUNT;
 RETURN restored;
END $body$;

CREATE OR REPLACE FUNCTION ionbeam_asset.seed_equipment_stair_recipe() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 INSERT INTO ionbeam_asset.pattern_recipe(equipment_id,pattern_key,collections,source_sha256)
 VALUES(NEW.id,'stairCut',ionbeam_asset.stair_recipe_defaults(),'3f8967b855bd48119203b58326f7613242033c6d1a16048002c32f3facb4d7a8') ON CONFLICT DO NOTHING;
 RETURN NEW;
END $body$;

-- The trigger also marks successful one-time restoration. Later schema checks must not
-- undo an operator's deliberate node removals. Explicit restoration remains available.
DO $body$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='equipment_seed_stair_recipe'
   AND tgrelid='ionbeam_asset.equipment'::regclass) THEN
   PERFORM ionbeam_asset.restore_stair_technology_nodes();
   CREATE TRIGGER equipment_seed_stair_recipe AFTER INSERT ON ionbeam_asset.equipment
     FOR EACH ROW EXECUTE FUNCTION ionbeam_asset.seed_equipment_stair_recipe();
 END IF;
END $body$;
