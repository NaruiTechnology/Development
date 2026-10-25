import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isDbConnectivityError,
  pgConnectionFromAdminConfig,
  pgConnectionFromOperationConfig,
  resolveSqlFile,
  type PgConnection,
} from "../src/adminDbService";
import { config } from "../src/config";
import {
  backupPathFor,
  ConfigError,
  readAdminWithBackup,
  readWithBackup,
  restartService,
  restoreFromBackup,
  writeAdminConfig,
  writeConfig,
  writeConfigIfChanged,
} from "../src/configManager";
import { scanArtifactBytesFromBody, testConfiguredFtpConnection } from "../src/ftpUpload";

const fallback: PgConnection = {
  host: "local",
  port: 5432,
  database: "fallback",
  user: "local-user",
  password: "local-password",
  sslMode: null,
  commandTimeoutMs: 1500,
};

test("database configuration accepts fields, URLs, fallbacks, and rejects non-Postgres URLs", () => {
  assert.deepEqual(pgConnectionFromAdminConfig({}, fallback), fallback);
  assert.deepEqual(pgConnectionFromAdminConfig({ Database: {
    Host: " shared ", Port: "5433", DatabaseName: "admin", User: "operator",
    Password: "secret", SslMode: "require", CommandTimeoutMs: "2500",
  } }, fallback), {
    host: "shared", port: 5433, database: "admin", user: "operator",
    password: "secret", sslMode: "require", commandTimeoutMs: 2500,
  });
  assert.deepEqual(pgConnectionFromAdminConfig({ Database: {
    ConnectionString: "postgresql://encoded%20user:p%40ss@db.example:5544/config%20db?sslmode=verify-full",
  } }, fallback), {
    host: "db.example", port: 5544, database: "config db", user: "encoded user",
    password: "p@ss", sslMode: "verify-full", commandTimeoutMs: 1500,
  });
  assert.deepEqual(pgConnectionFromOperationConfig({ Host: "operation", Port: 6000 }, fallback), {
    ...fallback, host: "operation", port: 6000, database: "operation_data",
  });
  assert.equal(pgConnectionFromOperationConfig({ Database: { DatabaseName: "" } }, {
    ...fallback, database: "",
  }).database, "operation_data");
  assert.throws(
    () => pgConnectionFromAdminConfig({ Database: { ConnectionString: "mysql://db/config" } }, fallback),
    /postgres:\/\/ or postgresql:\/\//,
  );
});

test("database helpers resolve SQL files and classify connection failures", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "admin-db-test-"));
  try {
    const sql = path.join(directory, "schema.sql");
    await fs.writeFile(sql, "SELECT 1;\n");
    assert.equal(resolveSqlFile(sql), sql);
    assert.throws(() => resolveSqlFile(path.join(directory, "missing.sql")), /SQL file not found/);
    for (const message of ["connection refused", "ENOTFOUND db", "timed out after 1ms", "no route to host"]) {
      assert.equal(isDbConnectivityError(message), true, message);
    }
    assert.equal(isDbConnectivityError("syntax error near SELECT"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("configuration lifecycle creates a frozen backup, detects no-op writes, and restores it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "config-manager-test-"));
  const previous = {
    configPath: config.configPath,
    adminConfigPath: config.adminConfigPath,
    configStrict: config.configStrict,
    restartCmd: config.restartCmd,
  };
  config.configPath = path.join(directory, "streamData.json");
  config.adminConfigPath = path.join(directory, "IobeamAdmin.json");
  config.configStrict = false;
  process.env.IOBEAM_SECRETS_FILE = path.join(directory, "secrets.env");
  const initial = { IsProduction: false, Actions: [] };
  try {
    assert.equal(backupPathFor(config.configPath), path.join(directory, "streamData_default.json"));
    assert.equal(backupPathFor(path.join(directory, "extensionless")), path.join(directory, "extensionless_default.json"));
    await assert.rejects(readWithBackup(), (error: unknown) => error instanceof ConfigError && error.status === 404);

    await writeConfig(initial);
    const firstRead = await readWithBackup();
    assert.equal(firstRead.backup_created, true);
    assert.equal(firstRead.has_backup, true);
    assert.deepEqual(firstRead.data, initial);
    assert.equal((await readWithBackup()).backup_created, false);
    assert.equal(await writeConfigIfChanged(initial), false);
    assert.equal(await writeConfigIfChanged({ ...initial, IsProduction: true }), true);
    assert.equal(await restoreFromBackup(), true);
    assert.deepEqual(JSON.parse(await fs.readFile(config.configPath, "utf8")), initial);
    assert.equal(await restoreFromBackup(), false);

    await writeAdminConfig({ Site: "lab", equipment: [{ id: 1 }], equipments: [{ id: 2 }] });
    const admin = await readAdminWithBackup();
    assert.deepEqual(admin.data, { Site: "lab" });

    await assert.rejects(
      writeConfig({ Actions: [{ streamData: { actionData: { adcHalfPeriod: 2, adcSettleCycles: 2, adcLatchCycles: 2 } } }] }),
      (error: unknown) => error instanceof ConfigError && error.status === 400,
    );
    config.configStrict = true;
    await fs.rm(config.configPath);
    await assert.rejects(writeConfig(initial), (error: unknown) => error instanceof ConfigError && error.status === 404);

    config.restartCmd = `"${process.execPath}" -e "process.stdout.write('restarted')"`;
    const success = await restartService();
    assert.equal(success.ok, true);
    assert.equal(success.stdout, "restarted");
    config.restartCmd = `"${process.execPath}" -e "process.stderr.write('failed');process.exit(2)"`;
    const failure = await restartService();
    assert.equal(failure.ok, false);
    assert.match(failure.stderr ?? "", /failed/);
  } finally {
    Object.assign(config, previous);
    delete process.env.IOBEAM_SECRETS_FILE;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("FTP request decoding rejects incomplete artifacts and reports unconfigured FTP", async () => {
  assert.equal(scanArtifactBytesFromBody(null), null);
  assert.equal(scanArtifactBytesFromBody([]), null);
  assert.equal(scanArtifactBytesFromBody({ csv_base64: "", image_base64: "aQ==" }), null);
  assert.deepEqual(scanArtifactBytesFromBody({ csv_base64: "Y3N2", image_base64: "cG5n" }), {
    csv: Buffer.from("csv"), image: Buffer.from("png"),
  });

  const previousPath = config.configPath;
  config.configPath = path.join(os.tmpdir(), `missing-ftp-${process.pid}.json`);
  try {
    const result = await testConfiguredFtpConnection();
    assert.deepEqual(result, {
      enabled: false,
      reachable: false,
      message: "FTP is disabled or not fully configured in streamData.json",
    });
  } finally {
    config.configPath = previousPath;
  }
});
