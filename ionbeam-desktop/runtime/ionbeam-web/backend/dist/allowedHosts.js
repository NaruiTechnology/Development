"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GENERATED_ALLOWED_HOSTS_PATH = exports.DEFAULT_ALLOWED_HOSTS = void 0;
exports.normalizeAllowedHosts = normalizeAllowedHosts;
exports.validateAllowedHosts = validateAllowedHosts;
exports.readAllowedHostsFromDb = readAllowedHostsFromDb;
exports.saveAllowedHosts = saveAllowedHosts;
exports.syncAllowedHostsModuleFromDb = syncAllowedHostsModuleFromDb;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const adminDbRepository_1 = require("./adminDbRepository");
exports.DEFAULT_ALLOWED_HOSTS = ["localhost", "ion.o-0.top"];
exports.GENERATED_ALLOWED_HOSTS_PATH = node_path_1.default.resolve(__dirname, "..", "..", "frontend", "src", "generated", "allowedHosts.ts");
const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function normalizeAllowedHosts(hosts) {
    const seen = new Set();
    const normalized = [];
    for (const host of hosts) {
        const value = String(host ?? "").trim().toLowerCase();
        if (!value || seen.has(value))
            continue;
        seen.add(value);
        normalized.push(value);
    }
    return normalized.length > 0 ? normalized : [...exports.DEFAULT_ALLOWED_HOSTS];
}
function validateAllowedHosts(hosts) {
    const invalid = [];
    for (const host of hosts) {
        const value = String(host ?? "").trim().toLowerCase();
        if (!value)
            continue;
        if (!isValidAllowedHost(value))
            invalid.push(value);
    }
    return invalid;
}
async function readAllowedHostsFromDb() {
    return normalizeAllowedHosts(await (0, adminDbRepository_1.listAllowedHostsFromDb)());
}
async function saveAllowedHosts(hosts) {
    const normalized = normalizeAllowedHosts(hosts);
    const invalid = validateAllowedHosts(normalized);
    if (invalid.length > 0) {
        throw new Error(`invalid allowed host entries: ${invalid.join(", ")}`);
    }
    await (0, adminDbRepository_1.replaceAllowedHostsInDb)(normalized);
    try {
        await writeAllowedHostsModule(normalized);
        return { hosts: normalized, syncWarning: null };
    }
    catch (err) {
        return {
            hosts: normalized,
            syncWarning: err instanceof Error ? err.message : String(err),
        };
    }
}
async function syncAllowedHostsModuleFromDb() {
    const hosts = await readAllowedHostsFromDb();
    await writeAllowedHostsModule(hosts);
    return hosts;
}
async function writeAllowedHostsModule(hosts) {
    const content = `/**
 * Auto-generated from the iobeam_admin.hosts table.
 * Do not edit by hand; use the mobility Allowed Hosts tab instead.
 */
export const ALLOWED_HOSTS = ${JSON.stringify(hosts, null, 2)} as const;

export type AllowedHost = (typeof ALLOWED_HOSTS)[number];
`;
    await promises_1.default.mkdir(node_path_1.default.dirname(exports.GENERATED_ALLOWED_HOSTS_PATH), { recursive: true });
    await promises_1.default.writeFile(exports.GENERATED_ALLOWED_HOSTS_PATH, content, "utf8");
}
function isValidAllowedHost(host) {
    if (!host || host.length > 253)
        return false;
    if (host.includes("/") ||
        host.includes("\\") ||
        host.includes(":") ||
        host.includes("@") ||
        host.includes("#") ||
        host.includes("?") ||
        host.includes("*") ||
        host.includes(" ")) {
        return false;
    }
    if (host === "localhost")
        return true;
    if (IPV4_RE.test(host))
        return true;
    const labels = host.split(".");
    if (labels.length === 0)
        return false;
    return labels.every((label) => label.length > 0 && label.length <= 63 && HOSTNAME_LABEL_RE.test(label));
}
//# sourceMappingURL=allowedHosts.js.map