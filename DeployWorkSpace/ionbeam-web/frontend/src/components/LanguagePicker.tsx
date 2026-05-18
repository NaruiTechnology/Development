import { setLocale, persistLocale } from "../store/localeSlice";
import { useAppDispatch, useAppSelector } from "../store";
import {
  ALL_LOCALES,
  LOCALE_NAMES,
  LOCALE_SHORT,
  useTranslation,
  type LocaleCode,
} from "../i18n";

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
      <select
        className="select header-select"
        aria-labelledby="language-picker-label"
        aria-label={t("header.language.title")}
        value={locale}
        title={LOCALE_NAMES[locale]}
        onChange={(event) => pick(event.target.value as LocaleCode)}
      >
        {ALL_LOCALES.map((code) => (
          <option key={code} value={code} title={LOCALE_NAMES[code]} lang={code}>
            {LOCALE_SHORT[code]}
          </option>
        ))}
      </select>
    </div>
  );
}
