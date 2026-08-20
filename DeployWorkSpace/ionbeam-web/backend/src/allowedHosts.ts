import fs from "node:fs/promises";
import path from "node:path";

import { listAllowedHostsFromDb, replaceAllowedHostsInDb } from "./adminDbRepository";

export const DEFAULT_ALLOWED_HOSTS = ["localhost", "ion.o-0.top"] as const;
export const GENERATED_ALLOWED_HOSTS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "frontend",
  "src",
  "generated",
  "allowedHosts.ts",
);

const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const IPV4_RE =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function normalizeAllowedHosts(hosts: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const host of hosts) {
    const value = String(host ?? "").trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_ALLOWED_HOSTS];
}

export function validateAllowedHosts(hosts: readonly string[]): string[] {
  const invalid: string[] = [];
  for (const host of hosts) {
    const value = String(host ?? "").trim().toLowerCase();
    if (!value) continue;
    if (!isValidAllowedHost(value)) invalid.push(value);
  }
  return invalid;
}

export async function readAllowedHostsFromDb(): Promise<string[]> {
  return normalizeAllowedHosts(await listAllowedHostsFromDb());
}

export async function saveAllowedHosts(
  hosts: readonly string[],
): Promise<{ hosts: string[]; syncWarning?: string | null }> {
  const normalized = normalizeAllowedHosts(hosts);
  const invalid = validateAllowedHosts(normalized);
  if (invalid.length > 0) {
    throw new Error(`invalid allowed host entries: ${invalid.join(", ")}`);
  }
  await replaceAllowedHostsInDb(normalized);
  try {
    await writeAllowedHostsModule(normalized);
    return { hosts: normalized, syncWarning: null };
  } catch (err) {
    return {
      hosts: normalized,
      syncWarning: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function syncAllowedHostsModuleFromDb(): Promise<string[]> {
  const hosts = await readAllowedHostsFromDb();
  await writeAllowedHostsModule(hosts);
  return hosts;
}

async function writeAllowedHostsModule(hosts: readonly string[]): Promise<void> {
  const content = `/**
 * Auto-generated from the iobeam_admin.hosts table.
 * Do not edit by hand; use the mobility Allowed Hosts tab instead.
 */
export const ALLOWED_HOSTS = ${JSON.stringify(hosts, null, 2)} as const;

export type AllowedHost = (typeof ALLOWED_HOSTS)[number];
`;

  await fs.mkdir(path.dirname(GENERATED_ALLOWED_HOSTS_PATH), { recursive: true });
  await fs.writeFile(GENERATED_ALLOWED_HOSTS_PATH, content, "utf8");
}

function isValidAllowedHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (
    host.includes("/") ||
    host.includes("\\") ||
    host.includes(":") ||
    host.includes("@") ||
    host.includes("#") ||
    host.includes("?") ||
    host.includes("*") ||
    host.includes(" ")
  ) {
    return false;
  }
  if (host === "localhost") return true;
  if (IPV4_RE.test(host)) return true;

  const labels = host.split(".");
  if (labels.length === 0) return false;
  return labels.every((label) => label.length > 0 && label.length <= 63 && HOSTNAME_LABEL_RE.test(label));
}
