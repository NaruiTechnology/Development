import { useEffect } from "react";

import { fetchStatus, reconnectDevice } from "../store/statusSlice";
import {
  ALL_THEMES,
  applyThemeToDocument,
  setTheme,
  type ThemeName,
} from "../store/themeSlice";
import { useAppDispatch, useAppSelector } from "../store";
import { useTranslation, type TranslationKey } from "../i18n";
import { Icon } from "./Icon";
import { LanguagePicker } from "./LanguagePicker";

// Per-theme labels and tooltips are now translation KEYS, not the
// literal strings. The keys resolve through t() inside the component
// so a language switch repaints the picker without remounting it.
const THEME_LABEL_KEYS: Record<ThemeName, TranslationKey> = {
  navy: "header.theme.navy",
  black: "header.theme.black",
  light: "header.theme.light",
};

const THEME_TITLE_KEYS: Record<ThemeName, TranslationKey> = {
  navy: "header.theme.navy.title",
  black: "header.theme.black.title",
  light: "header.theme.light.title",
};

// The set of service states is closed; mapping each to its translation
// key here lets t() handle the lookup with type-safe keys instead of an
// indexed object of strings.
const STATE_LABEL_KEYS: Record<string, TranslationKey> = {
  idle: "header.state.idle",
  busy: "header.state.busy",
  connecting: "header.state.connecting",
  error: "header.state.error",
  disconnected: "header.state.disconnected",
};

export function Header() {
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.status.service);
  const theme = useAppSelector((s) => s.theme.theme);
  const { t, fmt } = useTranslation();

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    dispatch(fetchStatus());
    const tHandle = setInterval(() => {
      const s = status?.state;
      if (s === "busy" || s === "connecting") return;
      dispatch(fetchStatus());
    }, 4000);
    return () => clearInterval(tHandle);
  }, [dispatch, status?.state]);

  const state = status?.state ?? "disconnected";
  const stateKey = STATE_LABEL_KEYS[state];

  return (
    <header className="app-header">
      <div className="app-header__logo">
        <svg viewBox="0 0 64 64" aria-hidden>
          <defs>
            <radialGradient id="hg" cx="50%" cy="40%" r="60%">
              <stop offset="0%" stopColor="var(--c-logo-stop-0)" />
              <stop offset="60%" stopColor="var(--c-logo-stop-1)" />
              <stop offset="100%" stopColor="var(--c-logo-stop-2)" />
            </radialGradient>
          </defs>
          <circle cx="32" cy="28" r="14" fill="url(#hg)" />
          <path d="M32 14 L32 50" stroke="var(--c-logo-stroke)" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M22 50 L42 50" stroke="var(--c-logo-stroke)" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        <div className="app-header__title">
          {/* Brand name stays unlocalised — it's a trademark. The
              tagline below is the localised descriptor. */}
          <b>{t("app.brand.name")}</b>
          <small>{t("app.brand.tagline")}</small>
        </div>
      </div>

      <div className="app-header__spacer" />

      {/* Language picker first, then theme picker. Putting language
          first matches the user's mental model: "I want to read the
          UI" comes before "I want it tinted differently". */}
      <LanguagePicker />

      <div className="row" style={{ gap: 8 }}>
        <span className="card__title" id="theme-picker-label">
          {t("header.theme.label")}
        </span>
        <select
          className="select header-select"
          aria-labelledby="theme-picker-label"
          value={theme}
          title={t(THEME_TITLE_KEYS[theme])}
          onChange={(event) => dispatch(setTheme(event.target.value as ThemeName))}
        >
          {ALL_THEMES.map((th) => (
            <option
              key={th}
              value={th}
              title={t(THEME_TITLE_KEYS[th])}
            >
              {t(THEME_LABEL_KEYS[th])}
            </option>
          ))}
        </select>
      </div>

      <span className="status-pill" data-state={state}>
        {stateKey ? t(stateKey) : state}
      </span>
      <span className="muted mono" style={{ fontSize: 12 }}>
        {t("header.scans", { count: fmt(status?.scans_completed ?? 0) })}
      </span>
      <button
        className="btn btn--ghost"
        onClick={() => dispatch(reconnectDevice())}
        title={t("header.reconnect.title")}
      >
        <Icon name="refresh" tone="accent" />
        {t("header.reconnect")}
      </button>
    </header>
  );
}
