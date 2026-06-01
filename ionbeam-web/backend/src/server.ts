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
  role: number;
  is_active: boolean;
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
      await writeAdminConfig(data);
    } catch (err) {
      sendConfigError(res, err);
      return;
    }

    res.json({ ok: true });
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

app.get("/api/admin/iobeam/auth/current-account", async (_req, res) => {
  const login = currentLoginName();
  try {
    const info = await readAdminWithBackup();
    const user = findAdminUser(info.data, login);
    res.json({
      ok: true,
      login,
      registered: Boolean(user),
      user: user ? publicAdminUser(user) : null,
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

    const user: AdminUser = {
      id: nextAdminUserId(currentUsers),
      login_name: loginName,
      first_name: firstName,
      last_name: lastName,
      email,
      phone_number: phoneNumber,
      company_name: companyName,
      role: 0,
      is_active: true,
    };

    const data = addAdminUser(info.data, user);
    await writeAdminConfig(data);
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
    const user = findAdminUser(info.data, login);
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
  const body = req.body as { challenge_id?: unknown; code?: unknown } | null;
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
    await recordAdminSession(req, challenge.user);
  } catch (err) {
    console.warn(
      `[iobeam-admin/auth] sign-in session was not recorded: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  res.json({
    ok: true,
    user: publicAdminUser(challenge.user),
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

app.post("/api/admin/iobeam/activity", async (req, res) => {
  const body = req.body as {
    user_id?: unknown;
    activity_type?: unknown;
  } | null;
  const userId = Number(body?.user_id ?? 1);
  const activityType = String(body?.activity_type ?? "scan_result").slice(0, 150);

  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ ok: false, error: "user_id must be a positive integer" });
    return;
  }

  try {
    const sql = `
      SET search_path TO iobeam_admin, public;
      ALTER TABLE activity
        DROP COLUMN IF EXISTS data_file,
        DROP COLUMN IF EXISTS image_file,
        DROP COLUMN IF EXISTS data_file_name,
        DROP COLUMN IF EXISTS image_file_name,
        ALTER COLUMN last_signed_in SET DEFAULT CURRENT_TIMESTAMP;
      UPDATE activity
         SET last_signed_in = CURRENT_TIMESTAMP
       WHERE last_signed_in IS NULL;
      ALTER TABLE activity
        ALTER COLUMN last_signed_in SET NOT NULL;
      INSERT INTO activity (
        user_id, activity_type, date, last_signed_in
      )
      VALUES (
        ${userId},
        ${sqlString(activityType)},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
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
attachWsProxy(server);

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
      role: typeof u.role === "number" ? u.role : Number(u.role ?? 0),
      is_active: typeof u.is_active === "boolean" ? u.is_active : true,
    }));
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
    role: user.role,
    is_active: user.is_active,
    initials: `${user.first_name.charAt(0)}${user.last_name.charAt(0)}`.toUpperCase(),
  };
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

async function recordAdminSession(req: express.Request, user: AdminUser): Promise<void> {
  if (!Number.isInteger(user.id) || (user.id ?? 0) <= 0) {
    throw new Error("cannot record session for an admin user without a database id");
  }

  const clientMachineName = trimForSqlNchar(clientAddress(req), 150);
  await ensureAdminSessionSchema();

  const sql = `
    SET search_path TO iobeam_admin, public;
    INSERT INTO session (
      user_id, login_name, client_machine_name, login_time, is_autorized
    )
    VALUES (
      ${user.id},
      ${sqlString(trimForSqlNchar(user.login_name, 100))},
      ${sqlString(clientMachineName)},
      CURRENT_TIMESTAMP,
      true
    );
  `;
  await runPsql(["-v", "ON_ERROR_STOP=1"], config.adminDbName, sql);
}

async function ensureAdminSessionSchema(): Promise<void> {
  const sql = `
    SET search_path TO iobeam_admin, public;
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

function clientAddress(req: express.Request): string {
  const forwardedFor = req.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || req.ip || req.socket.remoteAddress || "";
}

function trimForSqlNchar(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function runPsql(
  args: string[],
  database = config.adminDbName,
  stdin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
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
        },
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      },
    );
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `psql exited with code ${code}`));
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
