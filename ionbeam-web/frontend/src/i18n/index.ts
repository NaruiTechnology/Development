/**
 * Lightweight i18n module — no extra dependencies, deliberately small.
 *
 * Why not react-i18next / formatjs / lingui?
 * ------------------------------------------
 * The codebase's package.json carries five runtime deps total. Pulling
 * in a 50 KB i18n framework with namespacing, pluralization rules,
 * ICU MessageFormat parsers, and a backend loader would be the largest
 * non-React thing in the bundle and bigger than every UI component we
 * have. The whole control-panel surface is <500 visible strings, all
 * known at build time, no plural rules for the languages we ship to
 * (en, zh-CN, zh-TW — Chinese has no plural agreement), and no need
 * for lazy loading. A 60-line `t()` + a Redux slice does the job.
 *
 * The translation tables are TypeScript modules so:
 *   - keys are type-checked: a typo in `t("scan.runn")` fails the build
 *   - the tree-shaker drops locales the operator doesn't pick after
 *     dynamic import (we currently eager-import all three because the
 *     total payload is ~25 KB — smaller than one help-popover module)
 *   - non-English files inherit shape from English via TS Partial so a
 *     missing key falls back to English at runtime, not a compile error
 *
 * Placeholders use `{name}` syntax. Interpolation accepts strings,
 * numbers, or already-formatted strings (typical: pass a value through
 * formatNumber first when locale-specific digit grouping matters).
 */
import { useMemo } from "react";

import { useAppSelector } from "../store";
import type { TranslationTable } from "./locales/en";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";
import { zhTW } from "./locales/zh-TW";

/* -------- locale identity --------------------------------------------- */

/**
 * BCP 47 language tags. Chosen over short forms ("zh-Hans" / "zh-Hant")
 * because zh-CN / zh-TW are still the dominant tags in browser
 * `Accept-Language` headers and what most fonts and OS locale pickers
 * actually emit. We map both to the `<html lang>` attribute verbatim.
 */
export type LocaleCode = "en" | "zh-CN" | "zh-TW";

export const ALL_LOCALES: ReadonlyArray<LocaleCode> = ["en", "zh-CN", "zh-TW"];

/** Display name in the language itself — used in the picker. */
export const LOCALE_NAMES: Record<LocaleCode, string> = {
  "en": "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

/** Short 2–3 char label for the segmented picker (mirrors theme picker). */
export const LOCALE_SHORT: Record<LocaleCode, string> = {
  "en": "EN",
  "zh-CN": "简",
  "zh-TW": "繁",
};

/* -------- translation tables ------------------------------------------ */

/** The English table is the canonical schema; the others are Partial<>. */
const tables: Record<LocaleCode, TranslationTable> = {
  "en": en,
  "zh-CN": completeWithFallback(en, zhCN),
  "zh-TW": completeWithFallback(en, zhTW),
};

/**
 * Merge a Partial table over the English defaults so a missing key
 * silently falls through instead of rendering blank. Runs once per
 * locale at module load, not per call.
 */
function completeWithFallback(
  fallback: TranslationTable,
  partial: Partial<TranslationTable>
): TranslationTable {
  const out = { ...fallback } as TranslationTable;
  for (const key in partial) {
    const k = key as keyof TranslationTable;
    const v = partial[k];
    if (typeof v === "string" && v.length > 0) {
      (out as Record<string, string>)[k] = v;
    }
  }
  return out;
}

/* -------- core translate function ------------------------------------- */

export type TranslationKey = keyof TranslationTable;
export type TranslationVars = Record<string, string | number>;

/**
 * Translate `key` into the active `locale` with `{name}` interpolation.
 * Falls back to English on a missing key (defensive — `keyof` typing
 * stops most cases at build time). Returns the raw key on a miss in
 * BOTH languages, which is the loudest possible visual failure mode
 * and makes the dropped key easy to spot in screenshots.
 */
export function translate(
  locale: LocaleCode,
  key: TranslationKey,
  vars?: TranslationVars
): string {
  const table = tables[locale] ?? tables.en;
  const raw = table[key] ?? tables.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    return v == null ? `{${name}}` : String(v);
  });
}

/* -------- React hook -------------------------------------------------- */

export interface TranslationApi {
  locale: LocaleCode;
  t: (key: TranslationKey, vars?: TranslationVars) => string;
  /** Locale-aware number formatter shortcut. */
  fmt: (n: number, opts?: Intl.NumberFormatOptions) => string;
}

/**
 * Subscribe to the locale slice and return a stable `t` bound to it.
 * Memoised on `locale` only so component re-renders from other slices
 * don't allocate a fresh closure every time — keeps useEffect deps
 * stable for callers that pass `t` into them.
 */
export function useTranslation(): TranslationApi {
  const locale = useAppSelector((s) => s.locale.locale);
  return useMemo<TranslationApi>(
    () => ({
      locale,
      t: (key, vars) => translate(locale, key, vars),
      fmt: (n, opts) => formatNumber(locale, n, opts),
    }),
    [locale]
  );
}

/* -------- formatting helpers ----------------------------------------- *
 *
 * The existing code uses `n.toLocaleString()` with the browser's default
 * locale, which produces "1,024" in en-US, "1 024" in fr-FR, etc. — but
 * never honours an in-app locale switch, since the browser doesn't know
 * we changed it. These helpers thread the app locale through Intl so
 * numbers, dates, and ranges are consistent with the rest of the UI.
 *
 * Important: Chinese locales render integers without grouping by
 * default (`1024` not `1,024`), which matches operator expectation in
 * zh-CN / zh-TW. We honour Intl's default rather than forcing thousands
 * separators across the board.
 * --------------------------------------------------------------------- */

export function formatNumber(
  locale: LocaleCode,
  n: number,
  opts?: Intl.NumberFormatOptions
): string {
  if (!Number.isFinite(n)) return String(n);
  try {
    return new Intl.NumberFormat(locale, opts).format(n);
  } catch {
    return String(n);
  }
}

/** Format bytes-per-second style raw counts. Matches the existing
 *  `n.toLocaleString()` style call sites but locale-bound. */
export function formatCount(locale: LocaleCode, n: number): string {
  return formatNumber(locale, n, { maximumFractionDigits: 0 });
}

/* -------- document-level side effects -------------------------------- */

/**
 * Apply the active locale to <html lang> and <title>, persisting nothing
 * here — that's the slice's job. Call from a useEffect bound to the
 * locale value, mirroring `applyThemeToDocument`.
 */
export function applyLocaleToDocument(locale: LocaleCode): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("lang", locale);
  // Document title — keep the product name un-translated (it's a
  // brand) but localise the descriptor.
  const t = translate(locale, "app.documentTitle");
  document.title = t;
}
