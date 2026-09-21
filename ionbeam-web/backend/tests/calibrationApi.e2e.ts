/**
 * End-to-end test of the calibration API: Express routes -> calibrationRepository -> psql -> real PostgreSQL.
 * Needs a database and `psql` on PATH; run it through IobeamAdmin/CalibrationCatalog/tests/test_backend_e2e.py, which starts a
 * throw-away PostgreSQL, points IOBEAM_ADMIN_CONFIG at it and executes this file with tsx.
 * Optional: CALIBRATION_DOCS_DIR = folder with icmd.TXT / md.TXT / UI1280reg.txt for the vendor-import checks.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";

import { config } from "../src/config";
import { registerCalibrationRoutes } from "../src/calibrationRoutes";
import { ConfigError, readAdminWithBackup } from "../src/configManager";
import { pgConnectionFromAdminConfig, pgConnectionFromRuntimeConfig } from "../src/adminDbService";

// Safety: never run against anything but the throw-away database the harness created.
assert.equal(process.env.CALIBRATION_E2E, "1", "run through test_backend_e2e.py");

const app = express();
app.use(express.json({ limit: "64mb" }));
registerCalibrationRoutes(app, {
  currentActor: async (req) => {
    const role = req.header("x-test-role");
    if (role === undefined) return null;
    return {
      id: role === "none" ? null : 1, login_name: "tester", first_name: "T", last_name: "T", email: "t@example.com",
      phone_number: "", company_name: "", site: "", role: Number(role === "none" ? 3 : role), is_active: true,
      session_lifetime_limit_days: 1,
    };
  },
  sendError: (res, err) => {
    if (err instanceof ConfigError) res.status(err.status).json({ ok: false, error: err.message });
    else res.status(500).json({ ok: false, error: String(err) });
  },
  roles: { superUser: 1, developer: 2, admin: 3 },
});
const server = http.createServer(app);

async function call(method: string, url: string, role: number | string | null, body?: unknown): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/admin/iobeam/calibration${url}`, {
    method,
    headers: { "content-type": "application/json", ...(role === null ? {} : { "x-test-role": String(role) }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = pgConnectionFromAdminConfig((await readAdminWithBackup()).data, pgConnectionFromRuntimeConfig());
  assert.ok(target.host.startsWith("/tmp/calibpg_"), `refusing to run against ${target.host}`);
  console.log(`database: ${target.host} / ${target.database}`);

  // ---- authentication ------------------------------------------------------------------------
  assert.equal((await call("GET", "/groups?equipment_type=FIB", null)).status, 401);
  assert.equal((await call("GET", "/groups?equipment_type=XYZ", 0)).status, 400);
  assert.equal((await call("GET", "/abc/FIB", 0)).status, 400);

  // ---- catalog (first call applies 003 and seeds 004 lazily) ----------------------------------
  const groups = await call("GET", "/groups?equipment_type=FIB&equipment_id=1", 0);
  assert.equal(groups.status, 200, groups.text.slice(0, 300));
  assert.ok(groups.json.groups.length > 20);
  assert.equal(groups.json.quality.definitions, 501);
  const sem = await call("GET", "/groups?equipment_type=SEM", 0);
  assert.equal(sem.json.quality.definitions, 1934);

  const bundle = await call("GET", "/1/FIB?keys=IONF_SUP_USED,IONI_LENS_TYPE", 0);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.json.profile, null);
  assert.deepEqual(bundle.json.definitions.map((d: any) => d.parameter_key).sort(), ["IONF_SUP_USED", "IONI_LENS_TYPE"]);
  assert.equal((await call("GET", "/999999/FIB", 0)).status, 404);

  // ---- writes: role / risk / validation / locking ---------------------------------------------
  const edit = { values: [{ parameter_key: "IONF_WD_DEF", value: 19 }], reason: "commissioning" };
  assert.equal((await call("PUT", "/1/FIB/values", 0, edit)).status, 403);                       // route guard: role 0
  const saved = await call("PUT", "/1/FIB/values", 1, edit);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.result.revision, 1);
  assert.equal(saved.json.profile.revision, 1);
  const svc = await call("PUT", "/1/FIB/values", 1, { values: [{ parameter_key: "IONI_LENS_TYPE", value: 1 }] });
  assert.equal(svc.status, 403); assert.equal(svc.json.code, "forbidden_role");                     // database rule: service needs role 2
  const undoc = await call("PUT", "/2/SEM/values", 2, { values: [{ parameter_key: "IMD_L6_GUN_BIAS_02", value: 5 }] });
  assert.equal(undoc.status, 409); assert.equal(undoc.json.code, "risk_ack_required");
  assert.equal((await call("PUT", "/2/SEM/values", 2, { values: [{ parameter_key: "IMD_L6_GUN_BIAS_02", value: 5 }], acknowledge_risk: true })).status, 200);
  const invalid = await call("PUT", "/1/FIB/values", 3, { values: [{ parameter_key: "IONI_LENS_TYPE", value: 42 }, { parameter_key: "NOPE", value: 1 }] });
  assert.equal(invalid.status, 422); assert.equal(invalid.json.errors.length, 2);
  const stale = await call("PUT", "/1/FIB/values", 1, { values: [{ parameter_key: "IONF_WD_DEF", value: 20 }], expected_revision: 0 });
  assert.equal(stale.status, 409); assert.equal(stale.json.code, "revision_conflict"); assert.equal(stale.json.current_revision, 1);
  assert.equal((await call("PUT", "/1/FIB/values", 1, { values: [] })).status, 400);

  // a JSON payload containing $ sequences must reach the database untouched (String.replace would expand "$&" / "$'")
  const dollars = await call("PUT", "/1/FIB/values", 1, { values: [{ parameter_key: "IONF_WD_DEF", value: 19, notes: "cost $& then $' and $$payload$$" }] });
  assert.equal(dollars.status, 200);
  assert.equal(dollars.json.values[0].notes, "cost $& then $' and $$payload$$");

  // ---- history / restore ---------------------------------------------------------------------
  await call("PUT", "/1/FIB/values", 1, { values: [{ parameter_key: "IONF_WD_DEF", value: 25 }], reason: "tweak" });
  const hist = await call("GET", "/1/FIB/history", 0);
  assert.deepEqual(hist.json.revisions.map((r: any) => r.revision), [2, 1]);
  assert.equal(hist.json.revisions[0].snapshot.IONF_WD_DEF, 25);
  const rev1 = await call("GET", "/1/FIB/history/1", 0);
  assert.equal(rev1.json.changes[0].parameter_key, "IONF_WD_DEF");
  const restored = await call("POST", "/1/FIB/restore", 1, { revision: 1 });
  assert.equal(restored.status, 200); assert.equal(restored.json.result.revision, 3);
  assert.equal((await call("GET", "/1/FIB?keys=IONF_WD_DEF", 0)).json.values[0].value, 19);
  assert.equal((await call("POST", "/1/FIB/restore", 1, { revision: 77 })).status, 404);

  // ---- tables ---------------------------------------------------------------------------------
  const table = await call("GET", "/1/FIB/tables/FIB_APERTURES", 0);
  assert.equal(table.status, 200); assert.equal(table.json.cells.length, 234); assert.equal(table.json.table.rows.length, 13);

  // ---- csv ------------------------------------------------------------------------------------
  const csv = await call("GET", "/1/FIB/export.csv?group_code=FIB.SRC", 0);
  assert.equal(csv.status, 200); assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(csv.text, /^parameter_key,vendor_name,category/);   // (fetch strips the BOM Excel needs) assert.ok(csv.text.split("\r\n").length > 20);

  // ---- admin catalog edit ---------------------------------------------------------------------
  const did = (await call("GET", "/2/SEM?keys=MD_I0045", 0)).json.definitions[0].id;
  assert.equal((await call("PATCH", `/definitions/${did}`, 2, { display_name: "x" })).status, 403);
  const patched = await call("PATCH", `/definitions/${did}`, 3, { display_name: "Spare 45 (named by service)", semantics_known: true });
  assert.equal(patched.status, 200); assert.equal(patched.json.definition.display_name, "Spare 45 (named by service)");
  assert.equal((await call("POST", "/catalog/reload", 3)).status, 200);                             // re-seed keeps the human edit
  assert.equal((await call("GET", "/2/SEM?keys=MD_I0045", 0)).json.definitions[0].display_name, "Spare 45 (named by service)");

  // ---- vendor import (real files) -------------------------------------------------------------
  const dir = process.env.CALIBRATION_DOCS_DIR;
  if (dir) {
    const read = (f: string) => fs.readFileSync(path.join(dir, f), "latin1");
    const icmd = read("icmd.TXT"), md = read("md.TXT"), reg = read("UI1280reg.txt");
    assert.equal((await call("POST", "/3/FIB/import", 1, { file_name: "icmd.TXT", content: icmd })).status, 403);
    const prev = await call("POST", "/3/FIB/import", 2, { file_name: "icmd.TXT", content: icmd });       // dry run by default
    assert.equal(prev.status, 200, prev.text.slice(0, 400));
    assert.equal(prev.json.format, "machine-data"); assert.equal(prev.json.dry_run, true);
    assert.equal(prev.json.matched, 413); assert.equal(prev.json.unmatched_count, 4); assert.equal(prev.json.warning_count, 1);
    assert.equal((await call("GET", "/3/FIB", 0)).json.profile, null);                                   // nothing written
    const noAck = await call("POST", "/3/FIB/import", 2, { file_name: "icmd.TXT", content: icmd, dry_run: false });
    assert.equal(noAck.status, 409); assert.equal(noAck.json.code, "risk_ack_required");
    const done = await call("POST", "/3/FIB/import", 2, { file_name: "icmd.TXT", content: icmd, dry_run: false, acknowledge_risk: true });
    assert.equal(done.status, 200); assert.equal(done.json.changed, 413); assert.equal(done.json.revision, 1);
    const wrong = await call("POST", "/4/SEM/import", 2, { file_name: "icmd.TXT", content: icmd });       // ion-column file into a SEM column
    assert.ok(wrong.json.rejected_count > 250 && wrong.json.matched < 30, JSON.stringify(wrong.json).slice(0, 300));
    const semPrev = await call("POST", "/4/SEM/import", 2, { file_name: "md.TXT", content: md });
    assert.equal(semPrev.json.matched, 1286); assert.equal(semPrev.json.rejected_count, 0);
    const regPrev = await call("POST", "/4/SEM/import", 2, { file_name: "UI1280reg.txt", content: reg });
    assert.equal(regPrev.json.format, "registry"); assert.equal(regPrev.json.matched, 648); assert.equal(regPrev.json.other_type_count, 88);
    assert.equal((await call("POST", "/4/SEM/import", 2, { file_name: "junk.txt", content: "hello\nworld\n" })).status, 422);
  }
  console.log("calibration API e2e: all checks passed");
}

main()
  .then(() => { server.close(); process.exit(0); })
  .catch((err) => { console.error(err); server.close(); process.exit(1); });
