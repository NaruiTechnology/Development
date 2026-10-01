// Regenerates the desktop app's translation data from the web frontend.
//
//   cd ionbeam-native/scripts/i18n && npm ci && npm run extract
//
// Output (committed): ionbeam_native/i18n/data/{en,zh-CN,zh-TW}.json and help.json.
// The web tables stay the single source of truth; run this whenever the web
// frontend's i18n/locales or i18n/help change. Missing zh keys fall back to
// English exactly as the web's completeWithFallback() does.
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const web = path.join(repo, "ionbeam-web/frontend/src/i18n");
const out = path.resolve(here, "../../ionbeam_native/i18n/data");
const work = mkdtempSync(path.join(tmpdir(), "ionbeam-i18n-"));
const entry = path.join(work, "entry.tsx");

writeFileSync(entry, `
import { renderToStaticMarkup } from "react-dom/server";
import { en } from ${JSON.stringify(path.join(web, "locales/en.ts"))};
import { zhCN } from ${JSON.stringify(path.join(web, "locales/zh-CN.ts"))};
import { zhTW } from ${JSON.stringify(path.join(web, "locales/zh-TW.ts"))};
import { helpBodies as helpEn } from ${JSON.stringify(path.join(web, "help/en.tsx"))};
import { helpBodies as helpCN } from ${JSON.stringify(path.join(web, "help/zh-CN.tsx"))};
import { helpBodies as helpTW } from ${JSON.stringify(path.join(web, "help/zh-TW.tsx"))};
function render(bodies) {
  const outBodies = {};
  for (const [key, fn] of Object.entries(bodies)) outBodies[key] = renderToStaticMarkup(fn());
  return outBodies;
}
export const tables = { "en": en, "zh-CN": zhCN, "zh-TW": zhTW };
export const help = { "en": render(helpEn), "zh-CN": render(helpCN), "zh-TW": render(helpTW) };
`);

const bundle = path.join(work, "bundle.cjs");
await build({
  entryPoints: [entry],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: bundle,
  jsx: "automatic",
  nodePaths: [path.join(here, "node_modules")],
  logLevel: "warning",
});
const { tables, help } = createRequire(import.meta.url)(bundle);

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
for (const [locale, table] of Object.entries(tables)) {
  const merged = locale === "en" ? table : Object.fromEntries(
    Object.entries(tables.en).map(([k, v]) => [k, typeof table[k] === "string" && table[k].length > 0 ? table[k] : v]),
  );
  writeFileSync(path.join(out, `${locale}.json`), JSON.stringify(sortKeys(merged), null, 1) + "\n");
}
const mergedHelp = {};
for (const [locale, bodies] of Object.entries(help)) {
  mergedHelp[locale] = sortKeys({ ...help.en, ...bodies });
}
writeFileSync(path.join(out, "help.json"), JSON.stringify(mergedHelp, null, 1) + "\n");
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${Object.keys(tables.en).length} keys x ${Object.keys(tables).length} locales, ${Object.keys(help.en).length} help topics -> ${out}`);
