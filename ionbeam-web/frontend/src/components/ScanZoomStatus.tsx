import { useTranslation } from "../i18n";
import type { TranslationKey } from "../i18n";
import type { ScanIssue } from "../lib/scanValidation";

const NUMERIC_PARAMS = new Set(["samples", "limit", "dac", "baseSpan", "span", "need", "max"]);

function issueText(
  issue: ScanIssue,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
  fmt: (n: number) => string,
): string {
  const vars: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(issue.params)) {
    vars[name] = typeof value === "number" && NUMERIC_PARAMS.has(name) ? fmt(value) : value;
  }
  switch (issue.code) {
    case "zoom_exceeds_limit":
      return t(Number(issue.params.region) > 0 ? "scan.zoomError.limit" : "scan.zoomError.limitFull", vars);
    case "pass_exceeds_hardware": return t("scan.zoomError.passHardware", vars);
    case "region_degenerate": return t("scan.zoomError.degenerate", vars);
    case "region_overlap": return t("scan.warn.overlap", vars);
    case "region_duplicate": return t("scan.warn.duplicate", vars);
    case "oversampled":
      return t(Number(issue.params.region) > 0 ? "scan.warn.oversampled" : "scan.warn.oversampledFull", vars);
    case "pass_heavy": return t("scan.warn.heavy", vars);
    case "many_regions": return t("scan.warn.manyRegions", vars);
  }
}

/**
 * Message row above the Zoom control. Normally it shows the allowed maximum
 * ("Max zoom 3 x 1024 x 1024"). When validation fails the technical
 * explanation takes its place and the maximum is hidden.
 */
export function ScanZoomStatus({
  maxZoom,
  resolution,
  issues,
  typedIssue,
  extraError,
}: {
  maxZoom: number;
  resolution: number;
  issues: ScanIssue[];
  /** Zoom the operator typed that was rejected (not applied). */
  typedIssue: ScanIssue | null;
  /** Non-validation error (for example a rejected live geometry update). */
  extraError: string | null;
}) {
  const { t, fmt } = useTranslation();
  const errors = typedIssue ? [typedIssue] : issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning" && issue.code !== "oversampled");
  const errorTexts = [...errors.map((issue) => issueText(issue, t, fmt)), ...(extraError ? [extraError] : [])];
  return (
    <div className="scan-zoom-status">
      {errorTexts.length ? (
        errorTexts.map((text) => (
          <div key={text} role="alert" className="scan-zoom-status__error">{text}</div>
        ))
      ) : (
        <div role="status" className="scan-zoom-status__max">
          {t("scan.zoomMax", { zoom: maxZoom, res: resolution })}
        </div>
      )}
      {warnings.map((issue) => {
        const text = issueText(issue, t, fmt);
        return <div key={text} className="scan-zoom-status__warning">{text}</div>;
      })}
    </div>
  );
}
