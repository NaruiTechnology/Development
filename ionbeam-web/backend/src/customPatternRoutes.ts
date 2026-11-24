import type express from "express";
import type { AdminUser } from "./adminDbRepository";
import { ConfigError } from "./configManager";
import {
  createCustomPattern,
  deleteCustomPattern,
  listCustomPatterns,
  updateCustomPattern,
  validateCustomPattern,
  validateCustomPatternId,
  type CustomPattern,
} from "./customPatternRepository";

export interface CustomPatternRouteDeps {
  currentActor(req: express.Request): Promise<AdminUser | null>;
  sendError(res: express.Response, error: unknown): void;
  list?: typeof listCustomPatterns;
  create?: typeof createCustomPattern;
  update?: typeof updateCustomPattern;
  remove?: typeof deleteCustomPattern;
}

const ROLE_SUPER_USER = 1;
const ROLE_ADMIN = 3;

export function registerCustomPatternRoutes(app: express.Express, deps: CustomPatternRouteDeps) {
  const base = "/api/admin/iobeam/custom-patterns";
  const route = (write: boolean, handler: (req: express.Request, res: express.Response, actor: AdminUser) => Promise<void>, minimumRole = ROLE_ADMIN): express.RequestHandler =>
    async (req, res) => {
      try {
        res.set("Cache-Control", "no-store");
        const actor = await deps.currentActor(req);
        if (!actor?.is_active) throw new ConfigError("Sign in to manage custom patterns.", 401);
        if (write && actor.role < minimumRole) throw new ConfigError(minimumRole === ROLE_SUPER_USER
          ? "Saving custom patterns requires SuperUser or higher access."
          : "Only Admin or Auditor accounts can manage custom patterns.", 403);
        await handler(req, res, actor);
      } catch (error) { deps.sendError(res, error); }
    };

  app.get(base, route(false, async (_req, res) => {
    res.json({ ok: true, patterns: await (deps.list ?? listCustomPatterns)() });
  }));
  app.post(base, route(true, async (req, res) => {
    const { name, payload } = validateCustomPattern(req.body?.name, req.body?.payload);
    const pattern = await (deps.create ?? createCustomPattern)(name, payload);
    res.status(201).json({ ok: true, pattern });
  }, ROLE_SUPER_USER));
  app.put(`${base}/:id`, route(true, async (req, res) => {
    const id = validateCustomPatternId(req.params.id);
    const { name, payload } = validateCustomPattern(req.body?.name, req.body?.payload);
    const pattern = await (deps.update ?? updateCustomPattern)(id, name, payload);
    res.json({ ok: true, pattern });
  }));
  app.delete(`${base}/:id`, route(true, async (req, res) => {
    await (deps.remove ?? deleteCustomPattern)(validateCustomPatternId(req.params.id));
    res.json({ ok: true });
  }));
}
