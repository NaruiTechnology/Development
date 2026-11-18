import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import type express from "express";
import type { AdminUser } from "../src/adminDbRepository";
import { ConfigError } from "../src/configManager";
import { registerPatternRecipeRoutes } from "../src/patternRecipeRoutes";
import { validateRecipeDocument } from "../src/patternRecipeRepository";

function harness(role: number | null) {
  const handlers = new Map<string, express.RequestHandler>();
  const calls: unknown[][] = [];
  const app = {
    get: (url: string, fn: express.RequestHandler) => handlers.set(`GET ${url}`, fn),
    put: (url: string, fn: express.RequestHandler) => handlers.set(`PUT ${url}`, fn),
  } as unknown as express.Express;
  registerPatternRecipeRoutes(app, {
    currentActor: async () => role === null ? null : ({id: 7, role, is_active: true} as AdminUser),
    sendError: (res, error) => res.status(error instanceof ConfigError ? error.status : 500).json({error: (error as Error).message}),
    patternKeys: () => ["stairCut"],
    list: async () => [{equipment_id: 1290, pattern_key: "stairCut", revision: 1, updated_at: "now"}],
    get: async () => null,
    save: async (...args) => {
      calls.push(args);
      throw new ConfigError("Recipes changed in another session. Reload before saving.", 409);
    },
  });
  async function request(method: string, path = "", body: unknown = undefined) {
    let status = 200; let data: unknown;
    const res = {set() {return this;}, status(value: number) {status = value; return this;}, json(value: unknown) {data = value; return this;}} as express.Response;
    const fn = handlers.get(`${method} /api/admin/iobeam/pattern-recipes${path}`)!;
    await fn({params: {equipmentId: "1290", patternKey: "stairCut"}, body} as express.Request, res, () => {});
    return {status, data};
  }
  return {request, calls};
}

test("recipe administration requires an active account; writes require Admin or Auditor", async () => {
  assert.equal((await harness(null).request("GET")).status, 401);
  assert.equal((await harness(1).request("GET")).status, 200);
  const user = harness(2);
  assert.equal((await user.request("PUT", "/:equipmentId/:patternKey", {})).status, 403);
  assert.equal(user.calls.length, 0);
  for (const role of [3, 4]) {
    const admin = harness(role);
    const response = await admin.request("PUT", "/:equipmentId/:patternKey", {collections: [], expected_revision: 8});
    assert.equal(response.status, 409);
    assert.deepEqual(admin.calls[0], [1290, "stairCut", [], 8, 7]);
  }
});

test("unassigned equipment/pattern returns an explicit empty record for creation", async () => {
  const result = await harness(1).request("GET", "/:equipmentId/:patternKey");
  assert.deepEqual(result, {status: 200, data: {ok: true, recipe: null}});
});

test("editing preserves per-step overrides and rejects the whole invalid document", () => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../GlasgowDataIO/Json/stepReceipes.json"), "utf8"));
  raw[0].SMProcess.nodes[0].steps[0].dwellUS = 7;
  const result = validateRecipeDocument("stairCut", raw);
  assert.equal(result[0].SMProcess.nodes[0].steps[0].dwellUS, 7);
  assert.equal(result[0].SMProcess.nodes[0].steps[1].dwellUS, 1);
  for (const dwell of [0.01, 8193]) {
    raw[0].SMProcess.nodes[0].steps[0].dwellUS = dwell;
    assert.throws(() => validateRecipeDocument("stairCut", raw), (error: unknown) => error instanceof ConfigError && error.status === 422);
  }
  raw[0].SMProcess.nodes[0].steps[0].dwellUS = 1;
  raw[0].SMProcess.nodes[0].steps[0].passes = 1.2;
  assert.throws(() => validateRecipeDocument("stairCut", raw), (error: unknown) => error instanceof ConfigError && error.status === 422);
  assert.throws(() => validateRecipeDocument("stairCut", []));
});
