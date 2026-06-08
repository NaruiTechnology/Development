import { useEffect, useRef, useState } from "react";

import { fetchDefaultsMetadata, fetchStatus, reconnectDevice } from "../store/statusSlice";
import {
  ALL_THEMES,
  applyThemeToDocument,
  setTheme,
  type ThemeName,
} from "../store/themeSlice";
import {
  openDialog as openSettingsDialog,
} from "../store/settingsSlice";
import { stopAllScanActions } from "../hooks/scanActionRegistry";
import { useAppDispatch, useAppSelector } from "../store";
import { useTranslation, type TranslationKey } from "../i18n";
import { Icon } from "./Icon";
import { LanguagePicker } from "./LanguagePicker";
import { AuthDialog, type SignedInUser } from "./AuthDialog";

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

export function Header({
  signedInUser,
  onSignedIn,
  activeView,
  onOpenReport,
  onOpenScan,
}: {
  signedInUser: SignedInUser | null;
  onSignedIn: (user: SignedInUser) => void;
  activeView: "control" | "report";
  onOpenReport: () => void;
  onOpenScan: () => void;
}) {
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.status.service);
  const fetchingStatus = useAppSelector((s) => s.status.fetching);
  const selectedBeam = useAppSelector((s) => s.status.defaults?.selected_beam);
  const scanPhase = useAppSelector((s) => s.scan.phase);
  const isProduction = useAppSelector((s) => s.status.defaults?.is_production === true);
  const version = useAppSelector((s) => s.status.defaults?.version);
  const theme = useAppSelector((s) => s.theme.theme);
  const { t } = useTranslation();
  const [authOpen, setAuthOpen] = useState(false);
  const authAutoOpenedRef = useRef(false);
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    if (activeView === "report" || signedInUser || authAutoOpenedRef.current) return;
    authAutoOpenedRef.current = true;
    setAuthOpen(true);
  }, [activeView, signedInUser]);

  useEffect(() => {
    dispatch(fetchStatus());
    dispatch(fetchDefaultsMetadata());
    const tHandle = setInterval(() => {
      const s = status?.state;
      if (s === "busy" || s === "connecting") return;
      dispatch(fetchStatus());
      dispatch(fetchDefaultsMetadata());
    }, 4000);
    return () => clearInterval(tHandle);
  }, [dispatch, status?.state]);

  const state = status?.state ?? "disconnected";
  const stateKey = STATE_LABEL_KEYS[state];
  const reconnectDisabled = fetchingStatus || state === "busy" || state === "connecting";
  const beamLabelKey =
    selectedBeam === "ebeam"
      ? "header.beam.ebeam"
      : selectedBeam === "ion"
      ? "header.beam.ion"
      : null;
  const beamTitleKey =
    selectedBeam === "ebeam"
      ? "header.beam.ebeam.title"
      : selectedBeam === "ion"
      ? "header.beam.ion.title"
      : null;
  const beamActive = scanPhase === "running";
  const beamStateLabelKey = beamActive ? "header.beam.on" : "header.beam.off";
  const isSignedIn = Boolean(signedInUser);

  return (
    <>
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
          <div className="app-header__title-row">
            {/* Brand name stays unlocalised — it's a trademark. The
                tagline below is the localised descriptor. */}
            <b>{t("app.brand.name")}</b>
            {version && <span className="version-pill app-header__version">v{version}</span>}
          </div>
          <small>{t("app.brand.tagline")}</small>
        </div>
      </div>

      <div className="app-header__spacer" />

      {/* Language picker first, then theme picker. Putting language
          first matches the user's mental model: "I want to read the
          UI" comes before "I want it tinted differently". */}
      <LanguagePicker />

      {beamLabelKey && beamTitleKey && (
        <span
          className="beam-pill"
          data-beam={selectedBeam}
          data-active={beamActive ? "true" : "false"}
          title={`${t(beamTitleKey)} - ${t(beamStateLabelKey)}`}
        >
          <span className="beam-pill__icon" aria-hidden>
            <Icon name="atom" />
          </span>
          {t(beamLabelKey)}
          <span className="beam-pill__state">{t(beamStateLabelKey)}</span>
        </span>
      )}

      <span className="status-pill" data-state={state}>
        {stateKey ? t(stateKey) : state}
      </span>
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
      <button
        type="button"
        className="btn btn--ghost app-header__icon-button"
        onClick={() => {
          stopAllScanActions();
          if (activeView === "report") onOpenScan();
          else onOpenReport();
        }}
        aria-label={activeView === "report" ? t("header.scan.aria") : t("header.report.aria")}
        title={activeView === "report" ? t("header.scan.title") : t("header.report.title")}
        disabled={!isSignedIn}
      >
        <Icon name={activeView === "report" ? "scan" : "layers"} tone="accent" />
      </button>
      <button
        type="button"
        className="btn btn--ghost app-header__settings"
        onClick={() => {
          stopAllScanActions();
          dispatch(reconnectDevice())
            .unwrap()
            .then(() => {
              dispatch(fetchStatus());
              dispatch(fetchDefaultsMetadata());
            })
            .catch(() => {
              dispatch(fetchStatus());
            });
        }}
        aria-label={t("header.reconnect.aria")}
        title={t("header.reconnect.title")}
        disabled={reconnectDisabled || !isSignedIn}
      >
        <Icon name="link" tone="accent" />
      </button>
      <button
        type="button"
        className="btn btn--ghost app-header__settings"
        onClick={() => {
          stopAllScanActions();
          dispatch(openSettingsDialog());
        }}
        aria-label={t("header.settings.aria")}
        title={t("header.settings.title")}
        disabled={!isSignedIn}
      >
        <Icon name="cog" tone="accent" />
      </button>
      <button
        type="button"
        className="auth-chip"
        onClick={() => setAuthOpen(true)}
        title={signedInUser ? t("auth.signedIn.title") : t("auth.signIn.title")}
      >
        <span className="auth-chip__avatar">
          {signedInUser?.initials || "?"}
        </span>
        <span className="auth-chip__label">
          {signedInUser?.login_name || t("auth.signIn")}
        </span>
      </button>
      <span
        className="production-pill app-header__production"
        data-production={isProduction ? "true" : "false"}
        title={isProduction ? t("header.production.true.title") : t("header.production.false.title")}
      >
        <span className="production-pill__led" />
        {isProduction ? t("header.production.true") : t("header.production.false")}
      </span>
    </header>
    <AuthDialog
      open={authOpen}
      onClose={() => setAuthOpen(false)}
      onSignedIn={onSignedIn}
    />
    </>
  );
}
