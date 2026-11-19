import type express from "express";
import type { AdminUser } from "./adminDbRepository";
import { ConfigError } from "./configManager";
import { getPatternRecipeRecord, getPatternRecipeDefaults, listPatternRecipeAssignments, savePatternRecipeRecord } from "./patternRecipeRepository";

export interface PatternRecipeRouteDeps {
  currentActor(req: express.Request): Promise<AdminUser | null>;
  sendError(res: express.Response, error: unknown): void;
  patternKeys(): string[] | Promise<string[]>;
  list?: typeof listPatternRecipeAssignments;
  get?: typeof getPatternRecipeRecord;
  save?: typeof savePatternRecipeRecord;
}

export function registerPatternRecipeRoutes(app: express.Express, deps: PatternRecipeRouteDeps) {
  const base = "/api/admin/iobeam/pattern-recipes";
  const route = (write: boolean, handler: (req: express.Request, res: express.Response, actor: AdminUser) => Promise<void>): express.RequestHandler =>
    async (req, res) => {
      try {
        res.set("Cache-Control", "no-store");
        const actor = await deps.currentActor(req);
        if (!actor?.is_active) throw new ConfigError("Sign in to manage pattern recipes", 401);
        if (write && actor.role < 3) throw new ConfigError("Only Admin or Auditor accounts can edit pattern recipes", 403);
        await handler(req, res, actor);
      } catch (error) { deps.sendError(res, error); }
    };
  app.get("/api/admin/iobeam/pattern-recipe-defaults/:patternKey", route(false, async (req, res) => {
    res.json({ok: true, collections: await getPatternRecipeDefaults(req.params.patternKey)});
  }));
  app.get(base, route(false, async (_req, res) => {
    res.json({ ok: true, assignments: await (deps.list ?? listPatternRecipeAssignments)() });
  }));
  app.get(`${base}/:equipmentId/:patternKey`, route(false, async (req, res) => {
    res.json({ ok: true, recipe: await (deps.get ?? getPatternRecipeRecord)(Number(req.params.equipmentId), req.params.patternKey) });
  }));
  app.put(`${base}/:equipmentId/:patternKey`, route(true, async (req, res, actor) => {
    if (!actor.id) throw new ConfigError("A database account is required", 403);
    if (!(await deps.patternKeys()).includes(req.params.patternKey)) throw new ConfigError("Unknown pattern key", 400);
    const recipe = await (deps.save ?? savePatternRecipeRecord)(Number(req.params.equipmentId), req.params.patternKey,
      req.body?.collections, req.body?.expected_revision, actor.id);
    res.json({ ok: true, recipe });
  }));
}
