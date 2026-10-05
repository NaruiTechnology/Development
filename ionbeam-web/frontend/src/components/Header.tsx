import { useEffect, useRef, useState } from "react";

import { fetchDefaultsMetadata, fetchStatus } from "../store/statusSlice";
import {
  ALL_THEMES,
  applyThemeToDocument,
  setTheme,
  type ThemeName,
} from "../store/themeSlice";
import {
  openDialog as openSettingsDialog,
  restartSettingsServices,
} from "../store/settingsSlice";
import { useAppDispatch, useAppSelector } from "../store";
import { useTranslation, type TranslationKey } from "../i18n";
import { shouldShowVacuumController } from "../lib/vacuumPolicy";
import { Icon } from "./Icon";
import { LanguagePicker } from "./LanguagePicker";
import { AuthDialog, type SignedInUser } from "./AuthDialog";
import sampleStageImage from "../assets/SampleStage.png";
import highVoltageImage from "../assets/HighVoltageTransformer.png";

const BRAND_LOGO_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAFEUlEQVR4nO1YWYhcVRAtq16rccUN3JW4I4LLh5JoIm6gMSQiiF9+atQPv1xAzct0Vc9MkChRIgRCkBBRoqAY45JEXPBHcIG4gMYNzaJGZvpWz6iQmJZz3+tJT3fPZCaZns7IFNyPfvf2u+fUreW8S9RGc5MqBk1Fq1bpsGkCnbRpAp22aQKdtmkCnbZpAp22aQJThYAX6RKaqgTK3XS+m9xJU5FAdTkdEYzf257SUTQVCbjKcjd5ekI3LffQzGAyr7qOZDz/C5rMGg+BUJTbgsm/oUgX0UTbQEqnusmzocgPjfV4K8oPAtRYCAymdGYw2RWUN0809obN+V5X+SmoLAnddNJo6zEfVP6oFAuXjkagmhIj7vPn7U9elDhX/iyo/OMma0I3XTgiCeVXXeUHT+nkkQgEky78Dio7qiup0HYCEUhKSTwFlT2IWzdeHyy5pomAybwIzvjDakqHNxJwTebgHdka6Wq1166ldGwwvqdcLFw14URck2vd5McaKIRCMLkVQOuI7sgBPt9IIJj8ms/tRh4MI9+VXB1MVgXjLf3FwhXULoseUllZA5aP75Dw1ZSODCZL8xDZ20RAZW9O/DX8/jOl45BnwfjzbB1vKKd0Ik2GeVEWImnricDD8GL8rfxOUwgZv5uTW+ImL7jJYP57jys/UTvJSbNYbpXfbDgNgF8cinRBMHl5iJzKS5ANOfh60rvKJbmZOmXRy8r3ucpALQwieJVtwfjhAaPTMFz5EZxQpn347ZzoJ38pnTWpgHc+RUdHEKVkNsIoNjB4VXkjQFVUbgjGrwB843/d+FGcCjyeV7RVbpy68v1ZSCazykrnYY9xgaouoxmDKZ2O0hVM5qOMYbNcq6wJxpuCytdu0t8ULg0DSYiwQHg17oNnyBus2d97gsnfWUXjT1G2Iw6VXhQL4Kuo3ISmCdwEuRA1kCaz3GSBGy+CZ4LKClSMoPyxq2zdFyYjj99TOsZVHGHTSACbuUo5qz6jv8exl8pW7J1hkBXxtCI2WRBPq4dmjlvJDiNblIXx+EEWNVxlT0XlemyIE2wKIeXH0K0RZnkObGwKoQMBdbDW10tnIyFzUG9AYQaTnQA8aHQGRgZediDBkehDXjZeNOnls97KKrcg5oeHAD+eK851CBkMJG9OZHFzyPCGVjnTVoOqdOMnM20UgaAprd5X53lDpSQ39vXS8RhIOld+K0/QVTVZ4XX9wE3umBTwWRXJwiAof+HGDwAk5oLy63XNa6hT10logF0KsYdqEoy3NJzIaiR528BDaAXjrxAe8Gr9HJrSkNpU2RaTvAaslMzOKkmc+w3Cb7hI5PU1reQmP3spmTvh4AescDm8BkHXaj6oFPdpm2ROn9I5NQJI9KhWjTflpzCvyTlWuBKSA2o1NjqVXpwUTYbh4ySYbM/jP43PImDZjVHzeLmHTnCVb1FOR3pXfw+dC/Ax+ZW/hOPaTqBS4ruGPmbqLgSCyS8IiRYXB9u9RKeM9k7kAjqvm3yPvoLC0TYCwfh9V+lDqAx7jk6q/FHjeoQYegCNwWoJ7yrPtUX8eYkujlckJvObgcqLbrJ2rFcx+y3dpWRuo5MO2qLoU3mm1Vww6Qkq3XSoWnUZzQjKH+BzstU8egS0Dh2qVinx3aPdroWi3N6qZB4y5vu5Gq8UC5dh0FS1vlwLdRrH/9M8q+UpSmX22cmbg8k38XoxG173heW151iTrY2yYm18Rym57kCB/AchbrGJAhYTGgAAAABJRU5ErkJggg==";

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
  onOpenVacuum,
  vacuumMinimized,
  vacuumControllerBusy,
  vacuumControllerError,
  onOpenSampleStage,
  sampleStageControllerBusy,
  highVoltagePower,
  highVoltageReady,
  highVoltagePending,
  highVoltageError,
  onToggleHighVoltage,
  scanLocked,
  adcTestActive,
}: {
  signedInUser: SignedInUser | null;
  onSignedIn: (user: SignedInUser) => void;
  activeView: "control" | "report" | "vacuum";
  onOpenReport: () => void;
  onOpenScan: () => void;
  onOpenVacuum: () => void;
  vacuumMinimized: boolean;
  vacuumControllerBusy: boolean;
  vacuumControllerError: boolean;
  onOpenSampleStage: () => void;
  sampleStageControllerBusy: boolean;
  highVoltagePower: boolean;
  highVoltageReady: boolean;
  highVoltagePending: boolean;
  highVoltageError: string | null;
  onToggleHighVoltage: () => void;
  scanLocked: boolean;
  adcTestActive: boolean;
}) {
  const dispatch = useAppDispatch();
  const status = useAppSelector((s) => s.status.service);
  const selectedBeam = useAppSelector((s) => s.status.defaults?.selected_beam);
  const scanPhase = useAppSelector((s) => s.scan.phase);
  const isProduction = useAppSelector((s) => s.status.defaults?.is_production === true);
  const version = useAppSelector((s) => s.status.defaults?.version);
  const reconnecting = useAppSelector((s) => s.settings.saving);
  const theme = useAppSelector((s) => s.theme.theme);
  const { t } = useTranslation();
  const [authOpen, setAuthOpen] = useState(false);
  const authAutoOpenedRef = useRef(false);
  const headerActionDisabled = scanLocked || !signedInUser;
  const vacuumEnabled = status?.vacuum_enabled === true;
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  useEffect(() => {
    if (scanLocked) {
      setAuthOpen(false);
      return;
    }
    if (signedInUser || authAutoOpenedRef.current) return;
    authAutoOpenedRef.current = true;
    setAuthOpen(true);
  }, [activeView, scanLocked, signedInUser]);

  useEffect(() => {
    dispatch(fetchStatus());
    dispatch(fetchDefaultsMetadata());
    const tHandle = setInterval(() => {
      dispatch(fetchStatus());
      dispatch(fetchDefaultsMetadata());
    }, 4000);
    return () => clearInterval(tHandle);
  }, [dispatch]);

  const state = status?.state ?? "disconnected";
  const stateKey = STATE_LABEL_KEYS[state];
  const displayedStateKey = adcTestActive ? "header.state.adcConnecting" : stateKey;
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
        <img className="app-header__logo-image" src={BRAND_LOGO_DATA_URI} alt="laser-beam" />
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
        {displayedStateKey ? t(displayedStateKey) : state}
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
      <div className="app-header__utility-panel">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            if (activeView === "report") onOpenScan();
            else onOpenReport();
          }}
          title={t(activeView === "report" ? "header.scan.title" : "header.dashboard.title")}
          aria-pressed={activeView === "report"}
        >
          <Icon name={activeView === "report" ? "scan" : "layers"} tone="accent" />
          {t(activeView === "report" ? "header.desktop.label" : "header.dashboard.label")}
        </button>
        <button
          type="button"
          className="btn btn--ghost app-header__settings"
          onClick={() => {
            dispatch(restartSettingsServices());
          }}
          aria-label={t("header.reconnect.aria")}
          title={t("header.reconnect.title")}
          disabled={reconnecting || headerActionDisabled}
        >
          <Icon name="link" tone="accent" />
        </button>
        <button
          type="button"
          className="btn btn--ghost app-header__settings"
          onClick={() => {
            dispatch(openSettingsDialog());
          }}
          aria-label={t("header.settings.aria")}
          title={t("header.settings.title")}
          disabled={headerActionDisabled}
        >
          <Icon name="cog" tone="accent" />
        </button>
      </div>
      <div className="app-header__controller-panel">
        {shouldShowVacuumController(vacuumEnabled) && (
          <button
            type="button"
            className={`btn btn--ghost app-header__settings app-header__vacuum${vacuumControllerError ? " app-header__controller--error" : vacuumControllerBusy ? " app-header__controller--busy" : ""}`}
            onClick={onOpenVacuum}
            aria-label={vacuumControllerError ? t("header.vacuum.error") : vacuumMinimized ? t("vacuum.restore") : t("header.vacuum.aria")}
            title={vacuumControllerError ? t("header.vacuum.error") : vacuumMinimized ? t("vacuum.restore") : t("header.vacuum.title")}
            aria-busy={vacuumControllerBusy}
            disabled={headerActionDisabled}
          >
            <Icon name="dashboard" />
            {vacuumControllerError && <span className="app-header__controller-error-badge" aria-hidden>!</span>}
          </button>
        )}
        <button
          type="button"
          className={`btn btn--ghost app-header__settings app-header__sample-stage${sampleStageControllerBusy ? " app-header__controller--busy" : ""}`}
          onClick={onOpenSampleStage}
          aria-label={t("header.sampleStage.aria")}
          title={t("header.sampleStage.title")}
          aria-busy={sampleStageControllerBusy}
          disabled={headerActionDisabled}
        >
          <img src={sampleStageImage} alt="" aria-hidden />
        </button>
          <button
            type="button"
            className={`btn btn--ghost app-header__settings app-header__high-voltage${highVoltagePower ? " app-header__high-voltage--on" : ""}${highVoltagePending ? " app-header__controller--busy" : ""}`}
            onClick={onToggleHighVoltage}
            aria-label={t(highVoltagePower ? "header.highVoltage.turnOff" : "header.highVoltage.turnOn")}
            aria-pressed={highVoltagePower}
            aria-busy={highVoltagePending}
            title={highVoltageError ?? t(highVoltageReady ? (highVoltagePower ? "header.highVoltage.turnOff" : "header.highVoltage.turnOn") : "header.highVoltage.notReady")}
            disabled={headerActionDisabled || !highVoltageReady || highVoltagePending}
          >
            <img src={highVoltageImage} alt="" aria-hidden />
          </button>
      </div>
      <button
        type="button"
        className="auth-chip"
        onClick={() => setAuthOpen(true)}
        title={signedInUser ? t("auth.signedIn.title") : t("auth.signIn.title")}
        disabled={scanLocked}
        aria-disabled={scanLocked}
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
        data-tooltip={isProduction ? t("header.production.true.title") : t("header.production.false.title")}
        aria-label={isProduction ? t("header.production.true") : t("header.production.false")}
        tabIndex={0}
      >
        <span className="production-pill__led" />
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
