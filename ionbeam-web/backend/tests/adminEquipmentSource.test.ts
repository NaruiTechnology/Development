import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Equipment is stored only in the database: saving the admin configuration
// must not leave a copy in IobeamAdmin.json that could be shown when the
// database is unreachable.
test("writeAdminConfig keeps everything except equipment rows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-equipment-"));
  process.env.IOBEAM_SECRETS_FILE = path.join(dir, "secrets.env");
  process.env.IOBEAM_ADMIN_CONFIG = path.join(dir, "IobeamAdmin.json");
  try {
    const { writeAdminConfig, withoutEquipment } = await import("../src/configManager");
    const data = {
      Header: { Version: "1" },
      users: [{ id: 1, login_name: "a" }],
      equipment: { id: 1, name: "cached", serial_number: "S1" },
      equipments: [{ id: 1, name: "cached", serial_number: "S1" }],
    };
    assert.deepEqual(withoutEquipment(data), { Header: { Version: "1" }, users: [{ id: 1, login_name: "a" }] });
    await writeAdminConfig(data);
    const written = JSON.parse(fs.readFileSync(path.join(dir, "IobeamAdmin.json"), "utf8"));
    assert.equal("equipments" in written, false);
    assert.equal("equipment" in written, false);
    assert.deepEqual(written.users, data.users);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without a shared admin server the local admin database is used as a whole", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-fallback-"));
  process.env.IOBEAM_SECRETS_FILE = path.join(dir, "secrets.env");
  for (const name of ["IOBEAM_ADMIN_CONFIG_DB_HOST", "IOBEAM_ADMIN_CONFIG_DB_USER", "IOBEAM_ADMIN_CONFIG_DB_PASSWORD"]) {
    delete process.env[name];
  }
  try {
    const { pgConnectionFromAdminConfig } = await import("../src/adminDbService");
    const local = { host: "localhost", port: 5432, database: "iobeam_admin", user: "iobeam_admin_app",
      password: "local-pass", sslMode: null, commandTimeoutMs: 30000 };
    const config = { Database: { DatabaseName: "ionbeam_admin_db", Host: "${IOBEAM_ADMIN_CONFIG_DB_HOST}",
      User: "${IOBEAM_ADMIN_CONFIG_DB_USER}", Password: "${IOBEAM_ADMIN_CONFIG_DB_PASSWORD}",
      ConnectionString: "${IOBEAM_ADMIN_CONFIG_DB_URL:-}", Port: 5432 } };
    assert.deepEqual(pgConnectionFromAdminConfig(config, local), local);
    process.env.IOBEAM_ADMIN_CONFIG_DB_HOST = "shared.example";
    process.env.IOBEAM_ADMIN_CONFIG_DB_USER = "cfg";
    process.env.IOBEAM_ADMIN_CONFIG_DB_PASSWORD = "cfg-pass";
    const shared = pgConnectionFromAdminConfig(config, local);
    assert.deepEqual([shared.host, shared.user, shared.database], ["shared.example", "cfg", "ionbeam_admin_db"]);
  } finally {
    for (const name of ["IOBEAM_ADMIN_CONFIG_DB_HOST", "IOBEAM_ADMIN_CONFIG_DB_USER", "IOBEAM_ADMIN_CONFIG_DB_PASSWORD"]) {
      delete process.env[name];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
