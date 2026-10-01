"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadScanArtifactsToConfiguredFtp = uploadScanArtifactsToConfiguredFtp;
exports.uploadMergedFigureToConfiguredFtp = uploadMergedFigureToConfiguredFtp;
exports.testConfiguredFtpConnection = testConfiguredFtpConnection;
const node_child_process_1 = require("node:child_process");
const node_buffer_1 = require("node:buffer");
const promises_1 = __importDefault(require("node:fs/promises"));
const config_1 = require("./config");
const configManager_1 = require("./configManager");
const FTP_CONFIG_PATH = ["Actions", 0, "streamData", "actionData", "ftp"];
async function uploadScanArtifactsToConfiguredFtp(kind, filenames, preview = false) {
    if (preview) {
        console.warn(`[ftp-upload] skipping ${kind} scan upload: preview mode`);
        return;
    }
    const ftp = await loadFtpSettings();
    if (!ftp)
        return;
    const connection = await testFtpConnection(ftp);
    if (!connection.reachable) {
        console.warn(`[ftp-upload] skipping ${kind} scan upload: ${connection.message}`);
        return;
    }
    const csvBuffer = await fetchArtifactWithRetry("/scan/last/csv");
    await uploadBufferWithCurl(ftp, "csv", filenames.csvFilename, csvBuffer);
    const figurePath = kind === "vector"
        ? "/scan/last/figure?render=decimated"
        : "/scan/last/figure";
    const imageBuffer = await fetchArtifactWithRetry(figurePath);
    await uploadBufferWithCurl(ftp, "img", filenames.imageFilename, imageBuffer);
}
async function uploadMergedFigureToConfiguredFtp(filename, imageBuffer) {
    const ftp = await loadFtpSettings();
    if (!ftp) {
        throw new configManager_1.ConfigError("FTP settings are not configured in streamData.json", 400);
    }
    const connection = await testFtpConnection(ftp);
    if (!connection.reachable) {
        throw new configManager_1.ConfigError(connection.message, 503);
    }
    await uploadBufferWithCurl(ftp, "img", filename, imageBuffer);
}
async function testConfiguredFtpConnection() {
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
async function loadFtpSettings() {
    try {
        const raw = await promises_1.default.readFile(config_1.config.configPath, "utf8");
        const parsed = JSON.parse(raw);
        const ftp = readConfigPath(parsed, FTP_CONFIG_PATH);
        if (!ftp || typeof ftp !== "object" || Array.isArray(ftp)) {
            return null;
        }
        const enabled = Boolean(ftp.enabled ?? false);
        const host = String(ftp.host ?? "").trim();
        const username = String(ftp.username ?? "").trim();
        const password = String(ftp.password ?? "").trim();
        const folder = String(ftp.folder ?? "").trim();
        if (!enabled || !host || !username || !password || !folder) {
            return null;
        }
        return { enabled, host, username, password, folder };
    }
    catch (err) {
        console.warn(`[ftp-upload] failed to read FTP settings from ${config_1.config.configPath}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
async function fetchArtifactWithRetry(resourcePath, attempts = 4) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await fetch(`${config_1.config.proxyTargetHttp}${resourcePath}`, {
                headers: config_1.config.glasgowToken ? { Authorization: `Bearer ${config_1.config.glasgowToken}` } : undefined,
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const bytes = await response.arrayBuffer();
            return node_buffer_1.Buffer.from(bytes);
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < attempts - 1) {
                await delay(250 * (attempt + 1));
            }
        }
    }
    throw lastError ?? new Error(`failed to fetch ${resourcePath}`);
}
async function testFtpConnection(ftp) {
    const target = new URL(`ftp://${ftp.host}`);
    // Only verify access to the configured base folder here. The actual
    // upload step creates `csv/` and `img/` as needed, so the connection
    // check must not fail just because those subdirectories do not exist yet.
    target.pathname = buildRemoteFolderPath(ftp.folder);
    try {
        await runCurl([
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
        ], undefined);
        return {
            enabled: true,
            reachable: true,
            message: "FTP connection is reachable",
        };
    }
    catch (err) {
        return {
            enabled: true,
            reachable: false,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}
async function uploadBufferWithCurl(ftp, subdir, filename, buffer) {
    const remotePath = buildRemotePath(ftp.folder, subdir, filename);
    const target = new URL(`ftp://${ftp.host}`);
    target.pathname = remotePath;
    await runCurl([
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
    ], buffer);
}
async function runCurl(args, stdin) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = (0, node_child_process_1.spawn)("curl", args, {
            stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
        const stdoutStream = child.stdout;
        const stderrStream = child.stderr;
        const stdinStream = child.stdin;
        function finish(fn) {
            if (settled)
                return;
            settled = true;
            fn();
        }
        let stdout = "";
        let stderr = "";
        stdoutStream?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        stderrStream?.on("data", (chunk) => {
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
            stdinStream.on("error", (err) => {
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
function buildRemotePath(baseFolder, subdir, filename) {
    const cleanBase = baseFolder.replace(/\\/g, "/").replace(/\/+$/, "");
    const cleanName = filename.replace(/^\/+/, "");
    const suffix = cleanName ? `/${cleanName}` : "";
    return `${cleanBase}/${subdir}${suffix}`.replace(/\/{2,}/g, "/");
}
function buildRemoteFolderPath(baseFolder) {
    const cleanBase = baseFolder.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/+/, "");
    return `/${cleanBase}/`.replace(/\/{2,}/g, "/");
}
function readConfigPath(data, pathParts) {
    let current = data;
    for (const part of pathParts) {
        if (!current || typeof current !== "object")
            return undefined;
        current = current[part];
    }
    return current;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=ftpUpload.js.map