import { useState } from "react";
import { useAppSelector } from "../store";
import { useTranslation } from "../i18n";
import { apiUrl } from "../lib/backendUrl";
import { Icon } from "./Icon";
import type { SignedInUser } from "./AuthDialog";

interface AuditorRow {
  email: string;
  is_active?: boolean;
}

interface AdminConfigResponse {
  data?: unknown;
}

export function ErrorWedge({ signedInUser }: { signedInUser: SignedInUser | null }) {
  const { t } = useTranslation();
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const scanError = useAppSelector((s) => s.scan.errorMessage);
  const service = useAppSelector((s) => s.status.service);
  const statusError = useAppSelector((s) => s.status.lastError);

  // Fallback service-error string: the server-supplied message is
  // preferred when present (some failures arrive with detail like
  // "USB device reset"), and only when missing do we fall back to a
  // localised generic.
  const serviceError =
    service?.state === "error"
      ? service.last_error || t("validation.deviceError")
      : null;
  const message = scanError || statusError || serviceError;
  const canRequestScanRole = message === t("scan.permission.required");

  async function requestScanRole() {
    setRequestMessage(null);
    try {
      const recipients = await fetchAuditorEmails();
      if (recipients.length === 0) {
        throw new Error(t("scan.roleRequest.noRecipients"));
      }
      window.location.href = composeRoleRequestMailto(
        recipients,
        signedInUser,
        t("scan.roleRequest.subject"),
        t("scan.roleRequest.body"),
      );
      setRequestMessage(t("scan.roleRequest.opened"));
    } catch (err) {
      setRequestMessage(
        t("scan.roleRequest.failed").replace(
          "{error}",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  return (
    <div
      className="error-wedge"
      role="alert"
      aria-live="assertive"
      hidden={!message}
    >
      <div className="error-wedge__label">{t("error.label")}</div>
      <div className="error-wedge__content">
        <div className="error-wedge__message">{message}</div>
        {requestMessage && <div className="error-wedge__message">{requestMessage}</div>}
        {canRequestScanRole && (
          <button
            type="button"
            className="error-wedge__action"
            onClick={() => void requestScanRole()}
            title={t("scan.roleRequest.title")}
            aria-label={t("scan.roleRequest.title")}
          >
            <Icon name="mail" tone="accent" />
          </button>
        )}
      </div>
    </div>
  );
}

async function fetchAuditorEmails(): Promise<string[]> {
  const r = await fetch(apiUrl("/api/admin/iobeam/config"), { cache: "no-store" });
  if (!r.ok) return [];
  const data = (await r.json().catch(() => null)) as AdminConfigResponse | null;
  const root = data?.data;
  if (!root || typeof root !== "object") return [];
  const record = root as Record<string, unknown>;
  const rawAuditors = Array.isArray(record.auditors)
    ? record.auditors
    : record.auditor && typeof record.auditor === "object"
      ? [record.auditor]
      : [];
  return [
    ...new Set(
      rawAuditors
        .filter((row): row is AuditorRow & Record<string, unknown> => Boolean(row) && typeof row === "object")
        .filter((row) => (typeof row.is_active === "boolean" ? row.is_active : true))
        .map((row) => String(row.email ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function composeRoleRequestMailto(
  recipients: string[],
  user: SignedInUser | null,
  subject: string,
  bodyTemplate: string,
): string {
  const name = user
    ? `${user.first_name} ${user.last_name}`.trim() || user.login_name
    : "(not signed in)";
  const body = bodyTemplate
    .replace("{login}", user?.login_name || "(not signed in)")
    .replace("{name}", name)
    .replace("{email}", user?.email || "(not set)")
    .replace("{site}", user?.site || "(not set)")
    .replace("{currentRole}", String(user?.role ?? 0))
    .replace("{requestedRole}", "SuperUser");
  const mailto = new URL(`mailto:${recipients.join(",")}`);
  mailto.searchParams.set("subject", subject);
  mailto.searchParams.set("body", body);
  return mailto.toString();
}
