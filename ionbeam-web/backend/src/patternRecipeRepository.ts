import { createHash } from "node:crypto";
import { queryAdminStoredStrict } from "./adminDbRepository";
import { ConfigError } from "./configManager";
import { parseStairReceipes } from "./processingPatternsConfig";

export function validateRecipeKey(equipmentId: number, patternKey: string): void {
  if (!Number.isSafeInteger(equipmentId) || equipmentId <= 0)
    throw new ConfigError("equipment_id must be a positive integer", 400);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(patternKey))
    throw new ConfigError("Invalid pattern key", 400);
}

export async function getPatternRecipes(equipmentId: number, patternKey: string) {
  validateRecipeKey(equipmentId, patternKey);
  const raw = await queryAdminStoredStrict(`SELECT collections FROM ionbeam_asset.pattern_recipe, (SELECT $$payload$$ AS p) input
    WHERE equipment_id = (p->>'equipment_id')::integer
      AND pattern_key = p->>'pattern_key';`, { equipment_id: equipmentId, pattern_key: patternKey });
  if (!raw.trim()) throw new ConfigError(`No ${patternKey} recipes assigned to equipment ${equipmentId}`, 404);
  return parseStairReceipes(JSON.parse(raw));
}

/** An unassigned recipe is valid catalogue state; database failures must still surface. */
export async function getOptionalPatternRecipes(equipmentId: number, patternKey: string,
  lookup: typeof getPatternRecipes = getPatternRecipes) {
  try { return await lookup(equipmentId, patternKey); }
  catch (error) {
    if (error instanceof ConfigError && error.status === 404) return {};
    throw error;
  }
}

export async function importPatternRecipes(equipmentId: number, patternKey: string, collections: unknown, sha256: string) {
  validateRecipeKey(equipmentId, patternKey);
  const parsed = parseStairReceipes(collections);
  if (!Object.keys(parsed).length || (patternKey === "stairCut" && !parsed.SMProcess))
    throw new ConfigError("Import requires a recipe collection; Stair cut requires SMProcess", 400);
  const raw = await queryAdminStoredStrict(`WITH imported AS (
    INSERT INTO ionbeam_asset.pattern_recipe (equipment_id, pattern_key, collections, source_sha256)
    SELECT (p->>'equipment_id')::integer, p->>'pattern_key', p->'collections', p->>'sha256'
    FROM (SELECT $$payload$$ AS p) input
    ON CONFLICT (equipment_id, pattern_key) DO NOTHING RETURNING 1
  ) SELECT count(*) FROM imported;`, { equipment_id: equipmentId, pattern_key: patternKey, collections, sha256 });
  return Number(raw.trim()) === 1;
}

export interface PatternRecipeRecord {
  equipment_id: number; pattern_key: string; collections: unknown;
  revision: number; imported_at: string; updated_at: string; updated_by: number | null;
}

export function validateRecipeDocument(patternKey: string, collections: unknown) {
  try {
    const parsed = parseStairReceipes(collections);
    if (!Object.keys(parsed).length || (patternKey === "stairCut" && !parsed.SMProcess))
      throw new Error("Stair cut requires an SMProcess recipe collection");
    return Object.entries(parsed).map(([name, value]) => ({ [name]: value }));
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error), 422);
  }
}

export async function listPatternRecipeAssignments() {
  const raw = await queryAdminStoredStrict(`SELECT coalesce(json_agg(r ORDER BY equipment_id, pattern_key), '[]'::json)
    FROM (SELECT equipment_id, pattern_key, revision, updated_at FROM ionbeam_asset.pattern_recipe) r;`);
  return JSON.parse(raw || "[]") as Array<Pick<PatternRecipeRecord, "equipment_id" | "pattern_key" | "revision" | "updated_at">>;
}

export async function getPatternRecipeRecord(equipmentId: number, patternKey: string): Promise<PatternRecipeRecord | null> {
  validateRecipeKey(equipmentId, patternKey);
  const raw = await queryAdminStoredStrict(`SELECT row_to_json(r) FROM ionbeam_asset.pattern_recipe r,
    (SELECT $$payload$$ AS p) input WHERE equipment_id = (p->>'equipment_id')::integer AND pattern_key = p->>'pattern_key';`,
    { equipment_id: equipmentId, pattern_key: patternKey });
  if (!raw) return null;
  const record = JSON.parse(raw) as PatternRecipeRecord;
  record.collections = validateRecipeDocument(patternKey, record.collections);
  return record;
}

export async function savePatternRecipeRecord(equipmentId: number, patternKey: string, collections: unknown,
  expectedRevision: number, actorId: number) {
  validateRecipeKey(equipmentId, patternKey);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new ConfigError("expected_revision must be a nonnegative integer", 400);
  const normalized = validateRecipeDocument(patternKey, collections);
  const raw = await queryAdminStoredStrict(SAVE_PATTERN_RECIPE_SQL, { equipment_id: equipmentId, pattern_key: patternKey,
    collections: normalized, expected_revision: expectedRevision, actor_id: actorId,
    sha256: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") });
  if (!raw) throw new ConfigError("Recipes changed in another session. Reload before saving.", 409);
  return JSON.parse(raw) as PatternRecipeRecord;
}

/** Shared with the rollback-only PostgreSQL integration check. */
export const SAVE_PATTERN_RECIPE_SQL = `WITH input AS (SELECT $$payload$$ AS p), saved AS (
    INSERT INTO ionbeam_asset.pattern_recipe AS current (equipment_id, pattern_key, collections, source_sha256, updated_by)
    SELECT (p->>'equipment_id')::integer, p->>'pattern_key', p->'collections', p->>'sha256', (p->>'actor_id')::integer
    FROM input WHERE (p->>'expected_revision')::integer = 0 OR EXISTS (
      SELECT 1 FROM ionbeam_asset.pattern_recipe WHERE equipment_id = (p->>'equipment_id')::integer AND pattern_key = p->>'pattern_key')
    ON CONFLICT (equipment_id, pattern_key) DO UPDATE SET
      collections = EXCLUDED.collections, source_sha256 = EXCLUDED.source_sha256,
      revision = current.revision + 1, updated_at = clock_timestamp(), updated_by = EXCLUDED.updated_by
    WHERE current.revision = (SELECT (p->>'expected_revision')::integer FROM input)
    RETURNING *
  ) SELECT row_to_json(saved) FROM saved;`;

/** Default technology nodes are stored by the database migration, not a runtime JSON sidecar. */
export async function getPatternRecipeDefaults(patternKey: string) {
  if (patternKey !== "stairCut") throw new ConfigError("No recipe defaults for this pattern", 404);
  const raw = await queryAdminStoredStrict("SELECT ionbeam_asset.stair_recipe_defaults();");
  return validateRecipeDocument(patternKey, JSON.parse(raw));
}
