import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import fsp from "node:fs/promises";

import { config } from "./config";
import { ConfigError } from "./configManager";

type UploadSubdir = "csv" | "img";

interface FtpSettings {
  enabled: boolean;
  host: string;
  username: string;
  password: string;
  folder: string;
}

interface ScanArtifactUpload {
  csvFilename: string;
  imageFilename: string;
}

export interface FtpConnectionResult {
  enabled: boolean;
  reachable: boolean;
  message: string;
}

const FTP_CONFIG_PATH = ["Actions", 0, "streamData", "actionData", "ftp"] as const;

export async function uploadScanArtifactsToConfiguredFtp(
  kind: "raster" | "vector",
  filenames: ScanArtifactUpload,
  preview = false,
): Promise<void> {
  if (preview) {
    console.warn(`[ftp-upload] skipping ${kind} scan upload: preview mode`);
    return;
  }

  const ftp = await loadFtpSettings();
  if (!ftp) return;

  const connection = await testFtpConnection(ftp);
  if (!connection.reachable) {
    console.warn(`[ftp-upload] skipping ${kind} scan upload: ${connection.message}`);
    return;
  }

  const csvBuffer = await fetchArtifactWithRetry("/scan/last/csv");
  await uploadBufferWithCurl(ftp, "csv", filenames.csvFilename, csvBuffer);

  const figurePath =
    kind === "vector"
      ? "/scan/last/figure?render=decimated"
      : "/scan/last/figure";
  const imageBuffer = await fetchArtifactWithRetry(figurePath);
  await uploadBufferWithCurl(ftp, "img", filenames.imageFilename, imageBuffer);
}

export async function uploadMergedFigureToConfiguredFtp(
  filename: string,
  imageBuffer: Buffer,
): Promise<void> {
  const ftp = await loadFtpSettings();
  if (!ftp) {
    throw new ConfigError("FTP settings are not configured in streamData.json", 400);
  }
  const connection = await testFtpConnection(ftp);
  if (!connection.reachable) {
    throw new ConfigError(connection.message, 503);
  }
  await uploadBufferWithCurl(ftp, "img", filename, imageBuffer);
}

export async function testConfiguredFtpConnection(): Promise<FtpConnectionResult> {
  const ftp = await loadFtpSettings();
  if (!ftp) {
    return {
      enabled: false,
      reachable: false,
      message: "FTP is disabled or not fully configured in streamData.json",
    };
  }
  return testFtpConnection(ftp);
}

async function loadFtpSettings(): Promise<FtpSettings | null> {
  try {
    const raw = await fsp.readFile(config.configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ftp = readConfigPath(parsed, FTP_CONFIG_PATH);
    if (!ftp || typeof ftp !== "object" || Array.isArray(ftp)) {
      return null;
    }

    const enabled = Boolean((ftp as Record<string, unknown>).enabled ?? false);
    const host = String((ftp as Record<string, unknown>).host ?? "").trim();
    const username = String((ftp as Record<string, unknown>).username ?? "").trim();
    const password = String((ftp as Record<string, unknown>).password ?? "").trim();
    const folder = String((ftp as Record<string, unknown>).folder ?? "").trim();
    if (!enabled || !host || !username || !password || !folder) {
      return null;
    }

    return { enabled, host, username, password, folder };
  } catch (err) {
    console.warn(
      `[ftp-upload] failed to read FTP settings from ${config.configPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

async function fetchArtifactWithRetry(resourcePath: string, attempts = 4): Promise<Buffer> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${config.proxyTargetHttp}${resourcePath}`, {
        headers: config.glasgowToken ? { Authorization: `Bearer ${config.glasgowToken}` } : undefined,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      return Buffer.from(bytes);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < attempts - 1) {
        await delay(250 * (attempt + 1));
      }
    }
  }

  throw lastError ?? new Error(`failed to fetch ${resourcePath}`);
}

async function testFtpConnection(ftp: FtpSettings): Promise<FtpConnectionResult> {
  const target = new URL(`ftp://${ftp.host}`);
  // Only verify access to the configured base folder here. The actual
  // upload step creates `csv/` and `img/` as needed, so the connection
  // check must not fail just because those subdirectories do not exist yet.
  target.pathname = buildRemoteFolderPath(ftp.folder);

  try {
    await runCurl(
      [
        "--silent",
        "--show-error",
        "--fail",
        "--connect-timeout",
        "3",
        "--max-time",
        "5",
        "--ftp-method",
        "nocwd",
        "--disable-epsv",
        "--user",
        `${ftp.username}:${ftp.password}`,
        "--list-only",
        target.toString(),
      ],
      undefined,
    );
    return {
      enabled: true,
      reachable: true,
      message: "FTP connection is reachable",
    };
  } catch (err) {
    return {
      enabled: true,
      reachable: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function uploadBufferWithCurl(
  ftp: FtpSettings,
  subdir: UploadSubdir,
  filename: string,
  buffer: Buffer,
): Promise<void> {
  const remotePath = buildRemotePath(ftp.folder, subdir, filename);
  const target = new URL(`ftp://${ftp.host}`);
  target.pathname = remotePath;
  await runCurl(
    [
      "--silent",
      "--show-error",
      "--fail",
      "--ftp-create-dirs",
      "--ftp-method",
      "nocwd",
      "--disable-epsv",
      "--user",
      `${ftp.username}:${ftp.password}`,
      // Quote commands run before curl changes directories. Use the full
      // remote path so an existing image is deleted from img/, not the
      // account's login directory. The leading * tolerates a missing file.
      "--quote",
      `*DELE ${remotePath}`,
      "--upload-file",
      "-",
      target.toString(),
    ],
    buffer,
  );
}

async function runCurl(args: string[], stdin: Buffer | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("curl", args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      fn();
    }

    let stdout = "";
    let stderr = "";
    stdoutStream?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    stderrStream?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
      });
    });
    if (stdin !== undefined && stdinStream) {
      stdinStream.on("error", (err: NodeJS.ErrnoException) => {
        finish(() => {
          if (err.code === "EPIPE") {
            reject(new Error(stderr.trim() || "curl closed its stdin before upload completed"));
            return;
          }
          reject(err);
        });
      });
      stdinStream.end(stdin);
    }
  });
}

function buildRemotePath(baseFolder: string, subdir: UploadSubdir, filename: string): string {
  const cleanBase = baseFolder.replace(/\\/g, "/").replace(/\/+$/, "");
  const cleanName = filename.replace(/^\/+/, "");
  const suffix = cleanName ? `/${cleanName}` : "";
  return `${cleanBase}/${subdir}${suffix}`.replace(/\/{2,}/g, "/");
}

function buildRemoteFolderPath(baseFolder: string): string {
  const cleanBase = baseFolder.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/+/, "");
  return `/${cleanBase}/`.replace(/\/{2,}/g, "/");
}

function readConfigPath(data: unknown, pathParts: ReadonlyArray<string | number>): unknown {
  let current = data;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
