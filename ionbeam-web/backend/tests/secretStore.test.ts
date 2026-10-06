import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// secretStore resolves its file path at call time, so setting the variable
// here (after the hoisted import) still isolates every test below.
import * as store from "../src/secretStore";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "secretstore-test-"));
const secretsFile = path.join(tempRoot, "cfg", "iobeam", "secrets.env");
process.env.IOBEAM_SECRETS_FILE = secretsFile;

// Same cases as Development/secretstore/tests/test_secretstore.py.
const cases = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../secretstore/tests/cases.json"), "utf8"),
) as {
  parse: Array<{ text: string; values: Record<string, string> }>;
  parse_errors: string[];
  roundtrip: string[];
  expand: Array<{ env: Record<string, string>; input: string; output: string }>;
};

function reset(): void {
  fs.rmSync(path.dirname(secretsFile), { recursive: true, force: true });
  for (const name of Object.keys(process.env)) {
    if (/^(X|MISSING|T_|IOBEAM_FTP_|IOBEAM_ADMIN_CONFIG_DB_)/.test(name)) delete process.env[name];
  }
}

test("parses the shared EnvironmentFile cases like the Python implementation", () => {
  for (const c of cases.parse) assert.deepEqual(store.parseEnv(c.text), c.values, c.text);
  for (const text of cases.parse_errors) assert.throws(() => store.parseEnv(text), store.SecretError, text);
});

test("written values read back identically", () => {
  reset();
  for (const value of cases.roundtrip) {
    store.writeSecrets({ V: value });
    assert.equal(store.readSecretsFile()["V"], value);
  }
  assert.equal(fs.statSync(secretsFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(secretsFile)).mode & 0o777, 0o700);
});

test("expands the shared placeholder cases", () => {
  for (const c of cases.expand) {
    reset();
    Object.assign(process.env, c.env);
    assert.equal(store.expandPlaceholders(c.input, true), c.output, c.input);
  }
});

test("environment wins over the secrets file; unresolved is blank in lenient mode", () => {
  reset();
  store.writeSecrets({ T_PW: "from-file" });
  assert.equal(store.expandPlaceholders("${T_PW}"), "from-file");
  process.env.T_PW = "from-env";
  assert.equal(store.expandPlaceholders("${T_PW}"), "from-env");
  assert.equal(store.expandPlaceholders("${T_NONE}"), "");
  assert.throws(() => store.expandPlaceholders("${T_NONE}", true), /T_NONE/);
});

test("refuses a secrets file other users can read", () => {
  reset();
  store.writeSecrets({ A: "1" });
  fs.chmodSync(secretsFile, 0o644);
  assert.throws(() => store.readSecretsFile(), /chmod 600/);
});

test("a password typed in the settings UI is moved out of streamData.json", () => {
  reset();
  const data = {
    Actions: [{ streamData: { actionData: { ftp: {
      enabled: true, host: "${IOBEAM_FTP_HOST}", username: "new-user", password: "typed-pass", folder: "/upload",
    } } } }],
  };
  const saved = store.externalizeSecrets(data, store.STREAM_SECRET_BINDINGS);
  const ftp = saved.Actions[0].streamData.actionData.ftp;
  assert.equal(ftp.host, "${IOBEAM_FTP_HOST}"); // untouched reference
  assert.equal(ftp.username, "${IOBEAM_FTP_USER}");
  assert.equal(ftp.password, "${IOBEAM_FTP_PASSWORD}");
  assert.equal(ftp.folder, "/upload");
  assert.equal(data.Actions[0].streamData.actionData.ftp.password, "typed-pass"); // input not mutated
  assert.ok(!JSON.stringify(saved).includes("typed-pass"));
  assert.deepEqual(
    { user: store.readSecretsFile()["IOBEAM_FTP_USER"], pw: store.readSecretsFile()["IOBEAM_FTP_PASSWORD"] },
    { user: "new-user", pw: "typed-pass" },
  );
  assert.equal(store.expandPlaceholders(ftp.password), "typed-pass");
});

test("admin database credentials use their own variables", () => {
  reset();
  const saved = store.externalizeSecrets(
    { Database: { Host: "db", User: "u", Password: "p", ConnectionString: "postgresql://u:p@db/x", Port: 5432 } },
    store.ADMIN_SECRET_BINDINGS,
  );
  assert.deepEqual(saved.Database, {
    Host: "${IOBEAM_ADMIN_CONFIG_DB_HOST}",
    User: "${IOBEAM_ADMIN_CONFIG_DB_USER}",
    Password: "${IOBEAM_ADMIN_CONFIG_DB_PASSWORD}",
    ConnectionString: "${IOBEAM_ADMIN_CONFIG_DB_URL:-}",
    Port: 5432,
  });
});

test("automatic migration fills gaps, never clobbers, and leaves hosts alone", () => {
  reset();
  store.writeSecrets({ IOBEAM_ADMIN_CONFIG_DB_HOST: "live-host", IOBEAM_ADMIN_CONFIG_DB_PASSWORD: "live-pass" });
  const backup = { Database: { Host: "localhost", User: "old-user", Password: "stale-pass", Port: 5432 } };
  const migrated = store.externalizeSecrets(backup, store.ADMIN_SECRET_BINDINGS, {
    overwrite: false,
    credentialsOnly: true,
  });
  assert.equal(migrated.Database.Host, "localhost"); // host stays literal
  assert.equal(migrated.Database.Password, "${IOBEAM_ADMIN_CONFIG_DB_PASSWORD}");
  const values = store.readSecretsFile();
  assert.equal(values["IOBEAM_ADMIN_CONFIG_DB_HOST"], "live-host");
  assert.equal(values["IOBEAM_ADMIN_CONFIG_DB_PASSWORD"], "live-pass"); // not clobbered
  assert.equal(values["IOBEAM_ADMIN_CONFIG_DB_USER"], "old-user"); // gap filled
  const defaults = { Database: { Host: "localhost", User: "", Password: "", ConnectionString: "" } };
  assert.deepEqual(
    store.externalizeSecrets(defaults, store.ADMIN_SECRET_BINDINGS, { overwrite: false, credentialsOnly: true }),
    defaults,
  );
});

test("a value saved while running replaces the one loaded at start-up", () => {
  reset();
  store.writeSecrets({ IOBEAM_ADMIN_CONFIG_DB_PASSWORD: "old" });
  store.loadSecretsIntoEnv();
  assert.equal(store.expandPlaceholders("${IOBEAM_ADMIN_CONFIG_DB_PASSWORD}"), "old");
  store.externalizeSecrets({ Database: { Password: "new" } }, store.ADMIN_SECRET_BINDINGS);
  assert.equal(store.expandPlaceholders("${IOBEAM_ADMIN_CONFIG_DB_PASSWORD}"), "new");
});

test("curl receives FTP credentials through a private file, not argv", async () => {
  const { withCurlCredentials } = await import("../src/ftpUpload");
  let seenArgs: string[] = [];
  let seenFile = "";
  await withCurlCredentials({ username: "user", password: 'pa"ss\\word' }, async (args) => {
    seenArgs = args;
    seenFile = args[1];
    assert.equal(fs.statSync(seenFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(seenFile, "utf8"), 'user = "user:pa\\"ss\\\\word"\n');
  });
  assert.deepEqual(seenArgs[0], "--config");
  assert.ok(!seenArgs.join(" ").includes("pa\"ss"));
  assert.ok(!fs.existsSync(seenFile), "credential file is removed afterwards");
});

test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
