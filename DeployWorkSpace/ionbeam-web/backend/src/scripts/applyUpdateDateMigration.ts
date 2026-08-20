import { ensureAdminSchema } from "../adminDbRepository";
import { ensureOperationSchema } from "../operationDataRepository";

async function main(): Promise<void> {
  console.log("[db-migrate:update-date] applying admin schema update");
  await ensureAdminSchema();

  console.log("[db-migrate:update-date] applying operation schema update");
  await ensureOperationSchema();

  console.log("[db-migrate:update-date] migration complete");
}

main().catch((err) => {
  console.error(
    "[db-migrate:update-date] migration failed:",
    err instanceof Error ? err.stack || err.message : String(err),
  );
  process.exitCode = 1;
});
