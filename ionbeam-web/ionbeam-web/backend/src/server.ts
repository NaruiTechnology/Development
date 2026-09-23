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
import net from "node:net";
import tls from "node:tls";
import type { IncomingMessage } from "node:http";

import { config } from "./config";
import { readVacuumEnabled } from "./vacuumConfig";
import { buildRestProxy } from "./restProxy";
import { attachWsProxy } from "./wsProxy";
import { mockRest } from "./mockHardware";
import {
  applyAdminDatabaseSetup,
  pgConnectionFromAdminConfig,
  runPsql,
  type PgConnection,
} from "./adminDbService";
import {
  buildActivityReportFromDb,
  adminActivityExistsInDb,
  dedupeActivityRowsFromDb,
  listAllowedHostsFromDb,
  findAdminUserInDb,
  findAdminUserInDbById,
  isAdminSessionExpiredInDb,
  listAdminUsersFromDb,
  listEquipmentFromDb,
  recordActivityInDb,
  recordAdminSessionInDb,
  registerAdminUserInDb,
  syncAdminUsersToDb,
  syncEquipmentToDb,
  type AdminUser,
  type Equipment,
} from "./adminDbRepository";
import {
  recordInputSetupInDb,
  recordOutputDataInDb,
  readOperationTelemetrySummaryFromDb,
} from "./operationDataRepository";
import { saveAllowedHosts, syncAllowedHostsModuleFromDb } from "./allowedHosts";
import { registerCalibrationRoutes } from "./calibrationRoutes";
import { normalizeScanGeometry, readScanGeometry, writeScanGeometry } from "./scanGeometryConfig";
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
import {
  uploadMergedFigureToConfiguredFtp,
  uploadScanArtifactsToConfiguredFtp,
  testConfiguredFtpConnection,
} from "./ftpUpload";

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

interface AllowedHostsResponse {
  ok: boolean;
  hosts: string[];
  error?: string;
  sync_warning?: string;
}

interface AdminSession {
  userId: number | null;
  login: string;
  email: string;
}

type ScanAuthRequest = express.Request | IncomingMessage;

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

interface AdminDbConnectionResponse {
  ok: boolean;
  connection: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string | null;
    password_configured: boolean;
    sslMode: string;
    connectionString: string;
    commandTimeoutMs: number;
  };
}

interface DbApplyResponse {
  ok: boolean;
  connection?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: boolean;
    sslMode?: string | null;
    commandTimeoutMs: number;
  };
  steps?: Array<{ name: string; ok: boolean; detail: string }>;
  error?: string;
}

interface OperationTelemetryStatusResponse {
  ok: boolean;
  input_setup_count?: number;
  output_data_count?: number;
  latest_input_setup?: {
    id: number;
    activity_id: number;
    start_xy: number;
    end_xy: number;
    dwell: number;
    scale_unit: string;
    ev: number;
    scan_parameters: Record<string, unknown>;
    update_date: string;
  } | null;
  latest_output_data?: {
    id: number;
    activity_id: number;
    csv_filename: string;
    image_filename: string;
    description: string;
    scan_result: Record<string, unknown>;
    update_date: string;
  } | null;
  error?: string;
}

interface ActivityDedupeResponse {
  ok: boolean;
  deleted: number;
}

interface ScanTelemetryStartRequest {
  kind?: unknown;
  preview?: unknown;
  start_xy?: unknown;
  end_xy?: unknown;
  dwell?: unknown;
  scale_unit?: unknown;
  ev?: unknown;
  resolution?: unknown;
  latency_bytes?: unknown;
  vector_resolution?: unknown;
  scan_parameters?: unknown;
}

interface ScanTelemetryOutputRequest {
  activity_id?: unknown;
  kind?: unknown;
  preview?: unknown;
  resolution?: unknown;
  latency_bytes?: unknown;
  vector_resolution?: unknown;
  chunks?: unknown;
  scan_result?: unknown;
}

interface MagCalibrationBeam {
  path: string;
  m_per_fov: Record<string, number>;
}

interface MagCalibrationConfig {
  selected_beam: string;
  beams: Record<string, MagCalibrationBeam>;
}

interface MagCalibrationResponse {
  ok: boolean;
  selected_beam?: string;
  beams?: Record<string, MagCalibrationBeam>;
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
  "Wuxi(无锡)",
  "Xian(西安)",
  "Chengdu(成都)",
  "Hangzhou(杭州)",
  "Tianjing(天津)",
  "Taixin(泰兴)",
] as const;
const LEGACY_SITE_ALIASES: Record<string, string> = {
  "Wexi(无锡)": "Wuxi(无锡)",
};
const DEFAULT_SITE = SITE_OPTIONS[0];

app.use(morgan("dev"));
app.use(express.json({ limit: "256mb" })); // scan DB flow may post large CSV/PNG blobs
app.use((req, res, next) => {
  const origin = req.get("origin");
  const allowed =
    !origin ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
    origin === "http://localhost:5173" ||
    origin === "http://127.0.0.1:5173" ||
    origin === "http://localhost:4173" ||
    origin === "http://127.0.0.1:4173";

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Iobeam-Auth");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

// Health endpoint for ops / load balancers.
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    mock: config.mock,
    mobility_only: config.mobilityOnly,
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
    await authorizeStreamConfigSave(req, data);
    await writeConfig(data);
  } catch (err) {
    sendConfigError(res, err);
    return;
  }

  await restartServicesAndRespond(res);
});

app.post("/api/admin/config/restore", async (_req, res) => {
  try {
    await requireAdminPrivilege(_req, "only Admin or Auditor accounts can restore stream configuration");
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
    const dbUsers = await listAdminUsersFromDb().catch((err) => {
      console.warn(
        `[iobeam-admin/config] DB user records were not loaded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    });
    const dbEquipment = await listEquipmentFromDb().catch((err) => {
      console.warn(
        `[iobeam-admin/config] DB equipment records were not loaded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    });
    res.json({
      ...info,
      data: mergeAdminConfigData(info.data, dbUsers, dbEquipment),
    });
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
      await authorizeAdminConfigSave(req, data);
      await syncAdminUsersToDb(readAdminUsers(data));
      await syncEquipmentToDb(readEquipment(data));
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
    sendConfigError(res, err);
  }
});

// FIB | SEM calibration parameters (CONFIGURATION > Admin > Calibration). See calibrationRoutes.ts.
registerCalibrationRoutes(app, {
  currentActor: (req) => currentAdminActor(req),
  sendError: sendConfigError,
  roles: { superUser: ROLE_SUPER_USER, developer: ROLE_DEVELOPER, admin: ROLE_ADMIN },
});

app.get("/api/admin/iobeam/hosts", async (_req, res: express.Response<AllowedHostsResponse>) => {
  try {
    res.set("Cache-Control", "no-store");
    const hosts = await listAllowedHostsFromDb();
    res.json({ ok: true, hosts });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post(
  "/api/admin/iobeam/hosts",
  async (req, res: express.Response<AllowedHostsResponse | ConfigSaveResponse>) => {
    const body = req.body as { hosts?: unknown; allowed_hosts?: unknown; allowedHosts?: unknown } | null;
    const rawHosts = Array.isArray(body?.hosts)
      ? body?.hosts
      : Array.isArray(body?.allowed_hosts)
        ? body?.allowed_hosts
        : Array.isArray(body?.allowedHosts)
          ? body?.allowedHosts
          : null;

    if (!rawHosts) {
      res.status(400).json({ ok: false, error: "missing JSON body: expected { hosts: string[] }" });
      return;
    }

    const hosts = rawHosts.map((host) => String(host ?? "").trim()).filter((host) => host.length > 0);
    try {
      await requireAdminPrivilege(req, "only Admin or Auditor accounts can edit allowed hosts");
      const saved = await saveAllowedHosts(hosts);
      res.json({
        ok: true,
        hosts: saved.hosts,
        ...(saved.syncWarning ? { sync_warning: saved.syncWarning } : {}),
      });
    } catch (err) {
      sendConfigError(res, err);
    }
  },
);

app.get(
  "/api/admin/iobeam/db/connection",
  async (req, res: express.Response<AdminDbConnectionResponse | ConfigSaveResponse>) => {
    try {
      await requireAdminPrivilege(req, "only Admin or Auditor accounts can view database connection settings");
      const info = await readAdminWithBackup();
      const connection = pgConnectionFromAdminConfig(info.data);
      const includePassword = String(req.query.include_password ?? "").trim() === "1";
      res.json({
        ok: true,
        connection: {
          host: connection.host,
          port: connection.port,
          database: connection.database,
          user: connection.user,
          password: includePassword ? connection.password : null,
          password_configured: Boolean(connection.password),
          sslMode: connection.sslMode ?? "",
          connectionString: adminDbConnectionString(connection, includePassword),
          commandTimeoutMs: connection.commandTimeoutMs,
        },
      });
    } catch (err) {
      sendConfigError(res, err);
    }
  },
);

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

app.get("/api/admin/iobeam/auth/current-account", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const presentedToken = readScanAuthToken(req);
  const session = verifyAdminSessionToken(presentedToken);
  const invalidPresentedSession = Boolean(presentedToken) && session === null;
  const login = session?.login || currentLoginName();
  try {
    const info = await readAdminWithBackup();
    const dbUser =
      session?.userId && session.userId > 0
        ? await findAdminUserInDbById(session.userId).catch(() => null)
        : await findAdminUserInDb(login).catch(() => null);
    const configUser =
      dbUser
        ? null
        : session?.userId && session.userId > 0
          ? findAdminUserById(info.data, session.userId)
          : findAdminUser(info.data, login);
    const user = dbUser ?? configUser;
    // Do not silently fall back to the OS account when the browser actually
    // presented an invalid token. The frontend must discard that stale
    // identity and ask the operator to authenticate again.
    const sessionExpired = invalidPresentedSession || (user ? await isAdminSessionExpired(user) : false);
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

app.get("/api/admin/iobeam/auth/users", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const info = await readAdminWithBackup();
    const dbUsers = await listAdminUsersFromDb().catch(() => []);
    const users = mergeAdminUsers(readAdminUsers(info.data), dbUsers)
      .filter((user) => user.is_active)
      .map(publicAdminUser);
    res.json({ ok: true, users });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/iobeam/auth/register", async (req, res) => {
  const body = (req.body ?? {}) as RegisterAdminUserRequest;
  const loginName = currentLoginName();
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
    const result = await registerAdminUserInDb({
      id: null,
      login_name: loginName,
      first_name: firstName,
      last_name: lastName,
      email,
      phone_number: phoneNumber,
      company_name: companyName,
      site,
      role: ROLE_USER,
      is_active: true,
      session_lifetime_limit_days: 1,
    });
    if (!result.ok) {
      res.status(409).json({ ok: false, error: result.error });
      return;
    }

    const user = result.user;
    const data = upsertAdminUserInConfig(info.data, user);
    await writeAdminConfig(data);
    res.json({ ok: true, user: publicAdminUser(user) });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/iobeam/auth/send-sms", async (req, res) => {
  const body = req.body as { login?: unknown; user_id?: unknown } | null;
  const login = String(body?.login ?? "").trim();
  const userId = Number(body?.user_id ?? 0);
  if (!login && (!Number.isInteger(userId) || userId <= 0)) {
    res.status(400).json({ ok: false, error: "login or user_id is required" });
    return;
  }

  try {
    const info = await readAdminWithBackup();
    const dbUsers = await listAdminUsersFromDb().catch(() => []);
    const users = mergeAdminUsers(readAdminUsers(info.data), dbUsers);
    let user =
      Number.isInteger(userId) && userId > 0
        ? users.find((row) => row.id === userId) ?? null
        : findAdminUser({ users }, login);
    const dbUser =
      !user && login ? await findAdminUserInDb(login).catch(() => null) : null;
    if (dbUser && user && dbUser.email.toLowerCase() !== user.email.toLowerCase()) {
      res.status(409).json({ ok: false, error: "account email does not match the DB record" });
      return;
    }
    user = user ?? dbUser;
    if (!user) {
      res.status(404).json({ ok: false, error: "account not found" });
      return;
    }
    if (login && !adminUserMatchesLogin(user, login)) {
      res.status(409).json({ ok: false, error: "selected account does not match login" });
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
  const body = req.body as {
    challenge_id?: unknown;
    code?: unknown;
    site?: unknown;
    user_id?: unknown;
    login?: unknown;
  } | null;
  const challengeId = String(body?.challenge_id ?? "").trim();
  const code = String(body?.code ?? "").trim();
  const userId = Number(body?.user_id ?? 0);
  const login = String(body?.login ?? "").trim();
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
  if (
    (Number.isInteger(userId) && userId > 0 && challenge.user.id !== userId) ||
    (login && !adminUserMatchesLogin(challenge.user, login))
  ) {
    smsChallenges.delete(challengeId);
    res.status(409).json({ ok: false, error: "verification account does not match challenge" });
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

app.post("/api/admin/iobeam/auth/request-scan-role", async (req, res) => {
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active) {
      res.status(401).json({ ok: false, error: "signed-in account is required" });
      return;
    }

    const info = await readAdminWithBackup();
    const recipients = [...readAuditorEmails(info.data)];
    if (recipients.length === 0) {
      res.status(400).json({ ok: false, error: "no active Auditor email addresses are configured" });
      return;
    }

    const subject = "Scan role request";
    const body = [
      "Please review this account and grant scan permission.",
      "",
      "Requested role: SuperUser",
      `Account: ${actor.login_name || "(not set)"}`,
      `Name: ${`${actor.first_name} ${actor.last_name}`.trim() || "(not set)"}`,
      `Email: ${actor.email || "(not set)"}`,
      `Site: ${actor.site || "(not set)"}`,
      `Current role: ${actor.role}`,
      "",
      "Reason: I need to run RASTER/VECTOR scans.",
    ].join("\n");

    await sendRoleRequestEmail(recipients, subject, body);
    res.json({ ok: true, recipients });
  } catch (err) {
    sendConfigError(res, err);
  }
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

app.get(
  "/api/admin/iobeam/operation/status",
  async (req, res: express.Response<OperationTelemetryStatusResponse>) => {
    try {
      await requireAdminPrivilege(req, "only Admin or Auditor accounts can view operation scan telemetry");
      const summary = await readOperationTelemetrySummaryFromDb();
      res.json({
        ok: true,
        ...summary,
      });
    } catch (err) {
      sendConfigError(res, err);
    }
  },
);

app.post(
  "/api/admin/iobeam/db/apply",
  async (req, res: express.Response<DbApplyResponse>) => {
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
      await requireAdminPrivilege(req, "only Admin or Auditor accounts can apply database setup");
      await authorizeAdminConfigSave(req, data);
      const connection = pgConnectionFromAdminConfig(data);
      const setup = await applyAdminDatabaseSetup({
        connection,
        roleName: connection.user,
      });
      await writeAdminConfig(data);
      res.json(setup);
    } catch (err) {
      sendConfigError(res, err);
    }
  },
);

app.get("/api/admin/iobeam/reports/activity", async (req, res) => {
  try {
    const info = await readAdminWithBackup();
    const connection = pgConnectionFromAdminConfig(info.data);
    const dbUsers = await listAdminUsersFromDb();
    const activeUsers = dbUsers.filter((u) => u.is_active);
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
    if (ids.length === 0 && Number.isInteger(requestedAccountId) && requestedAccountId > 0) {
      ids.push(requestedAccountId);
    }

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
        data_source: adminDbSource(connection),
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

    let report: Record<string, unknown> = {};
    let reportError: string | null = null;
    try {
      report = await buildActivityReportFromDb(
        ids,
        days,
        Number.isInteger(requestedEquipmentId) && requestedEquipmentId > 0
          ? requestedEquipmentId
          : null,
      );
    } catch (err) {
      reportError = err instanceof Error ? err.message : String(err);
      console.error(`[iobeam-admin/report] DB activity report failed: ${reportError}`);
    }
    res.json({
      ok: true,
      data_source: adminDbSource(connection),
      generated_at: new Date().toISOString(),
      report_error: reportError,
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
  const requestedUserId = Number(body?.user_id ?? 0);
  const equipmentId = Number(body?.equipment_id ?? 0);
  const activityType = String(body?.activity_type ?? "scan_result").slice(0, 150);

  if (body?.user_id !== undefined && (!Number.isInteger(requestedUserId) || requestedUserId <= 0)) {
    res.status(400).json({ ok: false, error: "user_id must be a positive integer when provided" });
    return;
  }
  if (body?.equipment_id !== undefined && (!Number.isInteger(equipmentId) || equipmentId <= 0)) {
    res.status(400).json({ ok: false, error: "equipment_id must be a positive integer" });
    return;
  }

  try {
    const info = await readAdminWithBackup();
    const requestedUser =
      requestedUserId > 0
        ? await findAdminUserInDbById(requestedUserId).catch(() => null)
        : null;
    const actor = requestedUser ?? (await currentAdminActor(req).catch(() => null));
    const configUser = actor ?? findAdminUser(info.data, currentLoginName());
    const user =
      (configUser?.id && configUser.id > 0
        ? await findAdminUserInDbById(configUser.id).catch(() => null)
        : null) ??
      (configUser?.login_name
        ? await findAdminUserInDb(configUser.login_name).catch(() => null)
        : null) ??
      (configUser?.email
        ? await findAdminUserInDb(configUser.email).catch(() => null)
        : null);
    const userId = Number(user?.id ?? 0);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ ok: false, error: "no active admin DB user could be resolved for activity recording" });
      return;
    }
    const lifetimeDays = user?.session_lifetime_limit_days ?? 1;
    await recordActivityInDb(
      userId,
      equipmentId > 0 ? equipmentId : null,
      activityType,
      Math.max(1, Math.trunc(lifetimeDays)),
    );
    res.json({ ok: true });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/iobeam/operation/input-setup", async (req, res) => {
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active || !hasRasterVectorScanPrivilege(actor.role)) {
      throw new ConfigError("scan privilege required to record operation inputs", 403);
    }
    const body = req.body as ScanTelemetryStartRequest | null;
    const kind = String(body?.kind ?? "").trim().toLowerCase();
    if (kind !== "raster" && kind !== "vector") {
      res.status(400).json({ ok: false, error: "kind must be raster or vector" });
      return;
    }

    const userId = Number(actor.id ?? 0);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ ok: false, error: "current account does not have a database id" });
      return;
    }

    const lifetimeDays = Math.max(1, Math.trunc(actor.session_lifetime_limit_days ?? 1));
    const activityId = await recordActivityInDb(
      userId,
      null,
      `${kind}_scan`,
      lifetimeDays,
    );
    if (!activityId) {
      throw new ConfigError("failed to record admin activity for scan start", 500);
    }

    const inputId = await recordInputSetupInDb({
      activity_id: activityId,
      start_xy: normalizeDecimal(body?.start_xy, 0),
      end_xy: normalizeDecimal(body?.end_xy, 0),
      dwell: normalizeInteger(body?.dwell, 16),
      scale_unit: normalizeScaleUnit(body?.scale_unit),
      ev: normalizeDecimal(body?.ev, 0),
      scan_parameters: jsonObjectOrSelf(body?.scan_parameters, body),
    });

    res.json({ ok: true, activity_id: activityId, input_setup_id: inputId });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/iobeam/operation/output-data", async (req, res) => {
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active || !hasRasterVectorScanPrivilege(actor.role)) {
      throw new ConfigError("scan privilege required to record operation outputs", 403);
    }
    const body = req.body as ScanTelemetryOutputRequest | null;
    const activityId = normalizePositiveInteger(body?.activity_id);
    if (!activityId) {
      res.status(400).json({ ok: false, error: "activity_id must be a positive integer" });
      return;
    }
    if (!(await adminActivityExistsInDb(activityId))) {
      res.status(404).json({ ok: false, error: "unknown activity_id" });
      return;
    }

    const kind = String(body?.kind ?? "").trim().toLowerCase();
    if (kind !== "raster" && kind !== "vector") {
      res.status(400).json({ ok: false, error: "kind must be raster or vector" });
      return;
    }

    const output = await recordOperationScanOutput(
      kind,
      activityId,
      body as Record<string, unknown> | null,
      jsonObjectOrSelf(body?.scan_result, body),
      normalizeInteger(body?.chunks, 0),
    );

    res.json({
      ok: true,
      output_data_id: output.outputId,
      csv_filename: output.csvFilename,
      image_filename: output.imageFilename,
    });

    void uploadScanArtifactsToConfiguredFtp(kind, {
      csvFilename: output.csvFilename,
      imageFilename: output.imageFilename,
    }).catch((err) => {
      console.warn(`[ftp-upload] failed to upload ${kind} scan artifacts:`, err);
    });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post(
  "/api/admin/iobeam/activity/dedupe",
  async (req, res: express.Response<ActivityDedupeResponse | ConfigSaveResponse>) => {
    try {
      await requireAdminPrivilege(req, "only Admin or Auditor accounts can clean duplicate activity rows");
      const deleted = await dedupeActivityRowsFromDb();
      res.json({ ok: true, deleted });
    } catch (err) {
      sendConfigError(res, err);
    }
  },
);

app.post("/api/admin/restart-services", async (_req, res) => {
  await restartServicesAndRespond(res);
});

app.get("/api/admin/mag-calibration", async (_req, res: express.Response<MagCalibrationResponse>) => {
  try {
    const info = await readWithBackup();
    const mag = readMagCalibrationConfig(info.data);
    res.json({ ok: true, selected_beam: mag.selected_beam, beams: mag.beams });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/mag-calibration", async (req, res: express.Response<MagCalibrationResponse>) => {
  try {
    const info = await readWithBackup();
    const beam = normalizeMagBeam(req.body?.beam);
    const points = normalizeMagPoints(req.body?.m_per_fov);
    const pathValue = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    const next = writeMagCalibrationConfig(info.data, beam, points, pathValue);
    await writeConfig(next);
    const restart = await restartService();
    if (!restart.ok) {
      console.warn(`[mag-calibration] restart failed: ${restart.error ?? restart.stderr ?? "unknown error"}`);
    }
    const mag = readMagCalibrationConfig(next);
    res.json({ ok: true, selected_beam: mag.selected_beam, beams: mag.beams });
  } catch (err) {
    sendConfigError(res, err);
  }
});

// Scan geometry (CONFIGURATION > Admin > Calibration > Scan geometry): the rectified DAC <-> world transform that the
// ROI / bitmap scan paths apply. Stored in streamData.json next to magCalibration. No service restart: the Python
// service keeps receiving plain DAC ranges; only the browser's world -> DAC mapping changes.
app.get("/api/admin/scan-geometry", async (_req, res) => {
  try {
    const info = await readWithBackup();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ...readScanGeometry(info.data) });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.put("/api/admin/scan-geometry", async (req, res) => {
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active) throw new ConfigError("sign in to change the scan geometry", 401);
    if (actor.role < ROLE_SUPER_USER) throw new ConfigError("changing the scan geometry needs SuperUser or higher", 403);
    const info = await readWithBackup();
    const value = req.body?.scan_geometry === null ? null : normalizeScanGeometry(req.body?.scan_geometry, actor.login_name);
    const next = writeScanGeometry(info.data, value);
    await writeConfig(next);
    res.json({ ok: true, ...readScanGeometry(next) });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.post("/api/admin/ftp/merged-figure", async (req, res) => {
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active || !hasRasterVectorScanPrivilege(actor.role)) {
      throw new ConfigError("scan privilege required to upload merged figures", 403);
    }

    const body = req.body as { kind?: unknown; data_url?: unknown; filename?: unknown } | null;
    const kind = String(body?.kind ?? "").trim().toLowerCase();
    if (kind !== "raster" && kind !== "vector") {
      res.status(400).json({ ok: false, error: "kind must be raster or vector" });
      return;
    }

    const imageBuffer = pngBufferFromDataUrl(body?.data_url);
    if (!imageBuffer) {
      res.status(400).json({ ok: false, error: "data_url must be a PNG data URL" });
      return;
    }

    const suppliedFilename = normalizePngFilename(body?.filename);
    let filename = suppliedFilename;
    if (!filename) {
      const telemetry = await readOperationTelemetrySummaryFromDb();
      const latestOutput = telemetry.latest_output_data;
      const latestFilename = normalizePngFilename(latestOutput?.image_filename);
      filename = latestFilename?.toLowerCase().startsWith(`${kind}_`) ? latestFilename : null;
    }
    if (!filename) {
      throw new ConfigError("no original scan filename available for merged figure upload", 409);
    }

    await uploadMergedFigureToConfiguredFtp(filename, imageBuffer);
    res.json({ ok: true, filename });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.get("/api/admin/ftp/test-connection", async (_req, res) => {
  try {
    await requireAdminPrivilege(_req, "only Admin or Auditor accounts can test FTP configuration");
    const status = await testConfiguredFtpConnection();
    res.json({ ok: true, ...status });
  } catch (err) {
    sendConfigError(res, err);
  }
});

app.use("/api/scan/raster/run", requireScanPrivilege);
app.use("/api/scan/vector/run", requireScanPrivilege);

if (config.mock) {
  app.get("/api/status", async (_req, res) => {
    const status = mockRest.status();
    status.vacuum_enabled = readVacuumEnabled(config.vacuumConfigPath);
    res.json(status);
  });
  app.get("/api/defaults", (_req, res) => res.json(mockRest.defaults()));
  app.post("/api/scan/raster/run", (req, res) => res.json(mockRest.runRaster(req.body)));
  app.post("/api/scan/vector/run", (req, res) => res.json(mockRest.runVector(req.body)));
  app.post("/api/scan/abort", (_req, res) => {
    res.status(501).json({ detail: "mock stream uses direct WebSocket stop" });
  });

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
  app.get("/api/scan/last/meta", async (_req, res) => {
    const telemetry = await readOperationTelemetrySummaryFromDb();
    const latestOutput = telemetry.latest_output_data;
    if (!latestOutput) {
      res.json(null);
      return;
    }

    const scanResult = latestOutput.scan_result;
    res.json({
      kind: String(scanResult.kind ?? ""),
      chunks: normalizeInteger(scanResult.chunks, 0),
      source: scanResult.validation ? "validated" : "stream",
      resolution: scanResult.resolution ?? null,
      latency_bytes: scanResult.latency_bytes ?? null,
      pattern: scanResult.kind === "vector" ? (scanResult.process_time_s != null ? "validated" : null) : null,
      csv_filename: latestOutput.csv_filename,
      image_filename: latestOutput.image_filename,
    });
  });
}

// Real scan POST routes must stay outside the mock branch so normal runs
// do not fall through to the Express 404 handler.
app.post("/api/scan/raster/run", async (req, res) => {
  await proxyScanRunWithTelemetry("raster", req, res);
});
app.post("/api/scan/vector/run", async (req, res) => {
  await proxyScanRunWithTelemetry("vector", req, res);
});

// Proxy any remaining /api/* traffic to the Glasgow service.
app.use("/api/vacuum", requireVacuumPrivilege);
app.use("/api", buildRestProxy());

// Keep /api/status explicit in the real backend too so the dev server never
// falls through to the SPA index.html if the proxy router is bypassed or
// reloaded late.
app.get("/api/status", async (_req, res) => {
  try {
    const upstream = await fetch(`${config.proxyTargetHttp}/status`, {
      headers: config.glasgowToken
        ? { Authorization: `Bearer ${config.glasgowToken}` }
        : undefined,
      signal: AbortSignal.timeout(2_000),
    });
    const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
    const text = await upstream.text();
    if (!upstream.ok) {
      throw new Error(`upstream status returned HTTP ${upstream.status}`);
    }
    if (!contentType.includes("application/json")) {
      res.status(502).json({
        error: "upstream_invalid_content_type",
        detail: `upstream /status returned ${contentType || "unknown content type"} instead of JSON`,
        upstream_status: upstream.status,
      });
      return;
    }
    try {
      res.status(upstream.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({
        error: "upstream_invalid_json",
        detail: "upstream /status returned invalid JSON",
        upstream_status: upstream.status,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.json({
      state: "disconnected",
      last_error: `glasgow_service unreachable: ${detail}`,
      scans_completed: 0,
      chunks_in_flight: 0,
      vacuum_enabled: false,
    });
  }
});

app.get("/api/defaults", async (_req, res) => {
  try {
    const upstream = await fetch(`${config.proxyTargetHttp}/defaults`, {
      headers: config.glasgowToken
        ? { Authorization: `Bearer ${config.glasgowToken}` }
        : undefined,
      signal: AbortSignal.timeout(2_000),
    });
    const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
    const text = await upstream.text();
    if (!upstream.ok) {
      throw new Error(`upstream defaults returned HTTP ${upstream.status}`);
    }
    if (!contentType.includes("application/json")) {
      res.status(502).json({
        error: "upstream_invalid_content_type",
        detail: `upstream /defaults returned ${contentType || "unknown content type"} instead of JSON`,
        upstream_status: upstream.status,
      });
      return;
    }
    try {
      res.status(upstream.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({
        error: "upstream_invalid_json",
        detail: "upstream /defaults returned invalid JSON",
        upstream_status: upstream.status,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Defaults are configuration metadata, not device state. Keep the UI
    // authoritative when the Glasgow service is disconnected by reading the
    // local streamData.json directly. In particular, this prevents a cached
    // simulation checkbox from remaining enabled after IsProduction=true.
    try {
      const info = await readWithBackup();
      const root = (info.data && typeof info.data === "object")
        ? info.data as Record<string, any>
        : {};
      const states = root.Actions ?? root.WorkStates ?? root.workStates ?? root.states ?? [];
      const stream = Array.isArray(states)
        ? states.find((entry: any) => entry?.streamData || entry?.name === "streamData" || entry?.Name === "streamData")
        : null;
      const action = stream?.streamData?.actionData
        ?? stream?.actionData
        ?? stream?.ActionData
        ?? stream?.action_data
        ?? root.actionData
        ?? {};
      res.json({
        raster: action.rasterScan ?? {},
        vector: action.vectorScan ?? {},
        simulation: action.simulation ?? {},
        adc: {
          adcHalfPeriod: action.adcHalfPeriod ?? 3,
          adcSettleCycles: action.adcSettleCycles ?? 1,
          adcLatchCycles: action.adcLatchCycles ?? 1,
          busTurnaroundCycles: action.busTurnaroundCycles ?? 0,
          dacDataSetupCycles: action.dacDataSetupCycles ?? 1,
          dacLatchCycles: action.dacLatchCycles ?? 1,
        },
        is_production: root.IsProduction === true,
        adc_test: root.AdcTest !== false && action.AdcTest !== false,
        version: String(root.Version ?? ""),
        defaults_source: "local-config",
        service_error: detail,
      });
    } catch (fallbackError) {
      res.status(502).json({
        error: "defaults_unreachable",
        detail: `glasgow_service unreachable: ${detail}`,
        fallback_error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        upstream: config.proxyTargetHttp,
      });
    }
  }
});

// Static (production) — only mount if the build output actually exists, so
// `npm run dev` doesn't 404 itself.
if (config.mobilityOnly) {
  app.get(["/", "/control", "/report"], (_req, res) => {
    const target = _req.path === "/report" ? "/mobility/reports" : "/mobility";
    res.redirect(302, target);
  });
}

if (fs.existsSync(config.staticDir)) {
  app.use(express.static(config.staticDir));
  app.get("*", (_req, res, next) => {
    if (config.mobilityOnly) {
      const target = _req.path === "/report" ? "/mobility/reports" : "/mobility";
      if (_req.path === "/" || _req.path === "/control" || _req.path === "/report") {
        res.redirect(302, target);
        return;
      }
    }
    const indexHtml = path.join(config.staticDir, "index.html");
    if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
    else next();
  });
}

void syncAllowedHostsModuleFromDb().catch((err) => {
  console.warn(
    `[iobeam-admin/hosts] initial frontend host sync failed: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
});

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

function adminDbSource(connection: PgConnection): "local_db" | "remote_db" {
  const host = connection.host.trim().toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host.startsWith("/")
  ) {
    return "local_db";
  }
  return "remote_db";
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

function findAdminUserByLoginName(users: AdminUser[], loginName: string): AdminUser | null {
  const normalized = loginName.trim().toLowerCase();
  if (!normalized) return null;
  return users.find((user) => user.login_name.trim().toLowerCase() === normalized) ?? null;
}

function adminUserMatchesLogin(user: AdminUser, login: string): boolean {
  const normalized = login.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    (user.login_name.toLowerCase() === normalized || user.email.toLowerCase() === normalized)
  );
}

function findAdminUserById(data: unknown, id: number): AdminUser | null {
  return readAdminUsers(data).find((u) => u.id === id) ?? null;
}

function upsertAdminUserInConfig(data: unknown, user: AdminUser): unknown {
  const root =
    data && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>) }
      : {};
  const email = user.email.trim().toLowerCase();
  const users = readAdminUsers(root);
  const nextUsers: AdminUser[] = [];
  let inserted = false;

  for (const existing of users) {
    const sameId = user.id != null && existing.id === user.id;
    const sameEmail = email && existing.email.trim().toLowerCase() === email;
    if (sameId || sameEmail) {
      if (!inserted) {
        nextUsers.push(user);
        inserted = true;
      }
      continue;
    }
    nextUsers.push(existing);
  }

  if (!inserted) nextUsers.push(user);

  return {
    ...root,
    user: nextUsers[0] ?? user,
    users: nextUsers,
  };
}

function mergeAdminConfigData(
  data: unknown,
  dbUsers: AdminUser[],
  dbEquipment: Equipment[],
): unknown {
  const root =
    data && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>) }
      : {};
  const users = mergeAdminUsers(readAdminUsers(root), dbUsers);
  const equipment = mergeEquipment(dbEquipment, readEquipment(root));
  return {
    ...root,
    user: users[0] ?? root.user ?? emptyAdminUser(),
    users,
    equipment: equipment[0] ?? root.equipment ?? emptyEquipment(),
    equipments: equipment,
  };
}

function mergeAdminUsers(base: AdminUser[], overlay: AdminUser[]): AdminUser[] {
  const rows = new Map<string, AdminUser>();
  for (const user of [...base, ...overlay]) {
    const key = adminUserKey(user);
    if (key) rows.set(key, user);
  }
  return [...rows.values()].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

function adminUserKey(user: AdminUser): string {
  if (user.id != null) return `id:${user.id}`;
  const email = user.email.trim().toLowerCase();
  return email ? `email:${email}` : "";
}

function emptyAdminUser(): AdminUser {
  return {
    id: null,
    login_name: "",
    first_name: "",
    last_name: "",
    email: "",
    phone_number: "",
    company_name: "",
    site: DEFAULT_SITE,
    role: ROLE_USER,
    is_active: true,
    session_lifetime_limit_days: 1,
  };
}

function mergeEquipment(base: Equipment[], overlay: Equipment[]): Equipment[] {
  const rows = new Map<string, Equipment>();
  for (const equipment of [...base, ...overlay]) {
    const key = equipmentKey(equipment);
    if (key) rows.set(key, equipment);
  }
  return [...rows.values()].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

function equipmentKey(equipment: Equipment): string {
  const serialNumber = equipment.serial_number.trim().toLowerCase();
  if (serialNumber) return `serial:${serialNumber}`;
  const name = equipment.name.trim().toLowerCase();
  return name ? `name:${name}` : "";
}

function emptyEquipment(): Equipment {
  return {
    id: null,
    name: "",
    model: "",
    serial_number: "",
    site: "",
    description: "",
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
  const session = verifyAdminSessionToken(readScanAuthToken(req));
  const login = session?.login || currentLoginName();
  const dbUser =
    session?.userId && session.userId > 0
      ? await findAdminUserInDbById(session.userId).catch(() => null)
      : await findAdminUserInDb(login).catch(() => null);
  const configUser =
    dbUser
      ? null
      : session?.userId && session.userId > 0
        ? findAdminUserById(info.data, session.userId)
        : findAdminUser(info.data, login);
  return dbUser ?? configUser;
}

async function authorizeAdminConfigSave(req: ScanAuthRequest, nextData: unknown): Promise<void> {
  const actor = await currentAdminActor(req);
  if (!actor || !actor.is_active) {
    const err = new ConfigError("current account is not authorized to edit admin configuration", 403);
    throw err;
  }

  const info = await readAdminWithBackup();
  if (actor.role < ROLE_ADMIN) {
    throw new ConfigError("only Admin or Auditor accounts can edit admin configuration", 403);
  }

  const dbUsers = await listAdminUsersFromDb().catch(() => []);
  const dbEquipment = await listEquipmentFromDb().catch(() => []);
  const currentData = mergeAdminConfigData(info.data, dbUsers, dbEquipment);
  const beforeUsers = readAdminUsers(currentData);
  const afterUsers = readAdminUsers(nextData);
  const beforeEquipment = readEquipment(currentData);
  const afterEquipment = readEquipment(nextData);
  const changedRoleUsers = changedAdminRoleUsers(beforeUsers, afterUsers);

  if (
    !adminUserCollectionsEqual(beforeUsers, afterUsers) ||
    !equipmentCollectionsEqual(beforeEquipment, afterEquipment)
  ) {
    if (actor.role < ROLE_ADMIN) {
      throw new ConfigError("only Admin or Auditor accounts can edit users or equipment", 403);
    }
  }

  if (changedRoleUsers.length === 0) return;

  if (changedRoleUsers.some((u) => u.role >= ROLE_ADMIN) && actor.role < ROLE_ADMIN) {
    throw new ConfigError("only Admin or Auditor accounts can assign the Admin or Audit role", 403);
  }
  if (changedRoleUsers.some((u) => u.role >= ROLE_SUPER_USER) && actor.role < ROLE_ADMIN) {
    throw new ConfigError("only Admin or Auditor accounts can assign the SuperUser role", 403);
  }
}

async function authorizeStreamConfigSave(req: ScanAuthRequest, nextData: unknown): Promise<void> {
  const info = await readWithBackup();
  if (!pinsConfigEqual(info.data, nextData) || !ftpConfigEqual(info.data, nextData)) {
    await requireAdminPrivilege(req, "only Admin or Auditor accounts can edit PINS or FTP");
  }
}

async function requireAdminPrivilege(req: ScanAuthRequest, message: string): Promise<AdminUser> {
  const actor = await currentAdminActor(req);
  if (!actor || !actor.is_active || actor.role < ROLE_ADMIN) {
    throw new ConfigError(message, 403);
  }
  return actor;
}

async function requireScanPrivilege(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active || !hasRasterVectorScanPrivilege(actor.role)) {
      res.status(403).json({
        ok: false,
        error: "RASTER/VECTOR scan requires SuperUser or higher privilege. Please use the send request button to send emails.",
      });
      return;
    }
    next();
  } catch (err) {
    sendConfigError(res, err);
  }
}

async function requireVacuumPrivilege(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  // Vacuum status is read-only telemetry and is polled as soon as the local
  // dashboard opens. Keep control operations authenticated, but do not make
  // service health/status depend on an interactive SMS session.
  if (req.method === "GET") {
    next();
    return;
  }
  const session = verifyAdminSessionToken(readScanAuthToken(req));
  if (!session) {
    res.status(401).json({ ok: false, error: "vacuum control requires a valid user token" });
    return;
  }
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active) {
      res.status(403).json({ ok: false, error: "current account is not authorized for vacuum control" });
      return;
    }
    next();
  } catch (err) {
    sendConfigError(res, err);
  }
}

async function authorizeScanUpgrade(req: IncomingMessage): Promise<{ ok: true; actor: AdminUser } | { ok: false; status: number; message: string }> {
  try {
    const actor = await currentAdminActor(req);
    if (!actor || !actor.is_active || !hasRasterVectorScanPrivilege(actor.role)) {
      return {
        ok: false,
        status: 403,
        message: "RASTER/VECTOR scan requires SuperUser or higher privilege. Please use the send request button to send emails.",
      };
    }
    return { ok: true, actor };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function hasRasterVectorScanPrivilege(role: number): boolean {
  return role >= ROLE_SUPER_USER;
}

function normalizeInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizePositiveInteger(value: unknown): number {
  const n = normalizeInteger(value, 0);
  return n > 0 ? n : 0;
}

function normalizeDecimal(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function jsonObjectOrSelf(value: unknown, fallback: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (fallback && typeof fallback === "object") {
    return fallback as Record<string, unknown>;
  }
  return {};
}

async function proxyScanRunWithTelemetry(
  kind: "raster" | "vector",
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const body = req.body as Record<string, unknown> | null;
  const actor = await currentAdminActor(req).catch(() => null);
  if (!actor || !actor.is_active || !hasRasterVectorScanPrivilege(actor.role)) {
    res.status(403).json({
      ok: false,
      error: "RASTER/VECTOR scan requires SuperUser or higher privilege. Please use the send request button to send emails.",
    });
    return;
  }

  const preview = isPreviewScan(body);
  if (kind === "vector") {
    const requestTrace = {
      at: new Date().toISOString(),
      preview,
      pattern: body?.pattern ?? null,
      feedback_mode: body?.feedback_mode ?? null,
      gray_level_range: body?.gray_level_range ?? null,
      gray_level_skipped: body?.gray_level_skipped ?? null,
      roi: body?.roi != null,
      simulation_bitmap: body?.simulation_bitmap != null,
    };
    console.info("[scan/vector] request", requestTrace);
    appendVectorTrace("request", requestTrace);
  }
  const activityId = preview
    ? null
    : await recordOperationScanStart(kind, actor, body).catch((err) => {
    console.warn(`[operation-data] failed to record ${kind} scan start:`, err);
    return null;
    });

  const upstream = await fetch(`${config.proxyTargetHttp}/scan/${kind}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.glasgowToken ? { Authorization: `Bearer ${config.glasgowToken}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

  const responseText = await upstream.text();
  const contentType = upstream.headers.get("content-type") ?? "application/json";

  if (kind === "vector") {
    const responseTrace = {
      at: new Date().toISOString(),
      ok: upstream.ok,
      status: upstream.status,
      preview,
      content_type: contentType,
    };
    console.info("[scan/vector] response", responseTrace);
    appendVectorTrace("response", responseTrace);
  }

  if (!upstream.ok || (!activityId && !preview)) {
    res.status(upstream.status).type(contentType).send(responseText);
    return;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    res.status(502).json({
      error: "upstream_invalid_json",
      detail: `scan/${kind}/run returned ${contentType || "unknown content type"} instead of JSON`,
      upstream_status: upstream.status,
    });
    return;
  }

  const chunks = normalizeInteger(parsed.chunks, normalizeInteger(body?.chunks, 0));
  const output = buildScanArtifactInfo(kind, activityId, body, parsed, chunks);
  if (!preview && activityId) {
    await recordOperationScanOutput(kind, activityId, body, parsed, chunks, output).catch((err) => {
      console.warn(`[operation-data] failed to record ${kind} scan output:`, err);
    });
    void uploadScanArtifactsToConfiguredFtp(kind, {
      csvFilename: output.csvFilename,
      imageFilename: output.imageFilename,
    }, preview).catch((err) => {
      console.warn(`[ftp-upload] failed to upload ${kind} scan artifacts:`, err);
    });
  }

  res.status(upstream.status).json({
    ...parsed,
    csv_filename: output.csvFilename,
    image_filename: output.imageFilename,
  });
}

const VECTOR_TRACE_LOG_FILE = "/tmp/ionbeam-vector-trace.log";

function appendVectorTrace(
  kind: "request" | "response",
  payload: Record<string, unknown>,
): void {
  try {
    fs.appendFileSync(
      VECTOR_TRACE_LOG_FILE,
      `${JSON.stringify({ kind, ...payload })}\n`,
      "utf8",
    );
  } catch (err) {
    console.warn(`[scan/vector] failed to append trace to ${VECTOR_TRACE_LOG_FILE}:`, err);
  }
}

async function recordOperationScanStart(
  kind: "raster" | "vector",
  actor: AdminUser,
  body: Record<string, unknown> | null,
): Promise<number | null> {
  const activityId = await recordActivityInDb(
    Number(actor.id ?? 0),
    null,
    `${kind}_scan`,
    Math.max(1, Math.trunc(actor.session_lifetime_limit_days ?? 1)),
  );
  if (!activityId) {
    return null;
  }

  await recordInputSetupInDb({
    activity_id: activityId,
    start_xy: normalizeDecimal(body?.start_xy, 0),
    end_xy: normalizeDecimal(body?.end_xy, 0),
    dwell: normalizeInteger(body?.dwell, 16),
    scale_unit: normalizeScaleUnit(body?.scale_unit),
    ev: normalizeDecimal(body?.ev, 0),
    scan_parameters: body ?? {},
  });
  return activityId;
}

async function recordOperationScanOutput(
  kind: "raster" | "vector",
  activityId: number,
  body: Record<string, unknown> | null,
  response: Record<string, unknown>,
  chunks: number,
  output: ScanArtifactInfo = buildScanArtifactInfo(kind, activityId, body, response, chunks),
): Promise<{ outputId: number; csvFilename: string; imageFilename: string }> {
  const outputId = await recordOutputDataInDb({
    activity_id: activityId,
    csv_filename: output.csvFilename,
    image_filename: output.imageFilename,
    description: output.description,
    scan_result: response,
  });
  return {
    outputId,
    csvFilename: output.csvFilename,
    imageFilename: output.imageFilename,
  };
}

function normalizeScaleUnit(value: unknown): string {
  const unit = String(value ?? "").trim();
  return unit.slice(0, 10) || "dac";
}

function pngBufferFromDataUrl(value: unknown): Buffer | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^data:image\/png;base64,(.+)$/i);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

function normalizePngFilename(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw !== path.basename(raw) || !raw.toLowerCase().endsWith(".png")) {
    return null;
  }
  return raw;
}

function formatScanTimestamp(date: Date): string {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yy}${mm}${dd}_${hh}${min}${ss}`;
}

function buildOperationOutputDescription(payload: {
  kind: string;
  activityId: number | null;
  chunks: number;
  resolution: number;
  latencyBytes: number;
  vectorResolution: number;
  csvFilename: string;
  imageFilename: string;
}): string {
  return JSON.stringify({
    kind: payload.kind,
    activity_id: payload.activityId,
    chunks: payload.chunks,
    resolution: payload.resolution || null,
    latency_bytes: payload.latencyBytes || null,
    vector_resolution: payload.vectorResolution || null,
    csv_filename: payload.csvFilename,
    image_filename: payload.imageFilename,
  });
}

interface ScanArtifactInfo {
  csvFilename: string;
  imageFilename: string;
  description: string;
}

function buildScanArtifactInfo(
  kind: "raster" | "vector",
  activityId: number | null,
  body: Record<string, unknown> | null,
  response: Record<string, unknown>,
  chunks: number,
): ScanArtifactInfo {
  const timestamp = formatScanTimestamp(new Date());
  const resolution = normalizeInteger(response.resolution ?? body?.resolution, 0);
  const latencyBytes = normalizeInteger(response.latency_bytes ?? body?.latency_bytes, 0);
  const vectorResolution = normalizeInteger(response.vector_resolution ?? body?.vector_resolution, 0);
  const filenames = buildScanArtifactFilenames(kind, resolution, latencyBytes, vectorResolution, timestamp);
  return {
    ...filenames,
    description: buildOperationOutputDescription({
      kind,
      activityId,
      chunks,
      resolution,
      latencyBytes,
      vectorResolution,
      csvFilename: filenames.csvFilename,
      imageFilename: filenames.imageFilename,
    }),
  };
}

function isPreviewScan(body: Record<string, unknown> | null): boolean {
  const value = body?.preview;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "1", "yes", "on"].includes(normalized);
  }
  return false;
}

function buildScanArtifactFilenames(
  kind: "raster" | "vector",
  resolution: number,
  latencyBytes: number,
  vectorResolution: number,
  timestamp: string,
): { csvFilename: string; imageFilename: string } {
  return kind === "raster"
    ? {
        csvFilename: `raster_${resolution}x${resolution}_${timestamp}.csv`,
        imageFilename: `raster_${resolution}x${resolution}_${timestamp}.png`,
      }
    : {
        csvFilename: `vector_latency_${latencyBytes || vectorResolution || 0}_${timestamp}.csv`,
        imageFilename: `vector_latency_${latencyBytes || vectorResolution || 0}_${timestamp}.png`,
      };
}

function changedAdminRoleUsers(beforeUsers: AdminUser[], afterUsers: AdminUser[]): AdminUser[] {
  const beforeByKey = new Map(beforeUsers.map((user) => [adminUserComparisonKey(user), user] as const));
  return afterUsers.filter((after) => {
    const before = beforeByKey.get(adminUserComparisonKey(after));
    return !before || before.role !== after.role;
  });
}

function adminUserCollectionsEqual(left: AdminUser[], right: AdminUser[]): boolean {
  return normalizedSignatures(left, adminUserComparisonKey, adminUserSignature).join("\n") ===
    normalizedSignatures(right, adminUserComparisonKey, adminUserSignature).join("\n");
}

function equipmentCollectionsEqual(left: Equipment[], right: Equipment[]): boolean {
  return normalizedSignatures(left, equipmentComparisonKey, equipmentSignature).join("\n") ===
    normalizedSignatures(right, equipmentComparisonKey, equipmentSignature).join("\n");
}

function normalizedSignatures<T>(
  rows: T[],
  key: (row: T, index: number) => string,
  signature: (row: T) => string,
): string[] {
  return rows.map((row, index) => `${key(row, index)}:${signature(row)}`).sort();
}

function adminUserComparisonKey(user: AdminUser, index = 0): string {
  if (user.id != null) return `id:${user.id}`;
  const email = user.email.trim().toLowerCase();
  if (email) return `email:${email}`;
  return `index:${index}`;
}

function adminUserSignature(user: AdminUser): string {
  return JSON.stringify({
    id: user.id,
    login_name: user.login_name.trim(),
    first_name: user.first_name.trim(),
    last_name: user.last_name.trim(),
    email: user.email.trim().toLowerCase(),
    phone_number: user.phone_number.trim(),
    company_name: user.company_name.trim(),
    site: user.site,
    role: user.role,
    is_active: user.is_active,
    session_lifetime_limit_days: user.session_lifetime_limit_days,
  });
}

function equipmentComparisonKey(equipment: Equipment, index = 0): string {
  if (equipment.id != null) return `id:${equipment.id}`;
  const serialNumber = equipment.serial_number.trim().toLowerCase();
  if (serialNumber) return `serial:${serialNumber}`;
  return `index:${index}`;
}

function equipmentSignature(equipment: Equipment): string {
  return JSON.stringify({
    id: equipment.id,
    name: equipment.name.trim(),
    model: equipment.model.trim(),
    serial_number: equipment.serial_number.trim().toLowerCase(),
    site: equipment.site.trim(),
    description: equipment.description.trim(),
  });
}

function adminDbConnectionString(
  connection: Pick<PgConnection, "host" | "port" | "database" | "user" | "password" | "sslMode">,
  includePassword: boolean,
): string {
  const authUser = encodeURIComponent(connection.user);
  const authPassword =
    includePassword && connection.password
      ? `:${encodeURIComponent(connection.password)}`
      : "";
  const host = connection.host || "localhost";
  const sslMode = connection.sslMode ? `?sslmode=${encodeURIComponent(connection.sslMode)}` : "";
  return `postgresql://${authUser}${authPassword}@${host}:${connection.port}/${encodeURIComponent(connection.database)}${sslMode}`;
}

function pinsConfigEqual(left: unknown, right: unknown): boolean {
  return stableJson(readStreamPins(left)) === stableJson(readStreamPins(right));
}

function ftpConfigEqual(left: unknown, right: unknown): boolean {
  return stableJson(readStreamFtp(left)) === stableJson(readStreamFtp(right));
}

function readStreamPins(data: unknown): unknown {
  return readConfigPath(data, ["Actions", 0, "streamData", "actionData", "pins"]);
}

function readStreamFtp(data: unknown): unknown {
  return readConfigPath(data, ["Actions", 0, "streamData", "actionData", "ftp"]);
}

function readConfigPath(data: unknown, pathParts: ReadonlyArray<string | number>): unknown {
  let current = data;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeSessionLifetimeDays(value: unknown): number {
  const days = typeof value === "number" ? value : Number(value ?? 1);
  if (!Number.isFinite(days)) return 1;
  return Math.max(1, Math.trunc(days));
}

function normalizeSite(value: unknown): string {
  const site = String(value ?? "").trim();
  const canonical = LEGACY_SITE_ALIASES[site] ?? site;
  return SITE_OPTIONS.includes(canonical as (typeof SITE_OPTIONS)[number])
    ? canonical
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
    user_id: user.id,
    login: user.login_name,
    email: user.email,
    exp: Date.now() + lifetimeDays * 24 * 60 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signAdminSessionPayload(encoded)}`;
}

function verifyAdminSessionToken(token: string): AdminSession | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = signAdminSessionPayload(encoded);
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      user_id?: unknown;
      login?: unknown;
      email?: unknown;
      exp?: unknown;
    };
    const exp = Number(payload.exp);
    const login = String(payload.login ?? "").trim();
    if (!login || !Number.isFinite(exp) || Date.now() > exp) return null;
    const userId = Number(payload.user_id ?? 0);
    const email = String(payload.email ?? "").trim();
    return {
      userId: Number.isInteger(userId) && userId > 0 ? userId : null,
      login,
      email,
    };
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

async function sendRoleRequestEmail(
  recipients: string[],
  subject: string,
  body: string,
): Promise<void> {
  if (!config.smtpHost || !config.smtpFrom) {
    throw new ConfigError("SMTP email service is not configured", 503);
  }
  if (recipients.length === 0) {
    throw new ConfigError("no email recipients were provided", 400);
  }

  const socket = await connectSmtp();
  try {
    await expectSmtp(socket, [220]);
    await smtpCommand(socket, `EHLO ${os.hostname() || "localhost"}`, [250]);
    if (!config.smtpSecure) {
      await smtpCommand(socket, "STARTTLS", [220]);
      const upgraded = tls.connect({
        socket,
        servername: config.smtpHost,
      });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", resolve);
        upgraded.once("error", reject);
      });
      await smtpCommand(upgraded, `EHLO ${os.hostname() || "localhost"}`, [250]);
      await authenticateSmtp(upgraded);
      await writeSmtpMessage(upgraded, recipients, subject, body);
      await smtpCommand(upgraded, "QUIT", [221]);
      upgraded.end();
      return;
    }

    await authenticateSmtp(socket);
    await writeSmtpMessage(socket, recipients, subject, body);
    await smtpCommand(socket, "QUIT", [221]);
  } finally {
    socket.destroy();
  }
}

function connectSmtp(): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const onConnect = () => resolve(socket);
    const socket = config.smtpSecure
      ? tls.connect({ host: config.smtpHost!, port: config.smtpPort, servername: config.smtpHost! }, onConnect)
      : net.connect({ host: config.smtpHost!, port: config.smtpPort }, onConnect);
    socket.setTimeout(30_000, () => {
      socket.destroy(new Error("SMTP connection timed out"));
    });
    socket.once("error", reject);
  });
}

async function authenticateSmtp(socket: net.Socket | tls.TLSSocket): Promise<void> {
  if (!config.smtpUser || !config.smtpPassword) return;
  await smtpCommand(socket, "AUTH LOGIN", [334]);
  await smtpCommand(socket, Buffer.from(config.smtpUser, "utf8").toString("base64"), [334]);
  await smtpCommand(socket, Buffer.from(config.smtpPassword, "utf8").toString("base64"), [235]);
}

async function writeSmtpMessage(
  socket: net.Socket | tls.TLSSocket,
  recipients: string[],
  subject: string,
  body: string,
): Promise<void> {
  await smtpCommand(socket, `MAIL FROM:<${config.smtpFrom}>`, [250]);
  for (const recipient of recipients) {
    await smtpCommand(socket, `RCPT TO:<${recipient}>`, [250, 251]);
  }
  await smtpCommand(socket, "DATA", [354]);
  socket.write(
    [
      `From: ${config.smtpFrom}`,
      `To: ${recipients.join(", ")}`,
      `Subject: ${subject.replace(/\n?\n/g, " ")}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, ".."),
      ".",
      "",
    ].join("\r\n"),
  );
  await expectSmtp(socket, [250]);
}

function smtpCommand(
  socket: net.Socket | tls.TLSSocket,
  command: string,
  expected: number[],
): Promise<string> {
  socket.write(`${command}\r\n`);
  return expectSmtp(socket, expected);
}

function expectSmtp(socket: net.Socket | tls.TLSSocket, expected: number[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP response timed out"));
    }, 30_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] ?? "";
      if (!/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3));
      cleanup();
      if (expected.includes(code)) {
        resolve(buffer);
      } else {
        reject(new Error(`SMTP command failed: ${buffer.trim()}`));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function recordAdminSession(
  req: express.Request,
  user: AdminUser,
  selectedSite: string,
): Promise<void> {
  const clientMachineName = trimForSqlNchar(clientAddress(req), 150);
  await recordAdminSessionInDb(user, clientMachineName, trimForSqlNchar(selectedSite, 150));
}

async function isAdminSessionExpired(user: AdminUser): Promise<boolean> {
  if (!Number.isInteger(user.id) || (user.id ?? 0) <= 0) return true;
  const lifetimeDays = normalizeSessionLifetimeDays(
    user.session_lifetime_limit_days,
  );

  try {
    return await isAdminSessionExpiredInDb(user.id!, lifetimeDays);
  } catch (err) {
    console.warn(
      `[iobeam-admin/auth] session expiration check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

function clientAddress(req: express.Request): string {
  const forwardedFor = req.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || req.ip || req.socket.remoteAddress || "";
}

function readMagCalibrationConfig(data: unknown): MagCalibrationConfig {
  const actionData = readStreamActionData(data);
  const raw = readRecordValue(actionData, "magCalibration");
  const beamsRaw = readRecordValue(raw, "beams");
  const selectedBeam = normalizeMagBeam(
    raw.selected_beam ?? raw.selectedBeam ?? (actionData.enableEbeam ? "ebeam" : "ion")
  );
  const beams: Record<string, MagCalibrationBeam> = {};

  for (const [beam, value] of Object.entries(beamsRaw)) {
    const normalizedBeam = normalizeMagBeam(beam);
    const record = readRecordValue(value);
    beams[normalizedBeam] = {
      path: typeof record.path === "string" ? record.path : "",
      m_per_fov: normalizeMagPoints(record.m_per_fov ?? record.mPerFov ?? record.points),
    };
  }

  if (!beams[selectedBeam]) {
    beams[selectedBeam] = { path: "", m_per_fov: {} };
  }
  return { selected_beam: selectedBeam, beams };
}

function writeMagCalibrationConfig(
  data: unknown,
  beam: string,
  points: Record<string, number>,
  pathValue: string
): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigError("stream config must be a JSON object", 500);
  }
  const next = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const actionData = mutableStreamActionData(next);
  const existing = readMagCalibrationConfig(next);
  const selectedBeam = normalizeMagBeam(beam);
  const beams = {
    ...existing.beams,
    [selectedBeam]: {
      path: pathValue,
      m_per_fov: points,
    },
  };
  actionData.magCalibration = {
    selected_beam: selectedBeam,
    beams,
  };
  return next;
}

function mutableStreamActionData(data: Record<string, unknown>): Record<string, unknown> {
  const actions = Array.isArray(data.Actions) ? data.Actions : null;
  const first = actions?.[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    throw new ConfigError("stream config is missing Actions[0]", 500);
  }
  const firstRecord = first as Record<string, unknown>;
  const streamData = readMutableRecord(firstRecord, "streamData");
  return readMutableRecord(streamData, "actionData");
}

function readStreamActionData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const record = data as Record<string, unknown>;
  const actions = Array.isArray(record.Actions) ? record.Actions : [];
  const first = actions[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return {};
  return readRecordValue(readRecordValue(first, "streamData"), "actionData");
}

function readMutableRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function readRecordValue(value: unknown, key?: string): Record<string, unknown> {
  const target = key && value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : value;
  return target && typeof target === "object" && !Array.isArray(target)
    ? (target as Record<string, unknown>)
    : {};
}

function normalizeMagBeam(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (["ebeam", "electron", "e-beam"].includes(text)) return "ebeam";
  if (["ion", "ibeam", "i-beam"].includes(text)) return "ion";
  return text || "ion";
}

function normalizeMagPoints(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!Array.isArray(row) || row.length < 2) continue;
      addMagPoint(out, row[0], row[1]);
    }
  } else if (value && typeof value === "object") {
    for (const [mag, fov] of Object.entries(value as Record<string, unknown>)) {
      addMagPoint(out, mag, fov);
    }
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => Number(a) - Number(b))
  );
}

function addMagPoint(out: Record<string, number>, magValue: unknown, fovValue: unknown): void {
  const mag = Math.trunc(Number(magValue));
  const fov = Number(fovValue);
  if (!Number.isFinite(mag) || mag < 1 || !Number.isFinite(fov) || fov <= 0) return;
  out[String(mag)] = fov;
}

function trimForSqlNchar(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
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
  const spawnReplacement = () => {
    if (restart.mode === "command" && restart.command) {
      const child = spawn("bash", ["-lc", `sleep 1; exec ${restart.command}`], {
        detached: true,
        stdio: "ignore",
        cwd: path.resolve(__dirname, ".."),
        env: process.env,
      });
      child.unref();
    }
  };

  try {
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
  } catch {
    // Best-effort only; older Node builds may not expose both helpers.
  }

  server.close(() => {
    spawnReplacement();
    process.exit(0);
  });

  // If the close callback never fires, force the process down so the
  // port is released. The detached restart command is only spawned from
  // the close callback, so we would rather fail closed than race the new
  // listener against a socket that is still being torn down.
  setTimeout(() => {
    process.exit(0);
  }, 5_000).unref();
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
