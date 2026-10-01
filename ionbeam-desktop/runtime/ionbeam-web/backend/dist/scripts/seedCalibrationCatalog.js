"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const adminDbRepository_1 = require("../adminDbRepository");
const calibrationRepository_1 = require("../calibrationRepository");
/**
 * Applies the calibration schema (003) and (re)loads the parameter catalog (004_calibration_seed.sql).
 * Idempotent: parameter names / descriptions / units that were edited in the UI are kept.
 * The API also does this automatically the first time it finds an empty catalog; run this after regenerating
 * 004 (IobeamAdmin/CalibrationCatalog/build_seed.py) to roll catalog changes out.
 */
async function main() {
    console.log("[db-seed:calibration] applying admin schema");
    await (0, adminDbRepository_1.ensureAdminSchema)();
    console.log("[db-seed:calibration] loading 004_calibration_seed.sql");
    await (0, calibrationRepository_1.loadCalibrationCatalogSeed)();
    const counts = await (0, adminDbRepository_1.queryAdminStored)(`SELECT equipment_type || ': ' || count(*) FROM ionbeam_asset.calibration_parameter_definition GROUP BY equipment_type ORDER BY 1;`);
    console.log(`[db-seed:calibration] catalog now holds\n${counts}`);
}
main().catch((err) => {
    console.error("[db-seed:calibration] failed:", err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
});
//# sourceMappingURL=seedCalibrationCatalog.js.map