import { apiUrl } from "./backendUrl";
import { scanAuthHeaders } from "./authIdentity";
import { readJsonResponse } from "./readJsonResponse";

export interface CustomPattern {
  id: number;
  name: string;
  payload: { mimeType: string; data: string };
}

const base = "/api/admin/iobeam/custom-patterns";
async function request<T>(path = "", method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(base + path), {
    method,
    headers: { ...scanAuthHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await readJsonResponse<T & { ok?: boolean; error?: string }>(response, "custom patterns");
  if (!response.ok || result.ok === false) throw new Error(result.error ?? `Custom patterns: HTTP ${response.status}`);
  return result;
}

export const customPatternApi = {
  list: () => request<{ patterns: CustomPattern[] }>(),
  create: (name: string, payload: CustomPattern["payload"]) => request<{ pattern: CustomPattern }>("", "POST", { name, payload }),
  update: (id: number, name: string, payload: CustomPattern["payload"]) => request<{ pattern: CustomPattern }>(`/${id}`, "PUT", { name, payload }),
  remove: (id: number) => request<{ ok: boolean }>(`/${id}`, "DELETE"),
};
