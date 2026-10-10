"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const adminDbRepository_1 = require("../adminDbRepository");
const operationDataRepository_1 = require("../operationDataRepository");
async function main() {
    console.log("[db-migrate:update-date] applying admin schema update");
    await (0, adminDbRepository_1.ensureAdminSchema)();
    console.log("[db-migrate:update-date] applying operation schema update");
    await (0, operationDataRepository_1.ensureOperationSchema)();
    console.log("[db-migrate:update-date] migration complete");
}
main().catch((err) => {
    console.error("[db-migrate:update-date] migration failed:", err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
});
//# sourceMappingURL=applyUpdateDateMigration.js.map