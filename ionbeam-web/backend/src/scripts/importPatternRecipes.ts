import fs from "node:fs";
import { createHash } from "node:crypto";
import { importPatternRecipes } from "../patternRecipeRepository";

async function main() {
  const [equipment, pattern, file] = process.argv.slice(2);
  if (!equipment || !pattern || !file) throw new Error("Usage: npm run db:import:recipes -- EQUIPMENT_ID PATTERN_KEY JSON_FILE");
  const source = fs.readFileSync(file);
  const inserted = await importPatternRecipes(Number(equipment), pattern, JSON.parse(source.toString("utf8")),
    createHash("sha256").update(source).digest("hex"));
  console.log(inserted ? "Recipes imported." : "Existing equipment/pattern recipes preserved; no changes.");
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
