import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useTranslation, type LocaleCode, type TranslationKey } from "../i18n";
import { siteLabelKey } from "../lib/sites";
import { Icon } from "./Icon";

interface ReportAccount {
  id: number | null;
  login_name: string;
  name: string;
  company_name: string;
  site: string;
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
  equipment_id?: number | null;
  equipment_name?: string;
  login_name: string;
  bucket?: string;
  week_start?: string;
  month_start?: string;
  year_start?: string;
  total_scans: number;
  raster_scans: number;
  vector_scans: number;
  other_activity: number;
}

interface SiteUsage {
  site: string;
  location?: string;
  accounts: number;
  total_scans: number;
  raster_scans: number;
  vector_scans: number;
  last_activity: string | null;
}

interface EquipmentUsage {
  equipment_id: number | null;
  equipment_name: string;
  accounts: number;
  total_scans: number;
  raster_scans: number;
  vector_scans: number;
  other_activity: number;
  last_activity: string | null;
}

interface EquipmentOption {
  id: number | null;
  name: string;
  model?: string;
  serial_number?: string;
}

interface EquipmentResponse {
  ok: boolean;
  equipment: EquipmentOption[];
  error?: string;
}

interface RecentActivity {
  user_id: number;
  login_name: string;
  activity_type: string;
  scan_kind: string;
  site?: string;
  location?: string;
  equipment_id?: number | null;
  equipment_name?: string;
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
  monthly: PeriodUsage[];
  yearly: PeriodUsage[];
  site_groups: SiteUsage[];
  equipment_groups?: EquipmentUsage[];
  geography?: SiteUsage[];
  recent: RecentActivity[];
  error?: string;
}

type PeriodMode = "weekly" | "daily" | "monthly" | "yearly";
type GroupMode = "account" | "site" | "equipment";
type RankingSortMode = "total" | "name" | "raster" | "vector" | "recent";
type ScanMetricKey = "total_scans" | "raster_scans" | "vector_scans" | "other_activity";

interface RankingRow {
  id: string;
  label: string;
  total_scans: number;
  raster_scans: number;
  vector_scans: number;
  other_activity: number;
  last_activity?: string | null;
}

interface UsageTrendRow extends PeriodUsage {
  id: string;
  label: string;
}

function normalizeReport(data: ActivityReportResponse): ActivityReportResponse {
  return {
    ...data,
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    totals: Array.isArray(data.totals) ? data.totals : [],
    daily: Array.isArray(data.daily) ? data.daily : [],
    weekly: Array.isArray(data.weekly) ? data.weekly : [],
    monthly: Array.isArray(data.monthly) ? data.monthly : [],
    yearly: Array.isArray(data.yearly) ? data.yearly : [],
    site_groups: Array.isArray(data.site_groups)
      ? data.site_groups
      : Array.isArray(data.geography)
        ? data.geography.map((row) => ({ ...row, site: row.site ?? row.location ?? "" }))
        : [],
    equipment_groups: Array.isArray(data.equipment_groups) ? data.equipment_groups : [],
    recent: Array.isArray(data.recent) ? data.recent : [],
  };
}

export function ManagementReport({ onBack }: { onBack: () => void }) {
  const { locale, t, fmt } = useTranslation();
  const [accountId, setAccountId] = useState("all");
  const [equipmentId, setEquipmentId] = useState("all");
  const [groupMode, setGroupMode] = useState<GroupMode>("account");
  const [rankingSortMode, setRankingSortMode] = useState<RankingSortMode>("total");
  const [periodMode, setPeriodMode] = useState<PeriodMode>("daily");
  const [equipmentOptions, setEquipmentOptions] = useState<EquipmentOption[]>([]);
  const [report, setReport] = useState<ActivityReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/iobeam/equipment")
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as EquipmentResponse | null;
        if (!r.ok || !data?.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        return Array.isArray(data.equipment) ? data.equipment : [];
      })
      .then((rows) => {
        if (!cancelled) setEquipmentOptions(rows);
      })
      .catch(() => {
        if (!cancelled) setEquipmentOptions([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ days: "90" });
    if (accountId !== "all") params.set("account_id", accountId);
    if (equipmentId !== "all") params.set("equipment_id", equipmentId);

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
        if (!cancelled) setReport(normalizeReport(data));
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
  }, [accountId, equipmentId]);

  const totals = report?.totals ?? [];
  const totalScans = sum(totals, "total_scans");
  const rasterScans = sum(totals, "raster_scans");
  const vectorScans = sum(totals, "vector_scans");
  const otherActivity = sum(totals, "other_activity");
  const activeAccounts = report?.accounts.length ?? 0;
  const accountSiteById = useMemo(() => {
    const map = new Map<number, string>();
    for (const account of report?.accounts ?? []) {
      if (Number.isInteger(account.id)) map.set(account.id as number, account.site);
    }
    return map;
  }, [report]);
  const accountNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const account of report?.accounts ?? []) {
      if (Number.isInteger(account.id)) {
        map.set(account.id as number, account.name || account.login_name);
      }
    }
    return map;
  }, [report]);
  const selectedName = useMemo(() => {
    if (!report || accountId === "all") return t("report.account.all");
    const account = report.accounts.find((a) => String(a.id) === accountId);
    return account?.name || account?.login_name || t("report.account.selected");
  }, [accountId, report, t]);
  const selectedEquipmentName = useMemo(() => {
    if (equipmentId === "all") return t("report.equipment.all");
    const equipment = equipmentOptions.find((row) => String(row.id) === equipmentId);
    return equipmentLabel(equipment) || t("report.equipment.unknown");
  }, [equipmentId, equipmentOptions, t]);
  const siteRows = report?.site_groups ?? [];
  const equipmentRows = report?.equipment_groups ?? [];
  const periodRows = aggregatePeriodRows(
    periodRowsForMode(report, periodMode),
    groupMode,
    accountSiteById,
    accountNameById,
    t,
  );
  const rankingRows = sortRankingRows(
    aggregateRankingRows(totals, equipmentRows, groupMode, accountSiteById, t),
    rankingSortMode,
  );
  const maxPeriod = Math.max(1, ...periodRows.map((row) => row.total_scans));
  const maxSite = Math.max(1, ...siteRows.map((row) => row.total_scans));

  return (
    <main className="management-report">
      <section className="report-hero">
        <div>
          <div className="report-eyebrow">{t("report.eyebrow")}</div>
          <h1>{t("report.title")}</h1>
          <p>{t("report.subtitle", { account: selectedName, equipment: selectedEquipmentName })}</p>
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
          <label className="report-select-field report-select-field--compact">
            <span>{t("report.equipment.label")}</span>
            <select
              className="select"
              value={equipmentId}
              onChange={(event) => setEquipmentId(event.target.value)}
              disabled={loading || equipmentOptions.length === 0}
            >
              <option value="all">{t("report.equipment.all")}</option>
              {equipmentOptions.map((equipment) => (
                <option key={equipment.id ?? equipment.name} value={String(equipment.id)}>
                  {equipmentLabel(equipment)}
                </option>
              ))}
            </select>
          </label>
          <label className="report-select-field report-select-field--compact">
            <span>{t("report.group.label")}</span>
            <select
              className="select"
              value={groupMode}
              onChange={(event) => setGroupMode(event.target.value as GroupMode)}
              disabled={loading}
            >
              <option value="account">{t("report.group.account")}</option>
              <option value="site">{t("report.group.site")}</option>
              <option value="equipment">{t("report.group.equipment")}</option>
            </select>
          </label>
          <label className="report-select-field report-select-field--compact">
            <span>{t("report.sort.label")}</span>
            <select
              className="select"
              value={rankingSortMode}
              onChange={(event) => setRankingSortMode(event.target.value as RankingSortMode)}
              disabled={loading}
            >
              <option value="total">{t("report.sort.total")}</option>
              <option value="name">{rankingHeader(t, groupMode)}</option>
              <option value="raster">{t("report.kind.raster")}</option>
              <option value="vector">{t("report.kind.vector")}</option>
              <option value="recent">{t("report.sort.recent")}</option>
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
          value={fmt(siteRows.length)}
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
          palette={groupMode}
        />

        <div className={`report-panel report-panel--wide report-palette--${periodMode}`}>
          <div className="report-panel__header">
            <div>
              <h2>{t("report.usage.title")}</h2>
              <span>
                {t(periodSubtitleKey(periodMode))}
              </span>
            </div>
            <div className="segmented">
              <button
                type="button"
                aria-pressed={periodMode === "daily"}
                onClick={() => setPeriodMode("daily")}
              >
                {t("report.period.daily")}
              </button>
              <button
                type="button"
                aria-pressed={periodMode === "weekly"}
                onClick={() => setPeriodMode("weekly")}
              >
                {t("report.period.weekly")}
              </button>
              <button
                type="button"
                aria-pressed={periodMode === "monthly"}
                onClick={() => setPeriodMode("monthly")}
              >
                {t("report.period.monthly")}
              </button>
              <button
                type="button"
                aria-pressed={periodMode === "yearly"}
                onClick={() => setPeriodMode("yearly")}
              >
                {t("report.period.yearly")}
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
                  key={row.id}
                  label={row.label}
                  row={row}
                  max={maxPeriod}
                  scansLabel={t("report.unit.scans")}
                  formatNumber={fmt}
                />
              ))
            )}
          </div>
        </div>

        <div className="report-panel report-palette--site">
          <div className="report-panel__header">
            <div>
              <h2>{t("report.geo.title")}</h2>
              <span>{t("report.geo.subtitle")}</span>
            </div>
          </div>
          <div className="geo-list">
            {siteRows.length === 0 ? (
              <div className="report-empty">{t("report.empty.geo")}</div>
            ) : (
              siteRows.map((row) => (
                <div className="geo-row" key={row.site || row.location}>
                  <div>
                    <strong>{siteLabel(t, row.site || row.location)}</strong>
                    <span>{t("report.geo.accounts", { count: fmt(row.accounts) })}</span>
                  </div>
                  <div className="geo-meter" aria-hidden>
                    <span
                      className="geo-meter__raster"
                      style={{ width: `${percent(row.raster_scans, maxSite)}%` }}
                    />
                    <span
                      className="geo-meter__vector"
                      style={{ width: `${percent(row.vector_scans, maxSite)}%` }}
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
              <span>
                {rankingSubtitle(t, groupMode)}
              </span>
            </div>
          </div>
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>{rankingHeader(t, groupMode)}</th>
                  <th>{t("report.kind.raster")}</th>
                  <th>{t("report.kind.vector")}</th>
                  <th>{t("report.table.total")}</th>
                </tr>
              </thead>
              <tbody>
                {rankingRows.length === 0 ? (
                  <tr>
                    <td colSpan={4}>{t("report.empty.accounts")}</td>
                  </tr>
                ) : (
                  rankingRows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.label}</td>
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
                    <small>
                      {formatDateTime(locale, row.date)} · {siteLabel(t, row.site || row.location)} · {row.equipment_name || t("report.equipment.unknown")}
                    </small>
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
  palette,
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
  palette: GroupMode;
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
    <div className={`report-panel report-panel--mix report-palette--${palette}`}>
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
  key: ScanMetricKey
): number {
  return rows.reduce((total, row) => total + row[key], 0);
}

function aggregateRankingRows(
  rows: ReportTotal[],
  equipmentRows: EquipmentUsage[],
  groupMode: GroupMode,
  accountSiteById: Map<number, string>,
  t: ReturnType<typeof useTranslation>["t"],
): RankingRow[] {
  if (groupMode === "account") {
    return rows.map((row) => ({
      id: String(row.user_id),
      label: row.name || row.login_name,
      total_scans: row.total_scans,
      raster_scans: row.raster_scans,
      vector_scans: row.vector_scans,
      other_activity: row.other_activity,
      last_activity: row.last_activity,
    }));
  }

  if (groupMode === "equipment") {
    return equipmentRows.map((row) => ({
      id: String(row.equipment_id ?? row.equipment_name),
      label: row.equipment_name || t("report.equipment.unknown"),
      total_scans: row.total_scans,
      raster_scans: row.raster_scans,
      vector_scans: row.vector_scans,
      other_activity: row.other_activity,
      last_activity: row.last_activity,
    }));
  }

  const grouped = new Map<string, RankingRow>();
  for (const row of rows) {
    const site = accountSiteById.get(row.user_id) ?? "";
    const id = site || "unknown";
    const existing = grouped.get(id) ?? {
      id,
      label: siteLabel(t, site) || t("report.site.unknown"),
      total_scans: 0,
      raster_scans: 0,
      vector_scans: 0,
      other_activity: 0,
      last_activity: null,
    };
    addScanMetrics(existing, row);
    existing.last_activity = latestDate(existing.last_activity, row.last_activity);
    grouped.set(id, existing);
  }

  return [...grouped.values()].sort((a, b) =>
    b.total_scans - a.total_scans || a.label.localeCompare(b.label),
  );
}

function sortRankingRows(rows: RankingRow[], sortMode: RankingSortMode): RankingRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (sortMode === "name") return a.label.localeCompare(b.label);
    if (sortMode === "raster") return b.raster_scans - a.raster_scans || a.label.localeCompare(b.label);
    if (sortMode === "vector") return b.vector_scans - a.vector_scans || a.label.localeCompare(b.label);
    if (sortMode === "recent") {
      return dateMs(b.last_activity) - dateMs(a.last_activity) || a.label.localeCompare(b.label);
    }
    return b.total_scans - a.total_scans || a.label.localeCompare(b.label);
  });
  return sorted;
}

function aggregatePeriodRows(
  rows: PeriodUsage[],
  groupMode: GroupMode,
  accountSiteById: Map<number, string>,
  accountNameById: Map<number, string>,
  t: ReturnType<typeof useTranslation>["t"],
): UsageTrendRow[] {
  const grouped = new Map<string, UsageTrendRow>();
  for (const row of rows) {
    const period = periodLabel(row);
    const group = periodGroup(row, groupMode, accountSiteById, accountNameById, t);
    const id = `${period}-${group.id}`;
    const existing = grouped.get(id) ?? {
      ...row,
      id,
      user_id: 0,
      login_name: "",
      total_scans: 0,
      raster_scans: 0,
      vector_scans: 0,
      other_activity: 0,
      label: `${period} · ${group.label}`,
    };
    addScanMetrics(existing, row);
    grouped.set(id, existing);
  }

  return [...grouped.values()].sort((a, b) =>
    periodLabel(a).localeCompare(periodLabel(b)) || a.label.localeCompare(b.label),
  );
}

function equipmentLabel(equipment: EquipmentOption | undefined): string {
  if (!equipment) return "";
  const details = [equipment.model, equipment.serial_number].filter(Boolean).join(" · ");
  return details ? `${equipment.name} (${details})` : equipment.name;
}

function latestDate(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return dateMs(b) > dateMs(a) ? b : a;
}

function dateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function periodGroup(
  row: PeriodUsage,
  groupMode: GroupMode,
  accountSiteById: Map<number, string>,
  accountNameById: Map<number, string>,
  t: ReturnType<typeof useTranslation>["t"],
): { id: string; label: string } {
  if (groupMode === "account") {
    const accountName = accountNameById.get(row.user_id) ?? row.login_name;
    return { id: `account-${row.user_id}`, label: accountName || t("report.account.selected") };
  }
  if (groupMode === "equipment") {
    const equipmentName = row.equipment_name || t("report.equipment.unknown");
    return { id: `equipment-${row.equipment_id ?? equipmentName}`, label: equipmentName };
  }
  const site = accountSiteById.get(row.user_id) ?? "";
  return { id: `site-${site || "unknown"}`, label: siteLabel(t, site) || t("report.site.unknown") };
}

function addScanMetrics(
  target: Pick<RankingRow, ScanMetricKey>,
  source: Pick<RankingRow, ScanMetricKey>,
): void {
  target.total_scans += source.total_scans;
  target.raster_scans += source.raster_scans;
  target.vector_scans += source.vector_scans;
  target.other_activity += source.other_activity;
}

function periodRowsForMode(
  report: ActivityReportResponse | null,
  mode: PeriodMode,
): PeriodUsage[] {
  if (!report) return [];
  if (mode === "daily") return report.daily;
  if (mode === "monthly") return report.monthly;
  if (mode === "yearly") return report.yearly;
  return report.weekly;
}

function periodSubtitleKey(mode: PeriodMode): TranslationKey {
  if (mode === "daily") return "report.usage.subtitle.daily";
  if (mode === "monthly") return "report.usage.subtitle.monthly";
  if (mode === "yearly") return "report.usage.subtitle.yearly";
  return "report.usage.subtitle.weekly";
}

function rankingSubtitle(
  t: ReturnType<typeof useTranslation>["t"],
  groupMode: GroupMode,
): string {
  if (groupMode === "site") return t("report.ranking.subtitle.site");
  if (groupMode === "equipment") return t("report.ranking.subtitle.equipment");
  return t("report.ranking.subtitle.account");
}

function rankingHeader(
  t: ReturnType<typeof useTranslation>["t"],
  groupMode: GroupMode,
): string {
  if (groupMode === "site") return t("report.table.site");
  if (groupMode === "equipment") return t("report.table.equipment");
  return t("report.table.account");
}

function periodLabel(row: PeriodUsage): string {
  return row.bucket ?? row.week_start ?? row.month_start ?? row.year_start ?? "";
}

function siteLabel(
  t: ReturnType<typeof useTranslation>["t"],
  value: string | undefined,
): string {
  const key = siteLabelKey(value);
  return key ? t(key) : value ?? "";
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
