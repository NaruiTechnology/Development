import { queryAdminStoredStrict } from "./adminDbRepository";
import { ConfigError } from "./configManager";
import { parseProcessingPatterns } from "./processingPatternsConfig";

/** Runtime initialization is database-only; a missing catalogue must never fall back to local JSON. */
export async function getProcessingCatalogueDocument(query = queryAdminStoredStrict): Promise<Record<string, unknown>> {
  const raw = await query("SELECT document FROM ionbeam_asset.processing_catalogue WHERE id = true;");
  if (!raw.trim()) throw new ConfigError("Processing catalogue is missing from the database", 503);
  const document = JSON.parse(raw);
  const parsed = parseProcessingPatterns(document);
  if (parsed.errors.length) throw new ConfigError(`Invalid database processing catalogue: ${parsed.errors.join("; ")}`, 500);
  return document;
}

export async function getProcessingCatalogue() {
  return parseProcessingPatterns(await getProcessingCatalogueDocument());
}
