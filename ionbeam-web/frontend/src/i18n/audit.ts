/**
 * Translation-audit script. Compares each non-English table against
 * the canonical English one and reports keys that haven't been
 * translated.
 *
 * Run during development with:
 *
 *   npx tsx src/i18n/audit.ts
 *
 * or wire it into the test suite / CI to fail builds that ship with
 * untranslated keys above some threshold.
 *
 * Output format is plain text (one row per missing key) so the result
 * pipes cleanly into grep / sort / wc.
 */
import { en, type TranslationTable } from "./locales/en";
import { zhCN } from "./locales/zh-CN";
import { zhTW } from "./locales/zh-TW";

interface Report {
  locale: string;
  missing: Array<keyof TranslationTable>;
  total: number;
}

function audit(
  name: string,
  partial: Partial<TranslationTable>,
): Report {
  const missing: Array<keyof TranslationTable> = [];
  const keys = Object.keys(en) as Array<keyof TranslationTable>;
  for (const k of keys) {
    const v = partial[k];
    if (typeof v !== "string" || v.length === 0) {
      missing.push(k);
    }
  }
  return { locale: name, missing, total: keys.length };
}

function print(r: Report): void {
  const pct = ((r.total - r.missing.length) / r.total) * 100;
  console.log(
    `\n[${r.locale}] ${r.total - r.missing.length}/${r.total} keys translated ` +
    `(${pct.toFixed(1)}%)`,
  );
  if (r.missing.length === 0) {
    console.log("  all keys translated ✓");
    return;
  }
  for (const k of r.missing) {
    console.log(`  missing: ${String(k)}`);
    console.log(`    en: ${en[k]}`);
  }
}

const reports = [
  audit("zh-CN", zhCN),
  audit("zh-TW", zhTW),
];

reports.forEach(print);

// Exit non-zero so CI fails if anything is missing.
const failed = reports.some((r) => r.missing.length > 0);
if (failed) {
  process.exitCode = 1;
}
