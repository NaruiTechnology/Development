import assert from "node:assert/strict";
import test from "node:test";
import { queryAdminStoredStrict } from "../src/adminDbRepository";
import { SAVE_PATTERN_RECIPE_SQL } from "../src/patternRecipeRepository";

test("PostgreSQL creates, revises and refuses stale recipe saves atomically", {skip: process.env.IONBEAM_RECIPE_DB_TEST !== "1"}, async () => {
  const identity = JSON.parse(await queryAdminStoredStrict(`SELECT json_build_object(
    'equipment_id', (SELECT min(id) FROM ionbeam_asset.equipment),
    'actor_id', (SELECT min(id) FROM iobeam_admin."user"));`));
  assert.ok(identity.equipment_id && identity.actor_id, "an existing equipment and account are required");
  const key = `RecipeTest${Date.now()}`;
  const payload = {...identity, pattern_key: key, expected_revision: 0, collections: [], sha256: "test"};
  const update = SAVE_PATTERN_RECIPE_SQL.replace("SELECT $$payload$$ AS p", () => "SELECT jsonb_set($$payload$$, '{expected_revision}', '1'::jsonb) AS p");
  // Everything, including the test assignment, is rolled back by this one PostgreSQL session.
  const sql = `BEGIN;
    ${SAVE_PATTERN_RECIPE_SQL}
    ${update}
    ${SAVE_PATTERN_RECIPE_SQL}
    DO $check$ BEGIN
      IF (SELECT revision FROM ionbeam_asset.pattern_recipe WHERE pattern_key = '${key}') IS DISTINCT FROM 2
        THEN RAISE EXCEPTION 'stale save unexpectedly changed the revision'; END IF;
    END $check$;
    ROLLBACK;`;
  await queryAdminStoredStrict(sql, payload);
  const remaining = await queryAdminStoredStrict(`SELECT count(*) FROM ionbeam_asset.pattern_recipe WHERE pattern_key = '${key}';`);
  assert.equal(remaining, "0");
});
