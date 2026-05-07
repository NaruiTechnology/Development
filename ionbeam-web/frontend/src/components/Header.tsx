import { useEffect } from "react";

import { fetchStatus, reconnectDevice } from "../store/statusSlice";
import {
  ALL_THEMES,
  applyThemeToDocument,
  setTheme,
  type ThemeName,
} from "../store/themeSlice";
import { useAppDispatch, useAppSelector } from "../store";
import { Icon } from "./Icon";

const STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  busy: "Scanning",
  connecting: "Connecting",
  error: "Error",
  disconnected: "Disconnected",
};

const THEME_LABELS: Record<ThemeName, string> = {
  navy: "Navy",
  black: "Black",
  light: "Light",
};

const THEME_TITLES: Record<ThemeName, string> = {
  navy: "Default Ion Beam navy theme",
  black: "OLED-friendly black theme for low-ambient labs",
  light: "Light theme for daylight monitors",
};

const THEME_ICONS: Record<ThemeName, Parameters<typeof Icon>[0]["name"]> = {
  navy: "layers",
  black: "moon",
  light: "sun",
};

export function Header() {
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.status.service);
  const theme = useAppSelector((s) => s.theme.theme);

  // Apply theme to <html> on every change. Runs on first mount with the
  // hydrated value too, so a page reload restores the persisted choice
  // before the first paint of the body.
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  // Refresh status while idle/error so the pill stays current. We pause it
  // during 'busy' to avoid hammering the FastAPI service mid-scan; the WS
  // 'done' event already updates the UI when a stream completes.
  useEffect(() => {
    dispatch(fetchStatus());
    const t = setInterval(() => {
      const s = status?.state;
      if (s === "busy" || s === "connecting") return;
      dispatch(fetchStatus());
    }, 4000);
    return () => clearInterval(t);
  }, [dispatch, status?.state]);

  const state = status?.state ?? "disconnected";

  return (
    <header className="app-header">
      <div className="app-header__logo">
        <svg viewBox="0 0 64 64" aria-hidden>
          <defs>
            {/* Logo gradient stops are theme variables so the mark adapts
                per-theme without needing a separate SVG per palette. */}
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
          <b>Ion Beam Technology</b>
          <small>Beam Control Console</small>
        </div>
      </div>

      <div className="app-header__spacer" />

      {/* Theme picker — segmented control so the active theme is always
          visible without a click. Persisted to localStorage by the
          themeSlice helper. The visible "Theme" label matches the
          card__title typography used elsewhere (small caps, dim color)
          so this group reads as one labeled control rather than three
          orphan buttons. */}
      <div className="row" style={{ gap: 8 }}>
        <span className="card__title" id="theme-picker-label">Theme</span>
        <div
          className="segmented"
          role="radiogroup"
          aria-labelledby="theme-picker-label"
        >
          {ALL_THEMES.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={theme === t}
              aria-pressed={theme === t}
              className="segmented__btn"
              title={THEME_TITLES[t]}
              onClick={() => dispatch(setTheme(t))}
            >
              <Icon name={THEME_ICONS[t]} tone="accent" />
              {THEME_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <span className="status-pill" data-state={state}>
        {STATE_LABELS[state] ?? state}
      </span>
      <span className="muted mono" style={{ fontSize: 12 }}>
        scans: {status?.scans_completed ?? 0}
      </span>
      <button
        className="btn btn--ghost"
        onClick={() => dispatch(reconnectDevice())}
        title="Drop and re-establish the USB connection (POST /admin/reconnect)"
      >
        <Icon name="refresh" tone="accent" />
        Reconnect
      </button>
    </header>
  );
}
