import { queryAdminStoredStrict } from "../adminDbRepository";
async function main() {
  const restored = await queryAdminStoredStrict("SELECT ionbeam_asset.restore_stair_technology_nodes();");
  const summary = await queryAdminStoredStrict(`SELECT json_build_object('equipment', count(*),
    'complete', count(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(ionbeam_asset.stair_recipe_defaults()->0->'SMProcess'->'nodes') expected
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.collections->0->'SMProcess'->'nodes') actual
        WHERE actual->>'name'=expected->>'name'))))
    FROM ionbeam_asset.equipment e LEFT JOIN ionbeam_asset.pattern_recipe r ON r.equipment_id=e.id AND r.pattern_key='stairCut';`);
  console.log(JSON.stringify({changed: Number(restored), verified: JSON.parse(summary)}));
}
main().catch(error => {console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1;});
