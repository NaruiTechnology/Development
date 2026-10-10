import { ensureAdminSchema, queryAdminStored } from "../adminDbRepository";
import { loadCalibrationCatalogSeed } from "../calibrationRepository";

/**
 * Applies the calibration schema (003) and (re)loads the parameter catalog (004_calibration_seed.sql).
 * Idempotent: parameter names / descriptions / units that were edited in the UI are kept.
 * The API also does this automatically the first time it finds an empty catalog; run this after regenerating
 * 004 (IobeamAdmin/CalibrationCatalog/build_seed.py) to roll catalog changes out.
 */
async function main(): Promise<void> {
  console.log("[db-seed:calibration] applying admin schema");
  await ensureAdminSchema();
  console.log("[db-seed:calibration] loading 004_calibration_seed.sql");
  await loadCalibrationCatalogSeed();
  const counts = await queryAdminStored(
    `SELECT equipment_type || ': ' || count(*) FROM ionbeam_asset.calibration_parameter_definition GROUP BY equipment_type ORDER BY 1;`,
  );
  console.log(`[db-seed:calibration] catalog now holds\n${counts}`);
}

main().catch((err) => {
  console.error("[db-seed:calibration] failed:", err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
});
