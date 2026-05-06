import { useAppSelector } from "../store";

export function ErrorWedge() {
  const scanError = useAppSelector((s) => s.scan.errorMessage);
  const service = useAppSelector((s) => s.status.service);
  const statusError = useAppSelector((s) => s.status.lastError);

  const serviceError =
    service?.state === "error" ? service.last_error || "Device connection error" : null;
  const message = scanError || statusError || serviceError;

  return (
    <div
      className="error-wedge"
      role="alert"
      aria-live="assertive"
      hidden={!message}
    >
      <div className="error-wedge__label">Error</div>
      <div className="error-wedge__message">{message}</div>
    </div>
  );
}
