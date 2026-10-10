// Regenerate tests/parity/web_cases.json from the web frontend sources.
//   npm i --no-save esbuild && node tests/parity/generate.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "parity-")), "cases.mjs");
await build({ entryPoints: [join(here, "web_cases.ts")], bundle: true, format: "esm", platform: "node", outfile: out,
  logLevel: "warning" });
const json = execFileSync(process.execPath, [out], { maxBuffer: 256 * 1024 * 1024 }).toString();
writeFileSync(join(here, "web_cases.json"), json);
console.log(`wrote ${JSON.parse(json).length} cases`);
