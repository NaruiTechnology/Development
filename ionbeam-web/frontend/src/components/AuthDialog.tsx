import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../i18n";
import { DEFAULT_SITE, SITE_OPTIONS, normalizeSiteValue } from "../lib/sites";
import { Icon } from "./Icon";

export interface SignedInUser {
  id: number | null;
  login_name: string;
  first_name: string;
  last_name: string;
  email: string;
  site: string;
  role: number;
  is_active: boolean;
  session_lifetime_limit_days: number;
  initials: string;
}

interface SendSmsResponse {
  ok: boolean;
  challenge_id: string;
  phone_number: string;
  mock?: boolean;
  dev_code?: string;
}

interface VerifySmsResponse {
  ok: boolean;
  user: SignedInUser;
}

interface CurrentAccountResponse {
  ok: boolean;
  login: string;
  registered: boolean;
  session_expired?: boolean;
  user: SignedInUser | null;
}

interface RegisterResponse {
  ok: boolean;
  user: SignedInUser;
}

interface RegistrationDraft {
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  company_name: string;
  site: string;
}

export function AuthDialog({
  open,
  onClose,
  onSignedIn,
}: {
  open: boolean;
  onClose: () => void;
  onSignedIn: (user: SignedInUser) => void;
}) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [login, setLogin] = useState("");
  const [mode, setMode] = useState<"loading" | "sign-in" | "register">("loading");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [maskedPhone, setMaskedPhone] = useState("");
  const [devCode, setDevCode] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [registration, setRegistration] = useState<RegistrationDraft>({
    first_name: "",
    last_name: "",
    email: "",
    phone_number: "",
    company_name: "",
    site: DEFAULT_SITE,
  });
  const [site, setSite] = useState<string>(DEFAULT_SITE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMode("loading");
    setBusy(true);
    setError(null);
    setCode("");
    setChallengeId(null);
    setMaskedPhone("");
    setDevCode("");
    setSessionExpired(false);
    setSite(DEFAULT_SITE);

    fetch("/api/admin/iobeam/auth/current-account")
      .then(async (r) => {
        if (!r.ok) throw new Error(await responseError(r));
        return (await r.json()) as CurrentAccountResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setLogin(data.login);
        if (data.user?.site) setSite(normalizeSiteValue(data.user.site));
        setSessionExpired(data.session_expired === true);
        setMode(data.registered ? "sign-in" : "register");
      })
      .catch((err) => {
        if (cancelled) return;
        setMode("sign-in");
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  async function sendSms() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/iobeam/auth/send-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login }),
      });
      if (r.status === 404) {
        setMode("register");
        throw new Error(t("auth.registration.required"));
      }
      if (!r.ok) throw new Error(await responseError(r));
      const data = (await r.json()) as SendSmsResponse;
      setChallengeId(data.challenge_id);
      setMaskedPhone(data.phone_number);
      setDevCode(data.dev_code ?? "");
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function registerAccount() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/iobeam/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login_name: login, ...registration, site }),
      });
      if (!r.ok) throw new Error(await responseError(r));
      await r.json() as RegisterResponse;
      setMode("sign-in");
      await sendSms();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifySms() {
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/iobeam/auth/verify-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: challengeId, code, site }),
      });
      if (!r.ok) throw new Error(await responseError(r));
      const data = (await r.json()) as VerifySmsResponse;
      window.localStorage.setItem("ionbeam:adminUser", JSON.stringify(data.user));
      onSignedIn(data.user);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal auth-modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <div className="modal__title">{t("auth.title")}</div>
          <button
            ref={closeRef}
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label={t("help.close")}
            title={t("help.close")}
            disabled={busy}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="modal__body auth-modal__body">
          {mode === "loading" ? (
            <div className="settings-loading">{t("auth.checking")}</div>
          ) : (
          <>
          <div className="field">
            <label className="label" htmlFor="admin-login">
              {t("auth.login")}
            </label>
            <input
              id="admin-login"
              className="input"
              value={login}
              required
              disabled={busy || Boolean(challengeId)}
              onChange={(e) => setLogin(e.target.value)}
            />
          </div>
          <SiteSelect value={site} disabled={busy} onChange={setSite} label={t("auth.site")} />

          {mode === "register" && (
            <>
              <div className="auth-status">{t("auth.registration.required")}</div>
              <div className="field-row">
                <RegistrationField
                  id="admin-first-name"
                  label={t("auth.registration.firstName")}
                  value={registration.first_name}
                  disabled={busy}
                  onChange={(value) =>
                    setRegistration((draft) => ({ ...draft, first_name: value }))
                  }
                />
                <RegistrationField
                  id="admin-last-name"
                  label={t("auth.registration.lastName")}
                  value={registration.last_name}
                  disabled={busy}
                  onChange={(value) =>
                    setRegistration((draft) => ({ ...draft, last_name: value }))
                  }
                />
              </div>
              <RegistrationField
                id="admin-email"
                label={t("auth.registration.email")}
                value={registration.email}
                disabled={busy}
                type="email"
                onChange={(value) =>
                  setRegistration((draft) => ({ ...draft, email: value }))
                }
              />
              <RegistrationField
                id="admin-phone"
                label={t("auth.registration.phone")}
                value={registration.phone_number}
                disabled={busy}
                type="tel"
                onChange={(value) =>
                  setRegistration((draft) => ({ ...draft, phone_number: value }))
                }
              />
              <RegistrationField
                id="admin-company"
                label={t("auth.registration.company")}
                value={registration.company_name}
                disabled={busy}
                onChange={(value) =>
                  setRegistration((draft) => ({ ...draft, company_name: value }))
                }
              />
            </>
          )}

          {mode === "sign-in" && sessionExpired && !challengeId && (
            <div className="auth-status">{t("auth.sessionExpired")}</div>
          )}

          {challengeId && (
            <div className="field">
              <label className="label" htmlFor="admin-code">
                {t("auth.code")}
              </label>
              <input
                id="admin-code"
                className="input"
                inputMode="numeric"
                value={code}
                disabled={busy}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
          )}

          {maskedPhone && (
            <div className="auth-status">
              {t(devCode ? "auth.sms.sent.mock" : "auth.sms.sent", { phone: maskedPhone })}
              {devCode && <code>{devCode}</code>}
            </div>
          )}
          {error && <div className="auth-error">{error}</div>}

          <div className="settings-footer__row">
            <span className="spacer" />
            {mode === "register" ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || !canRegister(login, registration, site)}
                onClick={() => void registerAccount()}
              >
                <Icon name="check" />
                {t("auth.register")}
              </button>
            ) : !challengeId ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || login.trim().length === 0 || site.trim().length === 0}
                onClick={() => void sendSms()}
              >
                <Icon name="link" />
                {t("auth.sendSms")}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || code.trim().length === 0 || site.trim().length === 0}
                onClick={() => void verifySms()}
              >
                <Icon name="check" />
                {t("auth.verify")}
              </button>
            )}
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

function SiteSelect({
  value,
  disabled,
  label,
  onChange,
}: {
  value: string;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="field">
      <label className="label" htmlFor="admin-site">
        {label}
      </label>
      <select
        id="admin-site"
        className="select"
        value={value}
        required
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {SITE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
    </div>
  );
}

function RegistrationField({
  id,
  label,
  value,
  disabled,
  type = "text",
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  type?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type={type}
        value={value}
        required
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function canRegister(login: string, draft: RegistrationDraft, site: string): boolean {
  return Boolean(
    login.trim() &&
      site.trim() &&
      draft.first_name.trim() &&
      draft.last_name.trim() &&
      draft.email.trim() &&
      draft.phone_number.trim() &&
      draft.company_name.trim()
  );
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const data = JSON.parse(text) as { error?: unknown };
    return String(data.error ?? text);
  } catch {
    return text;
  }
}
