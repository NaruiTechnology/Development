import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPsql } from "../src/adminDbService";

test("psql exiting before reading SQL rejects without crashing the backend", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psql-pipe-"));
  const previousPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, "psql"),
      "#!/bin/sh\necho 'test authentication failure' >&2\nexit 2\n", { mode: 0o700 });
    process.env.PATH = `${dir}:${previousPath}`;
    await assert.rejects(runPsql([], "pipe_test", "x".repeat(8 * 1024 * 1024), {
      host: "pipe-test", port: 5432, database: "pipe_test", user: "test",
      password: null, sslMode: null, commandTimeoutMs: 5000,
    }), /test authentication failure/);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
