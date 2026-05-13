/**
 * Language picker — segmented control. Mirrors the theme picker
 * intentionally:
 *   - Same .segmented / .segmented__btn classes (no new CSS).
 *   - Same label-then-control pattern (`card__title` + radiogroup).
 *   - Buttons show locale short label + the language's own name in
 *     its native form for the title tooltip.
 *
 * Why not a <select>?
 * -------------------
 * The theme picker has three options and is a visual segmented control
 * because the active option is meaningful at a glance — "what theme am
 * I on?" gets answered without a click. Language has the same property:
 * three options, exactly one active, picking the wrong one is a common
 * mistake to recover from. A select hides the current value behind a
 * click; a segmented control surfaces it. The cost is exactly one row
 * in the header, which we have room for.
 */
import { setLocale, persistLocale } from "../store/localeSlice";
import { useAppDispatch, useAppSelector } from "../store";
import {
  ALL_LOCALES,
  LOCALE_NAMES,
  LOCALE_SHORT,
  useTranslation,
  type LocaleCode,
} from "../i18n";
import { Icon } from "./Icon";

export function LanguagePicker() {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const locale = useAppSelector((s) => s.locale.locale);

  function pick(next: LocaleCode) {
    if (next === locale) return;
    dispatch(setLocale(next));
    // Apply to <html lang> + document.title immediately so screen
    // readers and OS-level locale-aware features (right-click
    // dictionary lookup, etc.) pick up the new language without
    // waiting for a useEffect to fire on the next render.
    persistLocale(next);
  }

  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="card__title" id="language-picker-label">
        {t("header.language.label")}
      </span>
      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby="language-picker-label"
        aria-label={t("header.language.title")}
      >
        {ALL_LOCALES.map((code) => {
          const active = locale === code;
          return (
            <button
              key={code}
              type="button"
              role="radio"
              aria-checked={active}
              aria-pressed={active}
              className="segmented__btn"
              // Title shows the locale's own native name (always
              // readable to the speaker, even when the rest of the
              // UI is in a language they don't know yet).
              title={LOCALE_NAMES[code]}
              lang={code}
              onClick={() => pick(code)}
            >
              {code === "en" ? (
                <Icon name="globe" tone="accent" />
              ) : null}
              {LOCALE_SHORT[code]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
