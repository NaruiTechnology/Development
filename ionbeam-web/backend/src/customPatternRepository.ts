import { queryAdminStoredStrict } from "./adminDbRepository";
import { ConfigError } from "./configManager";

export interface CustomPattern {
  id: number;
  name: string;
  payload: { mimeType: string; data: string };
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

export function validateCustomPattern(name: unknown, payload: unknown): { name: string; payload: CustomPattern["payload"] } {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName || normalizedName.length > 160) throw new ConfigError("Enter a name up to 160 characters.", 400);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ConfigError("Choose an image file.", 400);
  const value = payload as Record<string, unknown>;
  const data = typeof value.data === "string" ? value.data : "";
  const match = IMAGE_DATA_URL.exec(data);
  if (!match) throw new ConfigError("Upload a PNG, JPEG, WebP, or GIF image.", 400);
  if (Buffer.from(match[2], "base64").byteLength > MAX_IMAGE_BYTES) throw new ConfigError("Images must be 10 MB or smaller.", 413);
  return { name: normalizedName, payload: { mimeType: match[1], data } };
}

export function validateCustomPatternId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ConfigError("Invalid custom pattern ID.", 400);
  return id;
}

export async function listCustomPatterns(): Promise<CustomPattern[]> {
  const raw = await queryAdminStoredStrict(`SELECT coalesce(json_agg(row_to_json(r) ORDER BY id), '[]'::json)
    FROM (SELECT id, name, payload FROM ionbeam_asset."CustomPatterns") r;`);
  return JSON.parse(raw || "[]") as CustomPattern[];
}

export async function createCustomPattern(name: string, payload: CustomPattern["payload"]): Promise<CustomPattern> {
  const raw = await queryAdminStoredStrict(`WITH input AS (SELECT $$payload$$ AS p)
    INSERT INTO ionbeam_asset."CustomPatterns" (name, payload)
    SELECT p->>'name', p->'payload' FROM input RETURNING row_to_json("CustomPatterns");`, { name, payload });
  return JSON.parse(raw) as CustomPattern;
}

export async function updateCustomPattern(id: number, name: string, payload: CustomPattern["payload"]): Promise<CustomPattern> {
  const raw = await queryAdminStoredStrict(`WITH input AS (SELECT $$payload$$ AS p)
    UPDATE ionbeam_asset."CustomPatterns" AS current SET name = p->>'name', payload = p->'payload'
    FROM input WHERE current.id = (p->>'id')::integer RETURNING row_to_json(current);`, { id, name, payload });
  if (!raw) throw new ConfigError("Custom pattern was deleted. Reload and try again.", 404);
  return JSON.parse(raw) as CustomPattern;
}

export async function deleteCustomPattern(id: number): Promise<void> {
  const raw = await queryAdminStoredStrict(`WITH input AS (SELECT $$payload$$ AS p)
    DELETE FROM ionbeam_asset."CustomPatterns" AS current USING input
    WHERE current.id = (p->>'id')::integer RETURNING current.id;`, { id });
  if (!raw) throw new ConfigError("Custom pattern was already deleted.", 404);
}
