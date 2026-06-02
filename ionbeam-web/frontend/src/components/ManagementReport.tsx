import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useTranslation, type LocaleCode } from "../i18n";
import { Icon } from "./Icon";

interface ReportAccount {
  id: number | null;
  login_name: string;
  name: string;
  company_name: string;
  role: number;
}

interface ReportTotal {
  user_id: number;
  login_name: string;
  name: string;
  total_scans: number;
  raster_scans: number;
  vector_scans: number;
  other_activity: number;
  last_activity: string | null;
}

interface PeriodUsage {
  user_id: number;
  login_name: string;
  bucket?: string;
  week_start?: string;
  total_scans: number;
  raster_scans: number;
  vector_scans: number;
  other_activity: number;
}

interface GeographyUsage {
  location: string;
  accounts: number;
  total_scans: number;
  raster_scans: number;
  vector_scans: number;
  last_activity: string | null;
}

interface RecentActivity {
  user_id: number;
  login_name: string;
  activity_type: string;
  scan_kind: string;
  location: string;
  date: string;
}

interface ActivityReportResponse {
  ok: boolean;
  generated_at: string;
  days: number;
  selected_account_id: number | null;
  accounts: ReportAccount[];
  totals: ReportTotal[];
  daily: PeriodUsage[];
  weekly: PeriodUsage[];
  geography: GeographyUsage[];
  recent: RecentActivity[];
  error?: string;
}

type PeriodMode = "daily" | "weekly";

export function ManagementReport({ onBack }: { onBack: () => void }) {
  const { locale, t, fmt } = useTranslation();
  const [accountId, setAccountId] = useState("all");
  const [periodMode, setPeriodMode] = useState<PeriodMode>("weekly");
  const [report, setReport] = useState<ActivityReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ days: "90" });
    if (accountId !== "all") params.set("account_id", accountId);

    setLoading(true);
    setError(null);
    fetch(`/api/admin/iobeam/reports/activity?${params}`)
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as ActivityReportResponse | null;
        if (!r.ok || !data?.ok) {
          throw new Error(data?.error || `HTTP ${r.status}`);
        }
        return data;
      })
      .then((data) => {
        if (!cancelled) setReport(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const totals = report?.totals ?? [];
  const totalScans = sum(totals, "total_scans");
  const rasterScans = sum(totals, "raster_scans");
  const vectorScans = sum(totals, "vector_scans");
  const otherActivity = sum(totals, "other_activity");
  const activeAccounts = report?.accounts.length ?? 0;
  const selectedName = useMemo(() => {
    if (!report || accountId === "all") return t("report.account.all");
    const account = report.accounts.find((a) => String(a.id) === accountId);
    return account?.name || account?.login_name || t("report.account.selected");
  }, [accountId, report, t]);
  const periodRows = periodMode === "daily" ? report?.daily ?? [] : report?.weekly ?? [];
  const maxPeriod = Math.max(1, ...periodRows.map((row) => row.total_scans));
  const maxGeo = Math.max(1, ...(report?.geography ?? []).map((row) => row.total_scans));

  return (
    <main className="management-report">
      <section className="report-hero">
        <div>
          <div className="report-eyebrow">{t("report.eyebrow")}</div>
          <h1>{t("report.title")}</h1>
          <p>{t("report.subtitle", { account: selectedName })}</p>
        </div>
        <div className="report-actions">
          <label className="report-select-field">
            <span>{t("report.account.label")}</span>
            <select
              className="select"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              disabled={loading}
            >
              <option value="all">{t("report.account.all")}</option>
              {(report?.accounts ?? []).map((account) => (
                <option key={account.id ?? account.login_name} value={String(account.id)}>
                  {account.name || account.login_name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            <Icon name="scan" tone="accent" />
            {t("report.scanConsole")}
          </button>
        </div>
      </section>

      {error && <div className="report-error">{error}</div>}

      <section className="report-kpis" aria-label={t("report.summary.aria")}>
        <KpiCard
          label={t("report.kpi.total")}
          value={fmt(totalScans)}
          detail={t("report.kpi.activeAccounts", { count: fmt(activeAccounts) })}
        />
        <KpiCard
          label={t("report.kpi.raster")}
          value={fmt(rasterScans)}
          detail={percentLabel(t, rasterScans, totalScans)}
        />
        <KpiCard
          label={t("report.kpi.vector")}
          value={fmt(vectorScans)}
          detail={percentLabel(t, vectorScans, totalScans)}
        />
        <KpiCard
          label={t("report.kpi.geo")}
          value={fmt(report?.geography.length ?? 0)}
          detail={t("report.kpi.geo.detail")}
        />
      </section>

      <section className="report-grid">
        <ScanMixPanel
          total={totalScans}
          raster={rasterScans}
          vector={vectorScans}
          other={otherActivity}
          totalLabel={t("report.chart.total")}
          title={t("report.mix.title")}
          subtitle={t("report.mix.subtitle")}
          rasterLabel={t("report.kind.raster")}
          vectorLabel={t("report.kind.vector")}
          otherLabel={t("report.kind.other")}
          ariaLabel={t("report.mix.aria", {
            raster: Math.round(percent(rasterScans, totalScans)),
            vector: Math.round(percent(vectorScans, totalScans)),
            other: Math.round(Math.max(0, 100 - percent(rasterScans, totalScans) - percent(vectorScans, totalScans))),
          })}
          formatNumber={fmt}
        />

        <div className="report-panel report-panel--wide">
          <div className="report-panel__header">
            <div>
              <h2>{t("report.usage.title")}</h2>
              <span>
                {periodMode === "daily"
                  ? t("report.usage.subtitle.daily")
                  : t("report.usage.subtitle.weekly")}
              </span>
            </div>
            <div className="segmented">
              <button
                type="button"
                aria-pressed={periodMode === "weekly"}
                onClick={() => setPeriodMode("weekly")}
              >
                {t("report.period.weekly")}
              </button>
              <button
                type="button"
                aria-pressed={periodMode === "daily"}
                onClick={() => setPeriodMode("daily")}
              >
                {t("report.period.daily")}
              </button>
            </div>
          </div>
          <div className="usage-chart">
            {loading ? (
              <div className="report-empty">{t("report.loading")}</div>
            ) : periodRows.length === 0 ? (
              <div className="report-empty">{t("report.empty.period")}</div>
            ) : (
              periodRows.slice(-14).map((row) => (
                <UsageBar
                  key={`${row.user_id}-${row.bucket ?? row.week_start}`}
                  label={row.bucket ?? row.week_start ?? ""}
                  row={row}
                  max={maxPeriod}
                  scansLabel={t("report.unit.scans")}
                  formatNumber={fmt}
                />
              ))
            )}
          </div>
        </div>

        <div className="report-panel">
          <div className="report-panel__header">
            <div>
              <h2>{t("report.geo.title")}</h2>
              <span>{t("report.geo.subtitle")}</span>
            </div>
          </div>
          <div className="geo-list">
            {(report?.geography ?? []).length === 0 ? (
              <div className="report-empty">{t("report.empty.geo")}</div>
            ) : (
              (report?.geography ?? []).map((row) => (
                <div className="geo-row" key={row.location}>
                  <div>
                    <strong>{row.location}</strong>
                    <span>{t("report.geo.accounts", { count: fmt(row.accounts) })}</span>
                  </div>
                  <div className="geo-meter" aria-hidden>
                    <span
                      className="geo-meter__raster"
                      style={{ width: `${percent(row.raster_scans, maxGeo)}%` }}
                    />
                    <span
                      className="geo-meter__vector"
                      style={{ width: `${percent(row.vector_scans, maxGeo)}%` }}
                    />
                  </div>
                  <b>{fmt(row.total_scans)}</b>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="report-panel">
          <div className="report-panel__header">
            <div>
              <h2>{t("report.ranking.title")}</h2>
              <span>{t("report.ranking.subtitle")}</span>
            </div>
          </div>
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>{t("report.table.account")}</th>
                  <th>{t("report.kind.raster")}</th>
                  <th>{t("report.kind.vector")}</th>
                  <th>{t("report.table.total")}</th>
                </tr>
              </thead>
              <tbody>
                {totals.length === 0 ? (
                  <tr>
                    <td colSpan={4}>{t("report.empty.accounts")}</td>
                  </tr>
                ) : (
                  totals.map((row) => (
                    <tr key={row.user_id}>
                      <td>{row.name || row.login_name}</td>
                      <td>{fmt(row.raster_scans)}</td>
                      <td>{fmt(row.vector_scans)}</td>
                      <td>{fmt(row.total_scans)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="report-panel">
          <div className="report-panel__header">
            <div>
              <h2>{t("report.recent.title")}</h2>
              <span>{t("report.recent.subtitle")}</span>
            </div>
          </div>
          <div className="recent-list">
            {(report?.recent ?? []).length === 0 ? (
              <div className="report-empty">{t("report.empty.recent")}</div>
            ) : (
              (report?.recent ?? []).slice(0, 10).map((row, index) => (
                <div className="recent-row" key={`${row.user_id}-${row.date}-${index}`}>
                  <span data-kind={row.scan_kind}>{row.scan_kind.toUpperCase()}</span>
                  <div>
                    <strong>{row.login_name}</strong>
                    <small>{formatDateTime(locale, row.date)} · {row.location}</small>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function ScanMixPanel({
  total,
  raster,
  vector,
  other,
  title,
  subtitle,
  totalLabel,
  rasterLabel,
  vectorLabel,
  otherLabel,
  ariaLabel,
  formatNumber,
}: {
  total: number;
  raster: number;
  vector: number;
  other: number;
  title: string;
  subtitle: string;
  totalLabel: string;
  rasterLabel: string;
  vectorLabel: string;
  otherLabel: string;
  ariaLabel: string;
  formatNumber: (n: number) => string;
}) {
  const rasterPct = percent(raster, total);
  const vectorPct = percent(vector, total);
  const otherPct = Math.max(0, 100 - rasterPct - vectorPct);
  const rasterDeg = (rasterPct / 100) * 360;
  const vectorDeg = ((rasterPct + vectorPct) / 100) * 360;
  const pieStyle = {
    "--raster-deg": `${rasterDeg}deg`,
    "--vector-deg": `${vectorDeg}deg`,
  } as CSSProperties;

  return (
    <div className="report-panel report-panel--mix">
      <div className="report-panel__header">
        <div>
          <h2>{title}</h2>
          <span>{subtitle}</span>
        </div>
      </div>
      <div className="mix-chart">
        <div
          className="mix-chart__pie"
          style={pieStyle}
          role="img"
          aria-label={ariaLabel}
        >
          <div>
            <strong>{formatNumber(total)}</strong>
            <span>{totalLabel}</span>
          </div>
        </div>
        <div className="mix-chart__bars">
          <MixBar label={rasterLabel} value={raster} percentValue={rasterPct} kind="raster" formatNumber={formatNumber} />
          <MixBar label={vectorLabel} value={vector} percentValue={vectorPct} kind="vector" formatNumber={formatNumber} />
          <MixBar label={otherLabel} value={other} percentValue={otherPct} kind="other" formatNumber={formatNumber} />
        </div>
      </div>
    </div>
  );
}

function MixBar({
  label,
  value,
  percentValue,
  kind,
  formatNumber,
}: {
  label: string;
  value: number;
  percentValue: number;
  kind: "raster" | "vector" | "other";
  formatNumber: (n: number) => string;
}) {
  return (
    <div className="mix-bar">
      <div>
        <span>{label}</span>
        <b>{formatNumber(value)}</b>
      </div>
      <div className="mix-bar__track" aria-label={`${label}: ${Math.round(percentValue)}%`}>
        <i data-kind={kind} style={{ width: `${percentValue}%` }} />
      </div>
      <small>{Math.round(percentValue)}%</small>
    </div>
  );
}

function KpiCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="kpi-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function UsageBar({
  label,
  row,
  max,
  scansLabel,
  formatNumber,
}: {
  label: string;
  row: PeriodUsage;
  max: number;
  scansLabel: string;
  formatNumber: (n: number) => string;
}) {
  const rasterWidth = (row.raster_scans / max) * 100;
  const vectorWidth = (row.vector_scans / max) * 100;
  return (
    <div className="usage-row">
      <span>{label}</span>
      <div className="usage-row__bar" aria-label={`${label}: ${formatNumber(row.total_scans)} ${scansLabel}`}>
        <i className="usage-row__raster" style={{ width: `${rasterWidth}%` }} />
        <i className="usage-row__vector" style={{ width: `${vectorWidth}%` }} />
      </div>
      <b>{formatNumber(row.total_scans)}</b>
    </div>
  );
}

function sum(
  rows: ReportTotal[],
  key: "total_scans" | "raster_scans" | "vector_scans" | "other_activity"
): number {
  return rows.reduce((total, row) => total + row[key], 0);
}

function percentLabel(
  t: ReturnType<typeof useTranslation>["t"],
  value: number,
  total: number
): string {
  return t("report.percent.scanVolume", { percent: Math.round(percent(value, total)) });
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function formatDateTime(locale: LocaleCode, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
