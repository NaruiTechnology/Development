import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { runPsql, type PgConnection } from "../src/adminDbService";

function connection(host: string, sslMode = "disable"): PgConnection {
  return { host, port: 5432, database: "admin", user: "runtime", password: "test-only",
    sslMode, commandTimeoutMs: 1000 };
}

test("SQL scripts preserve raw JSON and numeric text across multiple results without psql", async (t) => {
  let ended = false;
  t.mock.method(Client.prototype, "connect", async () => undefined);
  t.mock.method(Client.prototype, "end", async () => { ended = true; });
  t.mock.method(Client.prototype, "query", async function (options: any) {
    assert.equal(options.text, "SET search_path TO public; SELECT payload;");
    assert.equal(options.rowMode, "array");
    assert.equal(options.types.getTypeParser(114)('{"id":9007199254740993}'), '{"id":9007199254740993}');
    return [{ rows: [] }, { rows: [['{"id":9007199254740993}', null, "t"]] }];
  });
  assert.equal(await runPsql(["-Atq", "-v", "ON_ERROR_STOP=1"], "admin",
    "SET search_path TO public; SELECT payload;", connection("raw-output")),
    '{"id":9007199254740993}\t\tt\n');
  assert.equal(ended, true);
});

test("command SQL uses the requested database and closes on query failure", async (t) => {
  let ended = false;
  t.mock.method(Client.prototype, "connect", async function (this: Client) {
    assert.equal((this as any).database, "postgres");
  });
  t.mock.method(Client.prototype, "end", async () => { ended = true; });
  t.mock.method(Client.prototype, "query", async (options: any) => {
    assert.equal(options.text, "SELECT 1;");
    throw new Error("permission denied for table activity");
  });
  await assert.rejects(runPsql(["-Atqc", "SELECT 1;"], "postgres", undefined,
    connection("query-failure")), /permission denied/);
  assert.equal(ended, true);
});

test("prefer retries without TLS only when the server does not support TLS", async (t) => {
  const modes: unknown[] = [];
  t.mock.method(Client.prototype, "connect", async function (this: any) {
    modes.push(this.ssl);
    if (this.ssl) throw new Error("The server does not support SSL connections");
  });
  t.mock.method(Client.prototype, "end", async () => undefined);
  t.mock.method(Client.prototype, "query", async () => ({ rows: [["1"]] }));
  assert.equal(await runPsql(["-Atqc", "SELECT 1;"], "admin", undefined,
    connection("prefer-retry", "prefer")), "1\n");
  assert.deepEqual(modes, [{ rejectUnauthorized: false }, false]);
});

test("require never falls back to an unencrypted connection", async (t) => {
  let attempts = 0;
  t.mock.method(Client.prototype, "connect", async () => {
    attempts++;
    throw new Error("The server does not support SSL connections");
  });
  t.mock.method(Client.prototype, "end", async () => undefined);
  await assert.rejects(runPsql(["-Atqc", "SELECT 1;"], "admin", undefined,
    connection("require-no-retry", "require")), /does not support SSL/);
  assert.equal(attempts, 1);
});

test("connection failures back off", async (t) => {
  let attempts = 0;
  t.mock.method(Client.prototype, "connect", async () => {
    attempts++;
    throw new Error("connect ECONNREFUSED");
  });
  t.mock.method(Client.prototype, "end", async () => undefined);
  const target = connection("connect-backoff");
  await assert.rejects(runPsql([], "admin", "SELECT 1;", target), /ECONNREFUSED/);
  await assert.rejects(runPsql([], "admin", "SELECT 1;", target), /temporarily unavailable/);
  assert.equal(attempts, 1);
});

test("a timed out query closes its connection and rejects", async (t) => {
  let ended = false;
  t.mock.method(Client.prototype, "connect", async () => undefined);
  t.mock.method(Client.prototype, "end", async () => { ended = true; });
  t.mock.method(Client.prototype, "query", () => new Promise(() => undefined));
  await assert.rejects(runPsql([], "admin", "SELECT 1;",
    { ...connection("query-timeout"), commandTimeoutMs: 20 }), /timed out after 20ms/);
  assert.equal(ended, true);
});

test("authentication failures do not suppress a retry", async (t) => {
  let attempts = 0;
  t.mock.method(Client.prototype, "connect", async () => {
    attempts++;
    throw new Error("password authentication failed for user runtime");
  });
  t.mock.method(Client.prototype, "end", async () => undefined);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(runPsql([], "admin", "SELECT 1;", connection("auth-retry")),
      /password authentication failed/);
  }
  assert.equal(attempts, 2);
});
