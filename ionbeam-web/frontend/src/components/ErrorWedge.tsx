import { useAppSelector } from "../store";
import { useTranslation } from "../i18n";

export function ErrorWedge() {
  const { t } = useTranslation();
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

  return (
    <div
      className="error-wedge"
      role="alert"
      aria-live="assertive"
      hidden={!message}
    >
      <div className="error-wedge__label">{t("error.label")}</div>
      <div className="error-wedge__message">{message}</div>
    </div>
  );
}
