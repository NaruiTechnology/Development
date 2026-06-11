import { useEffect, useMemo, useState } from "react";

import { useAppDispatch } from "../store";
import { useTranslation } from "../i18n";
import { scanAuthHeaders } from "../lib/authIdentity";
import { AuthDialog, type SignedInUser } from "../components/AuthDialog";
import { SettingsDialog } from "../components/SettingsDialog";
import { Icon } from "../components/Icon";
import { MobileActivityReport } from "./MobileActivityReport";
import { closeDialog, openDialog as openSettingsDialog, setActiveTab } from "../store/settingsSlice";

const STORAGE_KEY = "ionbeam:adminUser";
const LAST_LOGIN_KEY = "ionbeam:lastAdminLogin";
const AUDIT_ROLE = 4;

type MobilityRoute = "home" | "reports" | "admin";

export function MobilityApp() {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const [route, setRoute] = useState<MobilityRoute>(() => normalizeRoute(window.location.pathname));
  const [authOpen, setAuthOpen] = useState(false);
  const [signedInUser, setSignedInUser] = useState<SignedInUser | null>(() => readStoredUser());
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const pathname = normalizeMobilityPath(window.location.pathname);
    if (window.location.pathname !== pathname) {
      window.history.replaceState(null, "", pathname);
    }

    function onPopState() {
      setRoute(normalizeRoute(window.location.pathname));
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    document.title = t("mobility.documentTitle");
  }, [t]);

  useEffect(() => {
    const stored = readStoredUser();
    if (!stored?.session_token) {
      setBooting(false);
      return;
    }

    let cancelled = false;
    fetch("/api/admin/iobeam/auth/current-account", {
      cache: "no-store",
      headers: scanAuthHeaders(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as {
          registered?: boolean;
          session_expired?: boolean;
          login?: string;
          user?: SignedInUser | null;
        };
      })
      .then((data) => {
        if (cancelled) return;
        const currentLogin = String(data.login ?? "").toLowerCase();
        const storedLogin = stored.login_name.toLowerCase();
        if (!data.registered || data.session_expired === true || currentLogin !== storedLogin || !data.user) {
          clearStoredUser();
          setSignedInUser(null);
          return;
        }
        setSignedInUser({ ...data.user, session_token: stored.session_token });
      })
      .catch(() => {
        if (!cancelled) setSignedInUser(stored);
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!signedInUser) {
      if (route !== "home") navigateTo("home");
      return;
    }
    if (route === "admin" && signedInUser.role < AUDIT_ROLE) {
      navigateTo("reports");
    }
  }, [route, signedInUser]);

  const isAuditor = Boolean(signedInUser && signedInUser.role >= AUDIT_ROLE);
  const initials = signedInUser?.initials || signedInUser?.login_name.slice(0, 2).toUpperCase() || "GO";

  function navigateTo(nextRoute: MobilityRoute) {
    const nextPath = nextRoute === "home" ? "/mobility" : `/mobility/${nextRoute}`;
    if (window.location.pathname === nextPath) {
      setRoute(nextRoute);
      return;
    }
    window.history.pushState(null, "", nextPath);
    setRoute(nextRoute);
  }

  function handleSignedIn(user: SignedInUser) {
    setSignedInUser(user);
    setAuthOpen(false);
    navigateTo("reports");
  }

  function handleSignOut() {
    clearStoredUser();
    setSignedInUser(null);
    setAuthOpen(false);
    dispatch(closeDialog());
    navigateTo("home");
  }

  function openAdminConsole() {
    dispatch(openSettingsDialog());
    dispatch(setActiveTab("admin"));
  }

  const routeLabel = useMemo(() => {
    if (route === "admin") return t("mobility.admin");
    if (route === "reports") return t("mobility.report");
    return t("mobility.home");
  }, [route, t]);

  return (
    <div className="mobility-shell">
      <div className="mobility-shell__backdrop" aria-hidden />
      <header className="mobility-hero">
        <div className="mobility-brand">
          <div className="mobility-brand__mark">
            <Icon name="atom" tone="accent" />
          </div>
          <div>
            <p className="mobility-kicker">{t("app.brand.name")}</p>
            <h1>{t("mobility.title")}</h1>
            <p className="mobility-copy">{t("mobility.subtitle")}</p>
          </div>
        </div>

        <div className="mobility-hero__status">
          <span className="mobility-pill">{routeLabel}</span>
          <span className={`mobility-auth${signedInUser ? " mobility-auth--signed-in" : ""}`}>
            {signedInUser ? initials : t("mobility.guest")}
          </span>
        </div>
      </header>

      <nav className="mobility-nav" aria-label={t("mobility.navigation")}>
        {([
          ["home", t("mobility.home"), "home"],
          ["reports", t("mobility.report"), "sheet"],
          ["admin", t("mobility.admin"), "cog"],
        ] as const).map(([key, label, icon]) => (
          <button
            key={key}
            type="button"
            className={`mobility-nav__item${route === key ? " mobility-nav__item--active" : ""}`}
            onClick={() => navigateTo(key)}
            disabled={!signedInUser && key !== "home"}
          >
            <Icon name={icon} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <main className="mobility-main">
        {booting ? (
          <section className="mobility-panel">
            <div className="mobility-skeleton">{t("auth.checking")}</div>
          </section>
        ) : !signedInUser ? (
          <section className="mobility-panel mobility-panel--hero">
            <p className="mobility-kicker">{t("auth.title")}</p>
            <h2>{t("mobility.signInPrompt")}</h2>
            <p className="mobility-copy">{t("mobility.signInSupport")}</p>
            <div className="mobility-actions">
              <button type="button" className="mobility-button mobility-button--primary" onClick={() => setAuthOpen(true)}>
                <Icon name="mail" />
                <span>{t("auth.signIn")}</span>
              </button>
              <button type="button" className="mobility-button" onClick={() => setAuthOpen(true)}>
                <Icon name="plus" />
                <span>{t("auth.register")}</span>
              </button>
            </div>
          </section>
        ) : route === "reports" ? (
          <MobileActivityReport />
        ) : route === "admin" ? (
          <section className="mobility-stack">
            <article className="mobility-panel">
              <div className="mobility-panel__header">
                <div>
                  <p className="mobility-kicker">{t("mobility.admin")}</p>
                  <h2>{t("mobility.adminTitle")}</h2>
                </div>
                <span className={`mobility-role${isAuditor ? " mobility-role--auditor" : ""}`}>
                  {isAuditor ? t("mobility.auditor") : t("mobility.privilegeLimited")}
                </span>
              </div>
              <p className="mobility-copy">{t("mobility.adminCopy")}</p>
              <div className="mobility-actions">
                <button type="button" className="mobility-button mobility-button--primary" onClick={openAdminConsole}>
                  <Icon name="tools" />
                  <span>{t("mobility.openAdminConsole")}</span>
                </button>
              </div>
            </article>

            <article className="mobility-panel">
              <div className="mobility-panel__header">
                <div>
                  <p className="mobility-kicker">{t("mobility.account")}</p>
                  <h3>{signedInUser.login_name}</h3>
                </div>
              </div>
              <div className="mobility-detail-grid">
                <Detail label={t("auth.user")} value={signedInUser.login_name} />
                <Detail label={t("auth.site")} value={signedInUser.site} />
                <Detail label={t("mobility.role")} value={String(signedInUser.role)} />
                <Detail label={t("mobility.session")} value={String(signedInUser.session_lifetime_limit_days)} />
              </div>
            </article>
          </section>
        ) : (
          <section className="mobility-stack">
            <article className="mobility-panel mobility-panel--hero">
              <div className="mobility-panel__header">
                <div>
                  <p className="mobility-kicker">{t("mobility.account")}</p>
                  <h2>{signedInUser.login_name}</h2>
                  <p className="mobility-copy">{signedInUser.first_name} {signedInUser.last_name}</p>
                </div>
                <span className={`mobility-role${isAuditor ? " mobility-role--auditor" : ""}`}>
                  {isAuditor ? t("mobility.auditor") : t("mobility.user")}
                </span>
              </div>
              <div className="mobility-detail-grid">
                <Detail label={t("auth.site")} value={signedInUser.site} />
                <Detail label={t("auth.login")} value={signedInUser.login_name} />
                <Detail label={t("mobility.role")} value={String(signedInUser.role)} />
                <Detail label={t("mobility.session")} value={String(signedInUser.session_lifetime_limit_days)} />
              </div>
              <div className="mobility-actions">
                <button type="button" className="mobility-button mobility-button--primary" onClick={() => navigateTo("reports")}>
                  <Icon name="sheet" />
                  <span>{t("mobility.viewReports")}</span>
                </button>
                <button type="button" className="mobility-button" onClick={handleSignOut}>
                  <Icon name="x" />
                  <span>{t("mobility.signOut")}</span>
                </button>
              </div>
            </article>

            {isAuditor && (
              <article className="mobility-panel">
                <div className="mobility-panel__header">
                  <div>
                    <p className="mobility-kicker">{t("mobility.admin")}</p>
                    <h3>{t("mobility.manageData")}</h3>
                  </div>
                </div>
                <p className="mobility-copy">{t("mobility.adminCopy")}</p>
                <div className="mobility-actions">
                  <button type="button" className="mobility-button mobility-button--primary" onClick={openAdminConsole}>
                    <Icon name="cog" />
                    <span>{t("mobility.openAdminConsole")}</span>
                  </button>
                </div>
              </article>
            )}
          </section>
        )}
      </main>

      <footer className="mobility-footer">
        <button type="button" className="mobility-footer__button" onClick={() => setAuthOpen(true)}>
          {signedInUser ? t("auth.signedIn.title") : t("auth.signIn.title")}
        </button>
        {signedInUser && (
          <button type="button" className="mobility-footer__button" onClick={handleSignOut}>
            {t("mobility.signOut")}
          </button>
        )}
      </footer>

      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} onSignedIn={handleSignedIn} />
      <SettingsDialog targetAccountId={null} targetLogin={null} mobilityMode />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="mobility-detail">
      <span className="mobility-detail__label">{label}</span>
      <strong className="mobility-detail__value">{value}</strong>
    </div>
  );
}

function readStoredUser(): SignedInUser | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SignedInUser;
  } catch {
    return null;
  }
}

function clearStoredUser(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(LAST_LOGIN_KEY);
}

function normalizeRoute(pathname: string): MobilityRoute {
  const path = normalizeMobilityPath(pathname);
  if (path.endsWith("/admin")) return "admin";
  if (path.endsWith("/reports") || path.endsWith("/report")) return "reports";
  return "home";
}

function normalizeMobilityPath(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/mobility" || path.startsWith("/mobility/")) return path;
  return "/mobility";
}
