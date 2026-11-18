import { apiUrl } from "./backendUrl";
import { scanAuthHeaders } from "./authIdentity";
import { readJsonResponse } from "./readJsonResponse";
import type { StairRecipeCollection } from "./stairRecipe";
export type RecipeDocument = Array<Record<string, StairRecipeCollection>>;
export interface RecipeAssignment { equipment_id: number; pattern_key: string; revision: number; updated_at: string }
export interface RecipeRecord extends RecipeAssignment { collections: RecipeDocument; updated_by: number | null; imported_at: string }
const base = "/api/admin/iobeam/pattern-recipes";
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(base + path), { method: body === undefined ? "GET" : "PUT",
    headers: { ...scanAuthHeaders(), ...(body === undefined ? {} : {"Content-Type": "application/json"}) },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}) });
  const result = await readJsonResponse<T & {ok?: boolean; error?: string}>(response, "pattern recipes");
  if (!response.ok || result.ok === false) throw new Error(result.error ?? `Pattern recipes: HTTP ${response.status}`);
  return result;
}
export const patternRecipeApi = {
  defaults: async (patternKey: string) => {
    const response = await fetch(apiUrl(`/api/admin/iobeam/pattern-recipe-defaults/${encodeURIComponent(patternKey)}`), {headers: scanAuthHeaders()});
    const data = await readJsonResponse<{collections: RecipeDocument; error?: string}>(response, "recipe defaults");
    if (!response.ok) throw new Error(data.error ?? "Cannot load recipe defaults");
    return data.collections;
  },
  list: () => request<{assignments: RecipeAssignment[]}>(""),
  get: (equipmentId: number, patternKey: string) => request<{recipe: RecipeRecord | null}>(`/${equipmentId}/${encodeURIComponent(patternKey)}`),
  save: (equipmentId: number, patternKey: string, collections: RecipeDocument, revision: number) =>
    request<{recipe: RecipeRecord}>(`/${equipmentId}/${encodeURIComponent(patternKey)}`, {collections, expected_revision: revision}),
};

/** Legacy imports can omit per-step values; resolve them before displaying the editable table. */
export function normalizeRecipeImport(raw: unknown): RecipeDocument {
  if (!Array.isArray(raw) || !raw.length) throw new Error("A recipe file must contain a nonempty array of collections");
  return raw.map(entry => {
    if (!entry || typeof entry !== "object" || Object.keys(entry).length !== 1) throw new Error("Each collection needs one name");
    const [name, value] = Object.entries(entry)[0] as [string, StairRecipeCollection];
    if (!value || value.model !== "StairRecipeDefaults" || !value.stepDefaults || !Array.isArray(value.nodes)) throw new Error("Invalid recipe collection");
    return {[name]: {...value, nodes: value.nodes.map(node => ({...node,
      steps: node.steps.map(step => ({...value.stepDefaults, ...step}))}))}};
  });
}
