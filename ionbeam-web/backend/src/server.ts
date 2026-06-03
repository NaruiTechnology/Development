/**
 * Entry point for the Node proxy / static server.
 *
 *   /api/*        -> REST proxy onto FastAPI glasgow_service
 *   /ws/scan/...  -> WebSocket proxy (handled by attachWsProxy via http upgrade)
 *   /             -> serves frontend/dist when STATIC_DIR exists
 *
 * In MOCK=1 mode the REST handler short-circuits before the proxy and
 * returns synthetic ScanResult / status / defaults values that match the
 * Pydantic schemas the FastAPI service emits.
 */
import express from "express";
import morgan from "morgan";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import os from "node:os";
import { URL } from "node:url";
import type { IncomingMessage } from "node:http";

import { config } from "./config";
import { buildRestProxy } from "./restProxy";
import { attachWsProxy } from "./wsProxy";
import { mockRest } from "./mockHardware";
import {
  ConfigError,
  type RestartResult,
  readAdminWithBackup,
  readWithBackup,
  restartService,
  restoreAdminFromBackup,
  restoreFromBackup,
  writeAdminConfig,
  writeConfig,
} from "./configManager";

const app = express();
let server: http.Server;

interface BackendRestartResult {
  ok: boolean;
  scheduled: boolean;
  mode: "disabled" | "exit" | "command";
  command?: string;
  error?: string;
}

interface RestartServicesResponse {
  ok: boolean;
  restart: RestartResult;
  backend_restart: BackendRestartResult;
}

interface ConfigSaveResponse {
  ok: boolean;
  error?: string;
}

interface AdminUser {
  id: number | null;
  login_name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  company_name: string;
  site: string;
  role: number;
  is_active: boolean;
  session_lifetime_limit_days: number;
}

type ScanAuthRequest = express.Request | IncomingMessage;

interface Equipment {
  id: number | null;
  name: string;
  model: string;
  serial_number: string;
  site: string;
  description: string;
}

interface SmsChallenge {
  code: string;
  user: AdminUser;
  expiresAt: number;
}

interface RegisterAdminUserRequest {
  login_name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  email?: unknown;
  phone_number?: unknown;
  company_name?: unknown;
  site?: unknown;
}

type SmsSendResult =
  | { ok: true; mode: "twilio" }
  | { ok: true; mode: "mock"; code: string }
  | { ok: false; error: string };

interface DbStatusResponse {
  ok: boolean;
  enabled: boolean;
  error?: string;
}

const smsChallenges = new Map<string, SmsChallenge>();
const SMS_CODE_TTL_MS = 5 * 60 * 1000;
const ROLE_USER = 0;
const ROLE_SUPER_USER = 1;
const ROLE_DEVELOPER = 2;
const ROLE_ADMIN = 3;
const ROLE_AUDIT = 4;
const SITE_OPTIONS = [
  "Beijing(北京)",
  "Shanghai(上海)",
  "Shenzheng(深圳)",
  "Wexi(无锡)",
  "Xian(西安)",
  "Chengdu(成都)",
  "Hangzhou(杭州)",
  "Tianjing(天津)",
  "Taixin(泰兴)",
] as const;
const DEFAULT_SITE = SITE_OPTIONS[0];

app.use(morgan("dev"));
app.use(express.json({ limit: "256mb" })); // scan DB flow may post large CSV/PNG blobs

// Health endpoint for ops / load balancers.
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    mock: config.mock,
    upstream: config.proxyTargetHttp,
    has_token: Boolean(config.glasgowToken),
    config_path: config.configPath,
    admin_config_path: config.adminConfigPath,
    restart_cmd: config.restartCmd,
    backend_restart_enabled: config.restartBackendAfterGlasgow,
    backend_restart_cmd: config.backendRestartCmd,
  });
});

app.get("/api/admin/config", async (_req, res) => {
  try {
    const info = await readWithBackup();
    res.json(info);
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/config", async (req, res) => {
  const data =
    req.body && typeof req.body === "object" && "data" in req.body
      ? (req.body as { data: unknown }).data
      : req.body;

  if (data === undefined || data === null) {
    res.status(400).json({
      ok: false,
      error: "missing JSON body: expected { data: <streamData> }",
    });
    return;
  }

  try {
    await writeConfig(data);
  } catch (err) {
    sendConfigError(res, err);
    return;
  }

  await restartServicesAndRespond(res);
});

app.post("/api/admin/config/restore", async (_req, res) => {
  try {
    await restoreFromBackup();
  } catch (err) {
    sendConfigError(res, err);
    return;
  }

  await restartServicesAndRespond(res);
});

app.get("/api/admin/iobeam/config", async (_req, res) => {
  try {
    const info = await readAdminWithBackup();
    res.json(info);
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post(
  "/api/admin/iobeam/config",
  async (req, res: express.Response<ConfigSaveResponse>) => {
    const data =
      req.body && typeof req.body === "object" && "data" in req.body
        ? (req.body as { data: unknown }).data
        : req.body;

    if (data === undefined || data === null) {
      res.status(400).json({
        ok: false,
        error: "missing JSON body: expected { data: <adminConfig> }",
      });
      return;
    }

    try {
      await authorizeAdminConfigSave(data);
      await syncAdminUsersToDb(data);
      await syncEquipmentToDb(data);
      await writeAdminConfig(data);
    } catch (err) {
      sendConfigError(res, err);
      return;
    }

    res.json({ ok: true });
  },
);

app.get("/api/admin/iobeam/equipment", async (_req, res) => {
  try {
    const equipment = await listEquipmentFromDb();
    res.json({ ok: true, equipment });
  } catch (err) {
    try {
      const info = await readAdminWithBackup();
      res.json({ ok: true, equipment: readEquipment(info.data) });
    } catch {
      sendConfigError(res, err);
    }
  }
});

app.post(
  "/api/admin/iobeam/config/restore",
  async (_req, res: express.Response<ConfigSaveResponse>) => {
    try {
      await restoreAdminFromBackup();
    } catch (err) {
      sendConfigError(res, err);
      return;
    }

    res.json({ ok: true });
  },
);

app.get("/api/admin/iobeam/auth/current-account", async (_req, res) => {
  const login = currentLoginName();
  try {
    const info = await readAdminWithBackup();
    const configUser = findAdminUser(info.data, login);
    const dbUser = configUser ? null : await findAdminUserInDb(login).catch(() => null);
    const user = configUser ?? dbUser;
    const sessionExpired = user ? await isAdminSessionExpired(user) : false;
    res.json({
      ok: true,
      login,
      registered: Boolean(user),
      session_expired: sessionExpired,
      user: user && !sessionExpired ? publicAdminUser(user) : null,
    });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/iobeam/auth/register", async (req, res) => {
  const body = (req.body ?? {}) as RegisterAdminUserRequest;
  const loginName = String(body.login_name ?? "").trim();
  const firstName = String(body.first_name ?? "").trim();
  const lastName = String(body.last_name ?? "").trim();
  const email = String(body.email ?? "").trim();
  const phoneNumber = String(body.phone_number ?? "").trim();
  const companyName = String(body.company_name ?? "").trim();
  const site = normalizeSite(body.site);

  if (!loginName) {
    res.status(400).json({ ok: false, error: "login name is required" });
    return;
  }
  if (!firstName || !lastName) {
    res.status(400).json({ ok: false, error: "first name and last name are required" });
    return;
  }
  if (!email) {
    res.status(400).json({ ok: false, error: "email is required" });
    return;
  }
  if (!phoneNumber) {
    res.status(400).json({ ok: false, error: "phone number is required" });
    return;
  }

  try {
    const info = await readAdminWithBackup();
    if (findAdminUser(info.data, loginName)) {
      res.status(409).json({ ok: false, error: "account is already registered" });
      return;
    }

    const currentUsers = readAdminUsers(info.data);
    if (currentUsers.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
      res.status(409).json({ ok: false, error: "email is already registered" });
      return;
    }
    const dbConflict = await findAdminUserInDb(loginName).catch(() => null);
    const dbEmailConflict = await findAdminUserInDb(email).catch(() => null);
    if (dbConflict || dbEmailConflict) {
      res.status(409).json({ ok: false, error: "account or email is already registered in DB" });
      return;
    }

    const user: AdminUser = {
      id: nextAdminUserId(currentUsers),
      login_name: loginName,
      first_name: firstName,
      last_name: lastName,
      email,
      phone_number: phoneNumber,
      company_name: companyName,
      site,
      role: 0,
      is_active: true,
      session_lifetime_limit_days: 1,
    };

    const data = addAdminUser(info.data, user);
    await writeAdminConfig(data);
    await upsertAdminUserInDb(user).catch((err) => {
      console.warn(
        `[iobeam-admin/auth] DB user record was not created: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    res.json({ ok: true, user: publicAdminUser(user) });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/iobeam/auth/send-sms", async (req, res) => {
  const login = String((req.body as { login?: unknown } | null)?.login ?? "").trim();
  if (!login) {
    res.status(400).json({ ok: false, error: "login is required" });
    return;
  }

  try {
    const info = await readAdminWithBackup();
    let user = findAdminUser(info.data, login);
    const dbUser = await findAdminUserInDb(login).catch(() => null);
    if (dbUser && user && dbUser.email.toLowerCase() !== user.email.toLowerCase()) {
      res.status(409).json({ ok: false, error: "account email does not match the DB record" });
      return;
    }
    user = dbUser ?? user;
    if (!user) {
      res.status(404).json({ ok: false, error: "account not found" });
      return;
    }
    if (!user.is_active) {
      res.status(403).json({ ok: false, error: "account is inactive" });
      return;
    }
    if (!user.phone_number.trim()) {
      res.status(400).json({ ok: false, error: "account has no phone number" });
      return;
    }

    const code = crypto.randomInt(100000, 999999).toString();
    const challengeId = crypto.randomUUID();
    smsChallenges.set(challengeId, {
      code,
      user,
      expiresAt: Date.now() + SMS_CODE_TTL_MS,
    });

    const sms = await sendSmsVerification(user.phone_number, code);
    if (!sms.ok) {
      smsChallenges.delete(challengeId);
      res.status(503).json({ ok: false, error: sms.error });
      return;
    }

    res.json({
      ok: true,
      challenge_id: challengeId,
      phone_number: maskPhone(user.phone_number),
      mock: sms.mode === "mock",
      ...(sms.mode === "mock" ? { dev_code: sms.code } : {}),
    });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/iobeam/auth/verify-sms", async (req, res) => {
  const body = req.body as { challenge_id?: unknown; code?: unknown; site?: unknown } | null;
  const challengeId = String(body?.challenge_id ?? "").trim();
  const code = String(body?.code ?? "").trim();
  const challenge = smsChallenges.get(challengeId);

  if (!challenge) {
    res.status(400).json({ ok: false, error: "verification challenge not found" });
    return;
  }
  if (Date.now() > challenge.expiresAt) {
    smsChallenges.delete(challengeId);
    res.status(410).json({ ok: false, error: "verification code expired" });
    return;
  }
  if (code !== challenge.code) {
    res.status(401).json({ ok: false, error: "verification code is invalid" });
    return;
  }

  smsChallenges.delete(challengeId);
  try {
    await recordAdminSession(req, challenge.user, normalizeSite(body?.site ?? challenge.user.site));
  } catch (err) {
    console.warn(
      `[iobeam-admin/auth] sign-in session was not recorded: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  res.json({
    ok: true,
    user: publicAdminUserWithSession(challenge.user),
  });
});

app.get(
  "/api/admin/iobeam/db/status",
  async (_req, res: express.Response<DbStatusResponse>) => {
    try {
      await runPsql(["-Atqc", "SELECT 1;"], "postgres");
      res.json({ ok: true, enabled: true });
    } catch (err) {
      res.json({
        ok: false,
        enabled: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

app.get("/api/admin/iobeam/reports/activity", async (req, res) => {
  try {
    const info = await readAdminWithBackup();
    const activeUsers = readAdminUsers(info.data).filter((u) => u.is_active);
    const requestedAccountId = Number(req.query.account_id ?? 0);
    const requestedEquipmentId = Number(req.query.equipment_id ?? 0);
    const days = Math.min(
      365,
      Math.max(1, Math.trunc(Number(req.query.days ?? 90) || 90)),
    );
    const reportUsers =
      Number.isInteger(requestedAccountId) && requestedAccountId > 0
        ? activeUsers.filter((u) => u.id === requestedAccountId)
        : activeUsers;
    const ids = reportUsers
      .map((u) => u.id)
      .filter((id): id is number => Number.isInteger(id) && (id ?? 0) > 0);

    const accounts = activeUsers.map((u) => ({
      id: u.id,
      login_name: u.login_name,
      name: `${u.first_name} ${u.last_name}`.trim() || u.login_name,
      company_name: u.company_name,
      site: u.site,
      role: u.role,
    }));

    if (ids.length === 0) {
      res.json({
        ok: true,
        generated_at: new Date().toISOString(),
        days,
        selected_account_id: requestedAccountId > 0 ? requestedAccountId : null,
        selected_equipment_id: requestedEquipmentId > 0 ? requestedEquipmentId : null,
        accounts,
        totals: [],
        daily: [],
        weekly: [],
        monthly: [],
        yearly: [],
        site_groups: [],
        equipment_groups: [],
        geography: [],
        recent: [],
      });
      return;
    }

    const out = await runPsql(
      ["-Atq"],
      config.adminDbName,
      buildActivityReportCompatibilitySql(
        ids,
        days,
        Number.isInteger(requestedEquipmentId) && requestedEquipmentId > 0
          ? requestedEquipmentId
          : null,
      ),
    );
    const rawReport = JSON.parse(out.trim() || "{}") as unknown;
    const report =
      rawReport && typeof rawReport === "object"
        ? (rawReport as Record<string, unknown>)
        : {};
    res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      days,
      selected_account_id: requestedAccountId > 0 ? requestedAccountId : null,
      selected_equipment_id: requestedEquipmentId > 0 ? requestedEquipmentId : null,
      accounts,
      totals: Array.isArray(report.totals) ? report.totals : [],
      daily: Array.isArray(report.daily) ? report.daily : [],
      weekly: Array.isArray(report.weekly) ? report.weekly : [],
      monthly: Array.isArray(report.monthly) ? report.monthly : [],
      yearly: Array.isArray(report.yearly) ? report.yearly : [],
      site_groups: Array.isArray(report.site_groups) ? report.site_groups : [],
      equipment_groups: Array.isArray(report.equipment_groups) ? report.equipment_groups : [],
      geography: Array.isArray(report.geography) ? report.geography : [],
      recent: Array.isArray(report.recent) ? report.recent : [],
    });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/iobeam/activity", async (req, res) => {
  const body = req.body as {
    user_id?: unknown;
    equipment_id?: unknown;
    activity_type?: unknown;
  } | null;
  const userId = Number(body?.user_id ?? 1);
  const equipmentId = Number(body?.equipment_id ?? 0);
  const activityType = String(body?.activity_type ?? "scan_result").slice(0, 150);

  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ ok: false, error: "user_id must be a positive integer" });
    return;
  }
  if (body?.equipment_id !== undefined && (!Number.isInteger(equipmentId) || equipmentId <= 0)) {
    res.status(400).json({ ok: false, error: "equipment_id must be a positive integer" });
    return;
  }

  try {
    const info = await readAdminWithBackup();
    const user = findAdminUserById(info.data, userId);
    const lifetimeDays = user?.session_lifetime_limit_days ?? 1;
    await ensureAdminEquipmentSchema();
    const sql = `
      SET search_path TO iobeam_admin, public;
      ALTER TABLE activity
        DROP COLUMN IF EXISTS data_file,
        DROP COLUMN IF EXISTS image_file,
        DROP COLUMN IF EXISTS data_file_name,
        DROP COLUMN IF EXISTS image_file_name,
        ADD COLUMN IF NOT EXISTS equipment_id integer,
        ADD COLUMN IF NOT EXISTS session_lifetime_limit_days integer NOT NULL DEFAULT 1,
        ALTER COLUMN last_signed_in SET DEFAULT CURRENT_TIMESTAMP;
      UPDATE activity
         SET last_signed_in = CURRENT_TIMESTAMP
       WHERE last_signed_in IS NULL;
      UPDATE activity
         SET equipment_id = (SELECT id FROM Equipment ORDER BY id LIMIT 1)
       WHERE equipment_id IS NULL;
      ALTER TABLE activity
        ALTER COLUMN last_signed_in SET NOT NULL,
        ALTER COLUMN session_lifetime_limit_days SET DEFAULT 1;
      INSERT INTO activity (
        user_id, equipment_id, activity_type, date, last_signed_in, session_lifetime_limit_days
      )
      VALUES (
        ${userId},
        COALESCE(
          (SELECT id FROM Equipment WHERE id = ${equipmentId > 0 ? equipmentId : "NULL"} LIMIT 1),
          (SELECT id FROM Equipment ORDER BY id LIMIT 1)
        ),
        ${sqlString(activityType)},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        ${Math.max(1, Math.trunc(lifetimeDays))}
      );
    `;
    await runPsql(["-v", "ON_ERROR_STOP=1"], config.adminDbName, sql);
    res.json({ ok: true });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/restart-services", async (_req, res) => {
  await restartServicesAndRespond(res);
});

app.use("/api/scan/raster/run", requireScanPrivilege);
app.use("/api/scan/vector/run", requireScanPrivilege);

// MOCK responses live BEFORE the proxy mount so they win.
if (config.mock) {
  app.get("/api/status", (_req, res) => res.json(mockRest.status()));
  app.get("/api/defaults", (_req, res) => res.json(mockRest.defaults()));
  app.post("/api/scan/raster/run", (req, res) => res.json(mockRest.runRaster(req.body)));
  app.post("/api/scan/vector/run", (req, res) => res.json(mockRest.runVector(req.body)));

  // Last-scan downloads. The CSV is generated synthetically in-process;
  // the figure endpoint returns 501 because matplotlib only runs on the
  // Python side, and pulling in a Node image-rendering lib just for the
  // demo path would bloat the proxy. The real backend always serves
  // figures regardless of MOCK on the Node side.
  app.get("/api/scan/last/meta", (_req, res) => res.json(mockRest.lastMeta()));
  app.get("/api/scan/last/csv", (_req, res) => {
    const out = mockRest.lastCsv();
    if (!out) {
      res.status(404).json({ detail: "no scan data cached" });
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.send(out.body);
  });
  app.get("/api/scan/last/figure", (_req, res) => {
    res.status(501).json({
      detail:
        "figure rendering is not available in MOCK=1 mode (matplotlib runs on the Python service only)",
    });
  });
} else {
  app.use("/api", buildRestProxy());
}

// Static (production) — only mount if the build output actually exists, so
// `npm run dev` doesn't 404 itself.
if (fs.existsSync(config.staticDir)) {
  app.use(express.static(config.staticDir));
  app.get("*", (_req, res, next) => {
    const indexHtml = path.join(config.staticDir, "index.html");
    if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
    else next();
  });
}

server = http.createServer(app);
attachWsProxy(server, authorizeScanUpgrade);

server.listen(config.port, () => {
  console.log(
    `[ionbeam-web/backend] listening on :${config.port}\n` +
      `  mock     = ${config.mock}\n` +
      `  upstream = ${config.proxyTargetHttp}\n` +
      `  ws       = ${config.proxyTargetWs}\n` +
      `  token    = ${config.glasgowToken ? "set" : "(none)"}\n` +
      `  config   = ${config.configPath}\n` +
      `  admin config = ${config.adminConfigPath}\n` +
      `  restart  = ${config.restartCmd}\n` +
      `  backend restart = ${
        config.restartBackendAfterGlasgow
          ? config.backendRestartCmd ?? "exit"
          : "disabled"
      }\n` +
      `  static   = ${fs.existsSync(config.staticDir) ? config.staticDir : "(not built yet)"}`
  );
});

function planBackendRestart(glasgowRestartOk: boolean): BackendRestartResult {
  if (!glasgowRestartOk) {
    return {
      ok: true,
      scheduled: false,
      mode: "disabled",
      error: "skipped because Glasgow service restart failed",
    };
  }
  if (!config.restartBackendAfterGlasgow) {
    return { ok: true, scheduled: false, mode: "disabled" };
  }
  if (config.backendRestartCmd) {
    return {
      ok: true,
      scheduled: true,
      mode: "command",
      command: config.backendRestartCmd,
    };
  }
  return { ok: true, scheduled: true, mode: "exit" };
}

function readAdminUsers(data: unknown): AdminUser[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const rawUsers = Array.isArray(record.users)
    ? record.users
    : record.user && typeof record.user === "object"
      ? [record.user]
      : [];

  return rawUsers
    .filter((u): u is Record<string, unknown> => Boolean(u) && typeof u === "object")
    .map((u) => ({
      id: typeof u.id === "number" ? u.id : null,
      login_name: String(u.login_name ?? ""),
      first_name: String(u.first_name ?? ""),
      last_name: String(u.last_name ?? ""),
      email: String(u.email ?? ""),
      phone_number: String(u.phone_number ?? ""),
      company_name: String(u.company_name ?? ""),
      site: normalizeSite(u.site ?? u.geography ?? u.geo ?? u.geo_site),
      role: typeof u.role === "number" ? u.role : Number(u.role ?? 0),
      is_active: typeof u.is_active === "boolean" ? u.is_active : true,
      session_lifetime_limit_days: normalizeSessionLifetimeDays(
        u.session_lifetime_limit_days,
      ),
    }));
}

function readEquipment(data: unknown): Equipment[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const rawEquipment = Array.isArray(record.equipments)
    ? record.equipments
    : Array.isArray(record.equipment)
      ? record.equipment
      : record.equipment && typeof record.equipment === "object"
        ? [record.equipment]
        : [];

  return rawEquipment
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row, index) => ({
      id: typeof row.id === "number" ? row.id : index + 1,
      name: String(row.name ?? ""),
      model: String(row.model ?? ""),
      serial_number: String(row.serial_number ?? ""),
      site: String(row.site ?? ""),
      description: String(row.description ?? ""),
    }))
    .filter((row) => row.name.trim() || row.serial_number.trim());
}

function findAdminUser(data: unknown, login: string): AdminUser | null {
  const normalized = login.toLowerCase();
  return (
    readAdminUsers(data).find(
      (u) =>
        u.login_name.toLowerCase() === normalized ||
        u.email.toLowerCase() === normalized
    ) ?? null
  );
}

function findAdminUserById(data: unknown, id: number): AdminUser | null {
  return readAdminUsers(data).find((u) => u.id === id) ?? null;
}

function addAdminUser(data: unknown, user: AdminUser): unknown {
  const root =
    data && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>) }
      : {};
  const users = readAdminUsers(root);
  const nextUsers = [...users, user];
  return {
    ...root,
    user: nextUsers[0] ?? user,
    users: nextUsers,
  };
}

function nextAdminUserId(users: AdminUser[]): number {
  return users.reduce((max, user) => Math.max(max, user.id ?? 0), 0) + 1;
}

function publicAdminUser(user: AdminUser) {
  return {
    id: user.id,
    login_name: user.login_name,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    site: user.site,
    role: user.role,
    is_active: user.is_active,
    session_lifetime_limit_days: user.session_lifetime_limit_days,
    initials: `${user.first_name.charAt(0)}${user.last_name.charAt(0)}`.toUpperCase(),
  };
}

function readAuditorEmails(data: unknown): Set<string> {
  if (!data || typeof data !== "object") return new Set();
  const record = data as Record<string, unknown>;
  const rawAuditors = Array.isArray(record.auditors)
    ? record.auditors
    : record.auditor && typeof record.auditor === "object"
      ? [record.auditor]
      : [];

  return new Set(
    rawAuditors
      .filter((u): u is Record<string, unknown> => Boolean(u) && typeof u === "object")
      .filter((u) => (typeof u.is_active === "boolean" ? u.is_active : true))
      .map((u) => String(u.email ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
}

async function currentAdminActor(req?: ScanAuthRequest): Promise<AdminUser | null> {
  const info = await readAdminWithBackup();
  const sessionLogin = verifyAdminSessionToken(readScanAuthToken(req));
  const login = sessionLogin || currentLoginName();
  const configUser = findAdminUser(info.data, login);
  const dbUser = await findAdminUserInDb(login).catch(() => null);
  if (configUser && dbUser) {
    return {
      ...dbUser,
      email: configUser.email || dbUser.email,
      role: Math.max(configUser.role, dbUser.role),
      is_active: configUser.is_active && dbUser.is_active,
    };
  }
  return dbUser ?? configUser;
}

async function currentActorIsAuditor(actor: AdminUser, data?: unknown): Promise<boolean> {
  const email = actor.email.trim().toLowerCase();
  if (!email) return false;
  if (data !== undefined && readAuditorEmails(data).has(email)) return true;
  return isAuditorEmailInDb(email).catch(() => false);
}

async function authorizeAdminConfigSave(nextData: unknown): Promise<void> {
  const actor = await currentAdminActor();
  if (!actor || !actor.is_active) {
    const err = new ConfigError("current account is not authorized to edit admin configuration", 403);
    throw err;
  }

  const info = await readAdminWithBackup();
  const beforeUsers = new Map(
    readAdminUsers(info.data)
      .filter((u) => Number.isInteger(u.id))
      .map((u) => [u.id, u] as const),
  );
  const afterUsers = readAdminUsers(nextData);
  const changedRoleUsers = afterUsers.filter((after) => {
    const before = beforeUsers.get(after.id);
    return !before || before.role !== after.role;
  });
  if (changedRoleUsers.length === 0) return;

  const actorIsAuditor = actor.role >= ROLE_AUDIT && await currentActorIsAuditor(actor, nextData);
  if (changedRoleUsers.some((u) => u.role >= ROLE_ADMIN) && !actorIsAuditor) {
    throw new ConfigError("only active Auditor accounts can assign the Admin or Audit role", 403);
  }
  if (actor.role < ROLE_ADMIN) {
    throw new ConfigError("only Admin or Auditor accounts can assign account roles", 403);
  }
  if (!actorIsAuditor && changedRoleUsers.some((u) => u.role >= ROLE_ADMIN)) {
    throw new ConfigError("Admin accounts can assign only lower-privilege roles", 403);
  }
}

async function requireScanPrivilege(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active || actor.role < ROLE_SUPER_USER) {
      res.status(403).json({
        ok: false,
        error: "RUSTER/VECTOR scan requires SuperUser, Admin, or Auditor privilege",
      });
      return;
    }
    next();
  } catch (err) {
    sendConfigError(res, err);
  }
}

async function authorizeScanUpgrade(req: IncomingMessage): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active || actor.role < ROLE_SUPER_USER) {
      return {
        ok: false,
        status: 403,
        message: "RUSTER/VECTOR scan requires SuperUser, Admin, or Auditor privilege",
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeSessionLifetimeDays(value: unknown): number {
  const days = typeof value === "number" ? value : Number(value ?? 1);
  if (!Number.isFinite(days)) return 1;
  return Math.max(1, Math.trunc(days));
}

function normalizeSite(value: unknown): string {
  const site = String(value ?? "").trim();
  return SITE_OPTIONS.includes(site as (typeof SITE_OPTIONS)[number])
    ? site
    : DEFAULT_SITE;
}

function currentLoginName(): string {
  return (
    process.env.SUDO_USER?.trim() ||
    process.env.LOGNAME?.trim() ||
    process.env.USER?.trim() ||
    process.env.USERNAME?.trim() ||
    os.userInfo().username ||
    ""
  );
}

function publicAdminUserWithSession(user: AdminUser) {
  return {
    ...publicAdminUser(user),
    session_token: createAdminSessionToken(user),
  };
}

function readScanAuthToken(req?: ScanAuthRequest): string {
  if (!req) return "";
  const header = req.headers["x-iobeam-auth"];
  if (Array.isArray(header)) return header[0] ?? "";
  if (typeof header === "string") return header.trim();
  if (!req.url) return "";
  try {
    return new URL(req.url, "http://localhost").searchParams.get("auth")?.trim() ?? "";
  } catch {
    return "";
  }
}

function createAdminSessionToken(user: AdminUser): string {
  const lifetimeDays = normalizeSessionLifetimeDays(user.session_lifetime_limit_days);
  const payload = {
    login: user.login_name,
    exp: Date.now() + lifetimeDays * 24 * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signAdminSessionPayload(encoded)}`;
}

function verifyAdminSessionToken(token: string): string | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = signAdminSessionPayload(encoded);
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      login?: unknown;
      exp?: unknown;
    };
    const exp = Number(payload.exp);
    const login = String(payload.login ?? "").trim();
    if (!login || !Number.isFinite(exp) || Date.now() > exp) return null;
    return login;
  } catch {
    return null;
  }
}

function signAdminSessionPayload(encodedPayload: string): string {
  const secret = config.glasgowToken || "ionbeam-dev-session-secret";
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return phone;
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

function normalizePhoneE164(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  return digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
}

async function sendSmsVerification(
  phoneNumber: string,
  code: string,
): Promise<SmsSendResult> {
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFromNumber) {
    console.log(
      `[iobeam-admin/auth] mock SMS verification code to ${phoneNumber}: ${code}`,
    );
    return { ok: true, mode: "mock", code };
  }

  const to = normalizePhoneE164(phoneNumber);
  const from = normalizePhoneE164(config.twilioFromNumber);
  const body = new URLSearchParams({
    To: to,
    From: from,
    Body: `Your Iobeam verification code is ${code}. It expires in 5 minutes.`,
  });
  const auth = Buffer.from(
    `${config.twilioAccountSid}:${config.twilioAuthToken}`,
  ).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    config.twilioAccountSid,
  )}/Messages.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      error: `SMS send failed: HTTP ${response.status} ${detail}`,
    };
  }
  return { ok: true, mode: "twilio" };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildActivityReportCompatibilitySql(
  ids: number[],
  days: number,
  equipmentId: number | null = null,
): string {
  const equipmentFilter =
    Number.isInteger(equipmentId) && (equipmentId ?? 0) > 0
      ? `AND a.equipment_id = ${equipmentId}`
      : "";
  return `
    SET search_path TO iobeam_admin, public;
    ${adminUserSiteMigrationSql()}
    ${adminSessionSiteMigrationSql()}
    ${adminEquipmentMigrationSql()}
    WITH scoped_activity AS (
      SELECT
        a.id,
        a.user_id,
        a.equipment_id,
        btrim(u.login_name::text) AS login_name,
        btrim(u.first_name::text) AS first_name,
        btrim(u.last_name::text) AS last_name,
        btrim(e.name::text) AS equipment_name,
        btrim(e.model::text) AS equipment_model,
        btrim(e.serial_number::text) AS equipment_serial_number,
        btrim(a.activity_type::text) AS activity_type,
        a.date,
        COALESCE(
          NULLIF(btrim(latest_session.site::text), ''),
          NULLIF(btrim(u.site::text), ''),
          ${sqlString(DEFAULT_SITE)}
        ) AS site,
        CASE
          WHEN upper(btrim(a.activity_type::text)) LIKE '%RASTER%' THEN 'raster'
          WHEN upper(btrim(a.activity_type::text)) LIKE '%VECTOR%'
            OR upper(btrim(a.activity_type::text)) LIKE '%VECTER%' THEN 'vector'
          ELSE 'other'
        END AS scan_kind
      FROM activity a
      JOIN "user" u ON u.id = a.user_id
      LEFT JOIN Equipment e ON e.id = a.equipment_id
      LEFT JOIN LATERAL (
        SELECT s.site
          FROM session s
         WHERE s.user_id = a.user_id
         ORDER BY s.login_time DESC
         LIMIT 1
      ) latest_session ON true
      WHERE a.user_id = ANY(ARRAY[${ids.join(",")}]::integer[])
        AND a.date >= CURRENT_TIMESTAMP - (${days} * INTERVAL '1 day')
        ${equipmentFilter}
    ),
    normalized AS (
      SELECT
        *,
        COALESCE(NULLIF(site, ''), ${sqlString(DEFAULT_SITE)}) AS site_name,
        COALESCE(NULLIF(equipment_name, ''), 'Unknown equipment') AS equipment_label
      FROM scoped_activity
    )
    SELECT jsonb_build_object(
      'totals', COALESCE((
        SELECT jsonb_agg(row_to_json(t) ORDER BY t.total_scans DESC, t.login_name)
        FROM (
          SELECT
            user_id,
            login_name,
            concat_ws(' ', nullif(first_name, ''), nullif(last_name, '')) AS name,
            COUNT(*)::int AS total_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'raster')::int AS raster_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'vector')::int AS vector_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'other')::int AS other_activity,
            MAX(date) AS last_activity
          FROM normalized
          GROUP BY user_id, login_name, first_name, last_name
        ) t
      ), '[]'::jsonb),
      'daily', COALESCE((
        SELECT jsonb_agg(row_to_json(d) ORDER BY d.bucket, d.login_name)
        FROM (
          SELECT
            user_id,
            equipment_id,
            login_name,
            equipment_label AS equipment_name,
            to_char(date_trunc('day', date), 'YYYY-MM-DD') AS bucket,
            COUNT(*) FILTER (WHERE scan_kind = 'raster')::int AS raster_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'vector')::int AS vector_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'other')::int AS other_activity,
            COUNT(*)::int AS total_scans
          FROM normalized
          GROUP BY user_id, equipment_id, login_name, equipment_label, date_trunc('day', date)
        ) d
      ), '[]'::jsonb),
      'weekly', COALESCE((
        SELECT jsonb_agg(row_to_json(w) ORDER BY w.week_start, w.login_name)
        FROM (
          SELECT
            user_id,
            equipment_id,
            login_name,
            equipment_label AS equipment_name,
            to_char(date_trunc('week', date), 'YYYY-MM-DD') AS week_start,
            COUNT(*) FILTER (WHERE scan_kind = 'raster')::int AS raster_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'vector')::int AS vector_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'other')::int AS other_activity,
            COUNT(*)::int AS total_scans
          FROM normalized
          GROUP BY user_id, equipment_id, login_name, equipment_label, date_trunc('week', date)
        ) w
      ), '[]'::jsonb),
      'monthly', COALESCE((
        SELECT jsonb_agg(row_to_json(m) ORDER BY m.month_start, m.login_name)
        FROM (
          SELECT
            user_id,
            equipment_id,
            login_name,
            equipment_label AS equipment_name,
            to_char(date_trunc('month', date), 'YYYY-MM') AS month_start,
            COUNT(*) FILTER (WHERE scan_kind = 'raster')::int AS raster_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'vector')::int AS vector_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'other')::int AS other_activity,
            COUNT(*)::int AS total_scans
          FROM normalized
          GROUP BY user_id, equipment_id, login_name, equipment_label, date_trunc('month', date)
        ) m
      ), '[]'::jsonb),
      'yearly', COALESCE((
        SELECT jsonb_agg(row_to_json(y) ORDER BY y.year_start, y.login_name)
        FROM (
          SELECT
            user_id,
            equipment_id,
            login_name,
            equipment_label AS equipment_name,
            to_char(date_trunc('year', date), 'YYYY') AS year_start,
            COUNT(*) FILTER (WHERE scan_kind = 'raster')::int AS raster_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'vector')::int AS vector_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'other')::int AS other_activity,
            COUNT(*)::int AS total_scans
          FROM normalized
          GROUP BY user_id, equipment_id, login_name, equipment_label, date_trunc('year', date)
        ) y
      ), '[]'::jsonb),
      'site_groups', COALESCE((
        SELECT jsonb_agg(row_to_json(s) ORDER BY s.total_scans DESC, s.site)
        FROM (
          SELECT
            site_name AS site,
            COUNT(DISTINCT user_id)::int AS accounts,
            COUNT(*)::int AS total_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'raster')::int AS raster_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'vector')::int AS vector_scans,
            MAX(date) AS last_activity
          FROM normalized
          GROUP BY site_name
        ) s
      ), '[]'::jsonb),
      'equipment_groups', COALESCE((
        SELECT jsonb_agg(row_to_json(eq) ORDER BY eq.total_scans DESC, eq.equipment_name)
        FROM (
          SELECT
            equipment_id,
            equipment_label AS equipment_name,
            COUNT(DISTINCT user_id)::int AS accounts,
            COUNT(*)::int AS total_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'raster')::int AS raster_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'vector')::int AS vector_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'other')::int AS other_activity,
            MAX(date) AS last_activity
          FROM normalized
          GROUP BY equipment_id, equipment_label
        ) eq
      ), '[]'::jsonb),
      'geography', COALESCE((
        SELECT jsonb_agg(row_to_json(g) ORDER BY g.total_scans DESC, g.location)
        FROM (
          SELECT
            site_name AS location,
            COUNT(DISTINCT user_id)::int AS accounts,
            COUNT(*)::int AS total_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'raster')::int AS raster_scans,
            COUNT(*) FILTER (WHERE scan_kind = 'vector')::int AS vector_scans,
            MAX(date) AS last_activity
          FROM normalized
          GROUP BY site_name
        ) g
      ), '[]'::jsonb),
      'recent', COALESCE((
        SELECT jsonb_agg(row_to_json(r) ORDER BY r.date DESC)
        FROM (
          SELECT
            user_id,
            login_name,
            activity_type,
            scan_kind,
            site_name AS site,
            site_name AS location,
            equipment_id,
            equipment_label AS equipment_name,
            date
          FROM normalized
          ORDER BY date DESC
          LIMIT 24
        ) r
      ), '[]'::jsonb)
    );
  `;
}

async function recordAdminSession(
  req: express.Request,
  user: AdminUser,
  selectedSite: string,
): Promise<void> {
  if (!Number.isInteger(user.id) || (user.id ?? 0) <= 0) {
    throw new Error("cannot record session for an admin user without a database id");
  }

  const clientMachineName = trimForSqlNchar(clientAddress(req), 150);
  await ensureAdminSessionSchema();

  const sql = `
    SET search_path TO iobeam_admin, public;
    INSERT INTO session (
      user_id, login_name, client_machine_name, site, login_time, is_autorized
    )
    VALUES (
      ${user.id},
      ${sqlString(trimForSqlNchar(user.login_name, 100))},
      ${sqlString(clientMachineName)},
      ${sqlString(trimForSqlNchar(selectedSite, 150))},
      CURRENT_TIMESTAMP,
      true
    );
  `;
  await runPsql(["-v", "ON_ERROR_STOP=1"], config.adminDbName, sql);
}

async function isAdminSessionExpired(user: AdminUser): Promise<boolean> {
  if (!Number.isInteger(user.id) || (user.id ?? 0) <= 0) return true;
  const lifetimeDays = normalizeSessionLifetimeDays(
    user.session_lifetime_limit_days,
  );

  try {
    await ensureAdminSessionSchema();
    const sql = `
      SET search_path TO iobeam_admin, public;
      SELECT CASE
               WHEN latest_login IS NULL THEN 'expired'
               WHEN latest_login < CURRENT_TIMESTAMP - (${lifetimeDays} * INTERVAL '1 day') THEN 'expired'
               ELSE 'active'
             END
        FROM (
          SELECT MAX(login_time) AS latest_login
            FROM session
           WHERE user_id = ${user.id}
             AND is_autorized = true
        ) latest;
    `;
    const out = await runPsql(["-Atq"], config.adminDbName, sql);
    return out.trim() !== "active";
  } catch (err) {
    console.warn(
      `[iobeam-admin/auth] session expiration check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

async function ensureAdminSessionSchema(): Promise<void> {
  const sql = `
    SET search_path TO iobeam_admin, public;
    ${adminSessionSiteMigrationSql()}
    ALTER TABLE session
      DROP COLUMN IF EXISTS mac_address,
      ADD COLUMN IF NOT EXISTS login_time timestamp(6);

    DO $$
    BEGIN
      IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'iobeam_admin'
             AND table_name = 'session'
             AND column_name = 'last_signed_in'
      ) THEN
          EXECUTE 'UPDATE session
                     SET login_time = COALESCE(login_time, last_signed_in, CURRENT_TIMESTAMP)
                   WHERE login_time IS NULL';
      ELSE
          UPDATE session
             SET login_time = CURRENT_TIMESTAMP
           WHERE login_time IS NULL;
      END IF;
    END;
    $$;

    ALTER TABLE session
      ALTER COLUMN login_time SET DEFAULT CURRENT_TIMESTAMP,
      ALTER COLUMN login_time SET NOT NULL,
      DROP COLUMN IF EXISTS last_signed_in;
  `;
  await runPsql(["-v", "ON_ERROR_STOP=1"], config.adminDbName, sql);
}

function adminUserSiteMigrationSql(): string {
  return `
    DO $$
    DECLARE
      legacy_column text;
      has_site boolean;
    BEGIN
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'iobeam_admin'
           AND table_name = 'user'
           AND column_name = 'site'
      ) INTO has_site;

      SELECT column_name
        INTO legacy_column
        FROM information_schema.columns
       WHERE table_schema = 'iobeam_admin'
         AND table_name = 'user'
         AND column_name IN ('geo', 'geography', 'geo_site', 'geolocation')
       ORDER BY CASE column_name
                  WHEN 'geo' THEN 1
                  WHEN 'geography' THEN 2
                  WHEN 'geo_site' THEN 3
                  ELSE 4
                END
       LIMIT 1;

      IF legacy_column IS NOT NULL AND NOT has_site THEN
        EXECUTE format('ALTER TABLE "user" RENAME COLUMN %I TO site', legacy_column);
      END IF;
    END;
    $$;

    ALTER TABLE "user"
      ADD COLUMN IF NOT EXISTS site nchar(150);

    DO $$
    DECLARE
      legacy_column text;
    BEGIN
      SELECT column_name
        INTO legacy_column
        FROM information_schema.columns
       WHERE table_schema = 'iobeam_admin'
         AND table_name = 'user'
         AND column_name IN ('geo', 'geography', 'geo_site', 'geolocation')
       ORDER BY CASE column_name
                  WHEN 'geo' THEN 1
                  WHEN 'geography' THEN 2
                  WHEN 'geo_site' THEN 3
                  ELSE 4
                END
       LIMIT 1;

      IF legacy_column IS NOT NULL THEN
        EXECUTE format(
          'UPDATE "user" SET site = COALESCE(NULLIF(btrim(site::text), ''''), NULLIF(btrim(%I::text), ''''), %L)',
          legacy_column,
          ${sqlString(DEFAULT_SITE)}
        );
      END IF;
    END;
    $$;

    UPDATE "user"
       SET site = ${sqlString(DEFAULT_SITE)}
     WHERE site IS NULL OR btrim(site::text) = '';

    ALTER TABLE "user"
      ALTER COLUMN site SET DEFAULT ${sqlString(DEFAULT_SITE)},
      ALTER COLUMN site SET NOT NULL;
  `;
}

function adminSessionSiteMigrationSql(): string {
  return `
    DO $$
    DECLARE
      legacy_column text;
      has_site boolean;
    BEGIN
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'iobeam_admin'
           AND table_name = 'session'
           AND column_name = 'site'
      ) INTO has_site;

      SELECT column_name
        INTO legacy_column
        FROM information_schema.columns
       WHERE table_schema = 'iobeam_admin'
         AND table_name = 'session'
         AND column_name IN ('geo', 'geography', 'geo_site', 'geolocation')
       ORDER BY CASE column_name
                  WHEN 'geo' THEN 1
                  WHEN 'geography' THEN 2
                  WHEN 'geo_site' THEN 3
                  ELSE 4
                END
       LIMIT 1;

      IF legacy_column IS NOT NULL AND NOT has_site THEN
        EXECUTE format('ALTER TABLE session RENAME COLUMN %I TO site', legacy_column);
      END IF;
    END;
    $$;

    ALTER TABLE session
      ADD COLUMN IF NOT EXISTS site nchar(150);

    DO $$
    DECLARE
      legacy_column text;
    BEGIN
      SELECT column_name
        INTO legacy_column
        FROM information_schema.columns
       WHERE table_schema = 'iobeam_admin'
         AND table_name = 'session'
         AND column_name IN ('geo', 'geography', 'geo_site', 'geolocation')
       ORDER BY CASE column_name
                  WHEN 'geo' THEN 1
                  WHEN 'geography' THEN 2
                  WHEN 'geo_site' THEN 3
                  ELSE 4
                END
       LIMIT 1;

      IF legacy_column IS NOT NULL THEN
        EXECUTE format(
          'UPDATE session SET site = COALESCE(NULLIF(btrim(site::text), ''''), NULLIF(btrim(%I::text), ''''), %L)',
          legacy_column,
          ${sqlString(DEFAULT_SITE)}
        );
      END IF;
    END;
    $$;

    UPDATE session
       SET site = ${sqlString(DEFAULT_SITE)}
     WHERE site IS NULL OR btrim(site::text) = '';

    ALTER TABLE session
      ALTER COLUMN site SET DEFAULT ${sqlString(DEFAULT_SITE)},
      ALTER COLUMN site SET NOT NULL;
  `;
}

function clientAddress(req: express.Request): string {
  const forwardedFor = req.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || req.ip || req.socket.remoteAddress || "";
}

function trimForSqlNchar(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

async function ensureAdminUserSchema(): Promise<void> {
  const sql = `
    SET search_path TO iobeam_admin, public;
    ${adminUserSiteMigrationSql()}
    ${adminAuditorMigrationSql()}

    DO $$
    BEGIN
      IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
            JOIN pg_attribute
              ON pg_attribute.attrelid = pg_constraint.conrelid
             AND pg_attribute.attnum = ANY(pg_constraint.conkey)
           WHERE pg_constraint.conrelid = 'iobeam_admin."user"'::regclass
             AND pg_constraint.contype = 'u'
             AND pg_attribute.attname = 'email'
             AND cardinality(pg_constraint.conkey) = 1
      ) THEN
          ALTER TABLE "user"
            ADD CONSTRAINT user_email_unique UNIQUE (email);
      END IF;
    END;
    $$;
  `;
  await runPsql(["-v", "ON_ERROR_STOP=1"], config.adminDbName, sql);
}

function adminAuditorMigrationSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS auditor (
      id         integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_name nchar(100) NOT NULL,
      email     nchar(100) NOT NULL UNIQUE,
      is_active boolean    NOT NULL DEFAULT true
    );

    INSERT INTO auditor (user_name, email, is_active)
    VALUES
      ('Henry Li', 'lyh1154@gmail.com', true),
      ('Sen Da', 'xda@ionbeamtech.com', true),
      ('Yuyao Jiang', 'yuyao.jiang@ionbeamtech.com', true)
    ON CONFLICT (email) DO UPDATE
       SET user_name = EXCLUDED.user_name,
           is_active = EXCLUDED.is_active;
  `;
}

function adminEquipmentMigrationSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS Equipment (
      id            integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name          varchar(100)  NOT NULL,
      model         varchar(100)  NOT NULL DEFAULT '',
      serial_number varchar(15)   NOT NULL UNIQUE,
      site          varchar(50)   NOT NULL DEFAULT '',
      description   varchar(1000) NOT NULL DEFAULT ''
    );

    DO $$
    BEGIN
      IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
            JOIN pg_attribute
              ON pg_attribute.attrelid = pg_constraint.conrelid
             AND pg_attribute.attnum = ANY(pg_constraint.conkey)
           WHERE conrelid = 'iobeam_admin.equipment'::regclass
             AND pg_constraint.contype = 'u'
             AND pg_attribute.attname = 'serial_number'
             AND cardinality(pg_constraint.conkey) = 1
      ) THEN
          ALTER TABLE Equipment
            ADD CONSTRAINT equipment_serial_number_unique UNIQUE (serial_number);
      END IF;
    END;
    $$;

    INSERT INTO Equipment (name, model, serial_number, site, description)
    VALUES (
      'FEI Helios NanoLab 600i DualBeam',
      '',
      'DB123456z',
      'Taixin',
      'DualBeam SEM/FIB, containing both a focused Ga+ ion beam ("Tomahawk") and a high resolution field emission scanning electron ("Elstar") column.'
    )
    ON CONFLICT (serial_number) DO UPDATE
       SET name = EXCLUDED.name,
           model = EXCLUDED.model,
           site = EXCLUDED.site,
           description = EXCLUDED.description;

    ALTER TABLE activity
      ADD COLUMN IF NOT EXISTS equipment_id integer;

    UPDATE activity
       SET equipment_id = (SELECT id FROM Equipment ORDER BY id LIMIT 1)
     WHERE equipment_id IS NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'iobeam_admin.activity'::regclass
             AND conname = 'activity_equipment_id_fkey'
      ) THEN
          ALTER TABLE activity
            ADD CONSTRAINT activity_equipment_id_fkey
            FOREIGN KEY (equipment_id) REFERENCES Equipment(id) ON DELETE SET NULL;
      END IF;
    END;
    $$;

    CREATE INDEX IF NOT EXISTS idx_activity_equipment_date
      ON activity (equipment_id, date DESC);
  `;
}

async function ensureAdminEquipmentSchema(): Promise<void> {
  const sql = `
    SET search_path TO iobeam_admin, public;
    ${adminEquipmentMigrationSql()}
  `;
  await runPsql(["-v", "ON_ERROR_STOP=1"], config.adminDbName, sql);
}

async function listEquipmentFromDb(): Promise<Equipment[]> {
  await ensureAdminEquipmentSchema();
  const sql = `
    SET search_path TO iobeam_admin, public;
    SELECT COALESCE(jsonb_agg(row_to_json(e) ORDER BY e.id), '[]'::jsonb)
      FROM (
        SELECT
          id,
          btrim(name::text) AS name,
          btrim(model::text) AS model,
          btrim(serial_number::text) AS serial_number,
          btrim(site::text) AS site,
          btrim(description::text) AS description
        FROM Equipment
        ORDER BY id
      ) e;
  `;
  const out = await runPsql(["-Atq"], config.adminDbName, sql);
  const rows = JSON.parse(out.trim() || "[]") as unknown;
  return readEquipment({ equipments: rows });
}

async function upsertEquipmentInDb(equipment: Equipment): Promise<void> {
  await ensureAdminEquipmentSchema();
  const idValue =
    Number.isInteger(equipment.id) && (equipment.id ?? 0) > 0
      ? String(equipment.id)
      : "DEFAULT";
  const sql = `
    SET search_path TO iobeam_admin, public;
    INSERT INTO Equipment (id, name, model, serial_number, site, description)
    VALUES (
      ${idValue},
      ${sqlString(trimForSqlNchar(equipment.name, 100))},
      ${sqlString(trimForSqlNchar(equipment.model, 100))},
      ${sqlString(trimForSqlNchar(equipment.serial_number, 15))},
      ${sqlString(trimForSqlNchar(equipment.site, 50))},
      ${sqlString(trimForSqlNchar(equipment.description, 1000))}
    )
    ON CONFLICT (serial_number) DO UPDATE
       SET name = EXCLUDED.name,
           model = EXCLUDED.model,
           site = EXCLUDED.site,
           description = EXCLUDED.description;
  `;
  await runPsql(["-v", "ON_ERROR_STOP=1"], config.adminDbName, sql);
}

async function syncEquipmentToDb(data: unknown): Promise<void> {
  const equipmentRows = readEquipment(data);
  for (const equipment of equipmentRows) {
    if (!equipment.name.trim() || !equipment.serial_number.trim()) continue;
    await upsertEquipmentInDb(equipment);
  }
}

async function findAdminUserInDb(loginOrEmail: string): Promise<AdminUser | null> {
  const login = loginOrEmail.trim();
  if (!login) return null;
  await ensureAdminUserSchema();
  const sql = `
    SET search_path TO iobeam_admin, public;
    SELECT COALESCE(jsonb_agg(row_to_json(u)), '[]'::jsonb)
      FROM (
        SELECT
          id,
          btrim(login_name::text) AS login_name,
          btrim(first_name::text) AS first_name,
          btrim(last_name::text) AS last_name,
          btrim(email::text) AS email,
          btrim(phone_number::text) AS phone_number,
          btrim(company_name::text) AS company_name,
          btrim(site::text) AS site,
          role,
          is_active,
          session_lifetime_limit_days
        FROM "user"
        WHERE lower(btrim(login_name::text)) = lower(${sqlString(login)})
           OR lower(btrim(email::text)) = lower(${sqlString(login)})
        ORDER BY id
        LIMIT 1
      ) u;
  `;
  const out = await runPsql(["-Atq"], config.adminDbName, sql);
  const rows = JSON.parse(out.trim() || "[]") as unknown;
  return Array.isArray(rows) && rows[0] ? readAdminUsers({ users: rows })[0] ?? null : null;
}

async function upsertAdminUserInDb(user: AdminUser): Promise<void> {
  await ensureAdminUserSchema();
  const sql = `
    SET search_path TO iobeam_admin, public;
    INSERT INTO "user" (
      id, login_name, first_name, last_name, email,
      phone_number, company_name, site, role, is_active, session_lifetime_limit_days
    )
    VALUES (
      ${user.id ?? "DEFAULT"},
      ${sqlString(trimForSqlNchar(user.login_name, 100))},
      ${sqlString(trimForSqlNchar(user.first_name, 100))},
      ${sqlString(trimForSqlNchar(user.last_name, 100))},
      ${sqlString(trimForSqlNchar(user.email, 250))},
      ${sqlString(trimForSqlNchar(user.phone_number, 25))},
      ${sqlString(trimForSqlNchar(user.company_name, 150))},
      ${sqlString(trimForSqlNchar(user.site, 150))},
      ${Math.trunc(user.role || ROLE_USER)},
      ${user.is_active ? "true" : "false"},
      ${Math.max(1, Math.trunc(user.session_lifetime_limit_days || 1))}
    )
    ON CONFLICT (login_name) DO UPDATE
       SET first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           email = EXCLUDED.email,
           phone_number = EXCLUDED.phone_number,
           company_name = EXCLUDED.company_name,
           site = EXCLUDED.site,
           role = EXCLUDED.role,
           is_active = EXCLUDED.is_active,
           session_lifetime_limit_days = EXCLUDED.session_lifetime_limit_days;
  `;
  await runPsql(["-v", "ON_ERROR_STOP=1"], config.adminDbName, sql);
}

async function syncAdminUsersToDb(data: unknown): Promise<void> {
  const users = readAdminUsers(data);
  for (const user of users) {
    if (!user.login_name.trim() || !user.email.trim()) continue;
    await upsertAdminUserInDb(user);
  }
}

async function isAuditorEmailInDb(email: string): Promise<boolean> {
  await ensureAdminUserSchema();
  const sql = `
    SET search_path TO iobeam_admin, public;
    SELECT CASE WHEN EXISTS (
      SELECT 1
        FROM auditor
       WHERE lower(btrim(email::text)) = lower(${sqlString(email)})
         AND is_active = true
    ) THEN 'true' ELSE 'false' END;
  `;
  const out = await runPsql(["-Atq"], config.adminDbName, sql);
  return out.trim() === "true";
}

function runPsql(
  args: string[],
  database = config.adminDbName,
  stdin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(
      "psql",
      [
        "-h",
        config.adminDbHost,
        "-p",
        String(config.adminDbPort),
        "-U",
        config.adminDbUser,
        "-d",
        database,
        ...args,
      ],
      {
        env: {
          ...process.env,
          ...(config.adminDbPassword ? { PGPASSWORD: config.adminDbPassword } : {}),
          PGCONNECT_TIMEOUT: String(
            Math.max(1, Math.ceil(config.adminDbCommandTimeoutMs / 1000)),
          ),
        },
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      },
    );
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `psql timed out after ${config.adminDbCommandTimeoutMs}ms connecting to ${config.adminDbHost}:${config.adminDbPort}/${database}`,
        ),
      );
    }, config.adminDbCommandTimeoutMs);

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    if (stdin !== undefined) {
      child.stdin?.setDefaultEncoding("utf8");
      child.stdin?.end(stdin);
    }
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `psql exited with code ${code}`));
      });
    });
  });
}

async function restartServicesAndRespond(
  res: express.Response<RestartServicesResponse>
): Promise<void> {
  const restart = await restartService();
  const backendRestart = planBackendRestart(restart.ok);
  res.json({ ok: true, restart, backend_restart: backendRestart });
  scheduleBackendRestartAfterResponse(res, backendRestart);
}

function scheduleBackendRestartAfterResponse(
  res: express.Response,
  restart: BackendRestartResult
): void {
  if (!restart.scheduled) return;

  res.once("finish", () => {
    setTimeout(() => {
      restartBackend(restart);
    }, 250);
  });
}

function restartBackend(restart: BackendRestartResult): void {
  if (restart.mode === "command" && restart.command) {
    const child = spawn("bash", ["-lc", `sleep 1; exec ${restart.command}`], {
      detached: true,
      stdio: "ignore",
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
    });
    child.unref();
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 2_000).unref();
}

function sendConfigError(res: express.Response, err: unknown): void {
  if (err instanceof ConfigError) {
    res.status(err.status).json({ ok: false, error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[api] request failed: ${message}`);
  res.status(500).json({ ok: false, error: message });
}
