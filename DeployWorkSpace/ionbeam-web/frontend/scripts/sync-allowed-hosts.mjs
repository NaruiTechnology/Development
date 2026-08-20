#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDir, "..");
const targetPath = path.join(frontendRoot, "src", "generated", "allowedHosts.ts");
const defaultHosts = ["localhost", "ion.o-0.top"];

const hosts = await loadHosts();
await writeModule(normalizeHosts(hosts));

async function loadHosts() {
  const envValue = process.env.IONBEAM_ALLOWED_HOSTS?.trim();
  if (envValue) {
    return splitHosts(envValue);
  }

  const envFile = process.env.IONBEAM_ALLOWED_HOSTS_FILE?.trim();
  if (envFile) {
    try {
      const raw = await fs.readFile(path.resolve(envFile), "utf8");
      return parseHostsJson(raw);
    } catch {
      // Fall through to the generated file or the built-in defaults.
    }
  }

  const envUrl = process.env.IONBEAM_ALLOWED_HOSTS_URL?.trim();
  if (envUrl) {
    try {
      const response = await fetch(envUrl, { headers: { Accept: "application/json" } });
      if (response.ok) {
        const data = await response.json();
        return parseHostsResponse(data);
      }
    } catch {
      // Fall through to the generated file or the built-in defaults.
    }
  }

  try {
    const existing = await fs.readFile(targetPath, "utf8");
    const match = existing.match(/ALLOWED_HOSTS\s*=\s*(\[[\s\S]*?\])\s*as const/);
    if (match) {
      return parseHostsJson(match[1]);
    }
  } catch {
    // No existing file yet.
  }

  return defaultHosts;
}

function splitHosts(value) {
  return value
    .split(/[\n,]+/)
    .map((host) => host.trim())
    .filter(Boolean);
}

function parseHostsResponse(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.hosts)) {
    return value.hosts;
  }
  return defaultHosts;
}

function parseHostsJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : defaultHosts;
  } catch {
    return defaultHosts;
  }
}

function normalizeHosts(value) {
  const seen = new Set();
  const out = [];
  for (const host of value) {
    const normalized = String(host ?? "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length > 0 ? out : defaultHosts;
}

async function writeModule(value) {
  const content = `/**
 * Auto-generated from the iobeam_admin.hosts table.
 * Do not edit by hand; use the mobility Allowed Hosts tab instead.
 */
export const ALLOWED_HOSTS = ${JSON.stringify(value, null, 2)} as const;

export type AllowedHost = (typeof ALLOWED_HOSTS)[number];
`;

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
}
