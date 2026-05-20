/**
 * Active interface language. Persisted to localStorage and applied to
 * the <html> element via the `lang` attribute, plus the document
 * title. Mirrors themeSlice's structure on purpose — both are "user
 * preference, persisted, applied to <html>" and reading the same
 * pattern twice in the codebase is a good thing.
 *
 * Default-locale resolution:
 *   1) localStorage if present and known
 *   2) navigator.language family (so a zh-* browser gets zh-CN unless
 *      the BCP 47 region tag is TW / HK / MO, in which case zh-TW)
 *   3) hard fallback to "en"
 *
 * We deliberately do NOT trust the `Accept-Language` HTTP header here
 * because this is a SPA — the only language signal that's actually
 * the operator's current preference is what the browser reports at
 * runtime, not what a proxy or cache sent on initial HTML load.
 */
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

import {
  ALL_LOCALES,
  applyLocaleToDocument,
  type LocaleCode,
} from "../i18n";

const STORAGE_KEY = "ionbeam.locale";

interface LocaleState {
  locale: LocaleCode;
}

/** Detect a reasonable locale from the browser; called only when the
 *  user has no stored preference yet. */
function detectFromBrowser(): LocaleCode {
  if (typeof navigator === "undefined") return "en";
  const candidates: string[] = [];
  // navigator.languages is the prioritized list (most browsers); fall
  // back to navigator.language otherwise. Both are best-effort.
  if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
  if (typeof navigator.language === "string") candidates.push(navigator.language);

  for (const raw of candidates) {
    const tag = raw.toLowerCase();
    if (tag === "zh-tw" || tag === "zh-hk" || tag === "zh-mo" || tag.startsWith("zh-hant")) {
      return "zh-TW";
    }
    if (tag === "zh" || tag.startsWith("zh-") || tag.startsWith("zh-hans")) {
      // any other zh-* (zh-CN, zh-SG, bare "zh", zh-Hans-…) → simplified
      return "zh-CN";
    }
    if (tag === "en" || tag.startsWith("en-")) {
      return "en";
    }
  }
  return "en";
}

function loadInitial(): LocaleCode {
  if (typeof window === "undefined") return "en";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v && (ALL_LOCALES as readonly string[]).includes(v)) {
      return v as LocaleCode;
    }
  } catch {
    /* localStorage may be disabled (e.g. file:// or private mode) */
  }
  return detectFromBrowser();
}

const initialState: LocaleState = { locale: loadInitial() };

const slice = createSlice({
  name: "locale",
  initialState,
  reducers: {
    setLocale(state, a: PayloadAction<LocaleCode>) {
      state.locale = a.payload;
    },
  },
});

export const { setLocale } = slice.actions;
export default slice.reducer;

/* -------- side-effect helpers ----------------------------------------- *
 *
 * Same shape as applyThemeToDocument: kept as a function rather than
 * middleware so callers can invoke it from a useEffect without ordering
 * pitfalls. Persists to localStorage and updates <html lang> + title.
 * --------------------------------------------------------------------- */

export function persistLocale(locale: LocaleCode): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, locale);
    }
  } catch {
    /* see loadInitial */
  }
  applyLocaleToDocument(locale);
}
