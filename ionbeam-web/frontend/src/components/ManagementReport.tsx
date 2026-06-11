import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useTranslation, type LocaleCode, type TranslationKey } from "../i18n";
import { scanAuthHeaders } from "../lib/authIdentity";
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
  data_source?: string;
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
  report_error?: string | null;
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

interface ReportExportContext {
  generatedAt: string;
  accountLabel: string;
  equipmentLabel: string;
  groupMode: GroupMode;
  rankingSortMode: RankingSortMode;
  periodMode: PeriodMode;
  totalScans: number;
  rasterScans: number;
  vectorScans: number;
  otherActivity: number;
  activeAccounts: number;
  selectedAccountId: string;
  selectedEquipmentId: string;
  periodRows: UsageTrendRow[];
  siteRows: SiteUsage[];
  rankingRows: RankingRow[];
  recentRows: RecentActivity[];
  reportTitle: string;
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
  const [cleanupState, setCleanupState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);

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
        if (data.report_error) {
          throw new Error(data.report_error);
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
  const reportSourceLabel =
    report?.data_source === "remote_db"
      ? t("report.source.remoteDb")
      : report?.data_source === "local_db"
        ? t("report.source.localDb")
        : report?.data_source || t("report.source.unknown");
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
  const exportContext: ReportExportContext | null = report
    ? {
        generatedAt: report.generated_at,
        accountLabel: selectedName,
        equipmentLabel: selectedEquipmentName,
        groupMode,
        rankingSortMode,
        periodMode,
        totalScans,
        rasterScans,
        vectorScans,
        otherActivity,
        activeAccounts,
        selectedAccountId: accountId,
        selectedEquipmentId: equipmentId,
        periodRows,
        siteRows,
        rankingRows,
        recentRows: report.recent,
        reportTitle: t("report.title"),
      }
    : null;

  function onExportPdf() {
    if (!exportContext) return;
    downloadBlob(
      createReportPdfBlob(exportContext, t, fmt, locale),
      buildReportExportFilename("pdf", exportContext),
    );
  }

  function onExportExcel() {
    if (!exportContext) return;
    downloadBlob(
      createReportWorkbookBlob(exportContext, t, locale),
      buildReportExportFilename("csv", exportContext),
    );
  }

  async function onCleanupDuplicates() {
    if (cleanupState === "running") return;
    setCleanupState("running");
    setCleanupMessage(null);
    try {
      const r = await fetch("/api/admin/iobeam/activity/dedupe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...scanAuthHeaders() },
      });
      const data = (await r.json().catch(() => null)) as { ok?: boolean; deleted?: number; error?: string } | null;
      if (!r.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      setCleanupState("done");
      setCleanupMessage(t("report.cleanup.done", { count: data.deleted ?? 0 }));
    } catch (err) {
      setCleanupState("error");
      setCleanupMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="management-report">
      <section className="report-hero">
        <div>
          <div className="report-eyebrow">{t("report.eyebrow")}</div>
          <h1>{t("report.title")}</h1>
          <p>{t("report.subtitle", { account: selectedName, equipment: selectedEquipmentName })}</p>
          <div className="report-source-row">
            <div className="report-source" aria-label={t("report.source.label")}>
              <span>{t("report.source.label")}</span>
              <strong>{reportSourceLabel}</strong>
            </div>
            <button
              type="button"
              className="btn btn--ghost report-cleanup-btn"
              onClick={onCleanupDuplicates}
              disabled={cleanupState === "running"}
              title={t("report.cleanup.title")}
            >
              {t("report.cleanup.action")}
            </button>
          </div>
          {cleanupMessage && (
            <div
              className={`report-cleanup-status report-cleanup-status--${cleanupState}`}
              role={cleanupState === "error" ? "alert" : "status"}
            >
              {cleanupMessage}
            </div>
          )}
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
          <button
            type="button"
            className="btn btn--logo"
            onClick={onExportPdf}
            disabled={loading || report === null}
            aria-label={t("report.export.pdf")}
            title={t("report.export.pdf")}
          >
            <Icon name="fileText" />
          </button>
          <button
            type="button"
            className="btn btn--logo"
            onClick={onExportExcel}
            disabled={loading || report === null}
            aria-label={t("report.export.csv")}
            title={t("report.export.csv")}
          >
            <Icon name="sheet" />
          </button>
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

function buildReportExportFilename(kind: "pdf" | "csv", context: ReportExportContext): string {
  const stamp = new Date(context.generatedAt);
  const safeStamp = Number.isNaN(stamp.getTime())
    ? "export"
    : stamp.toISOString().slice(0, 10);
  const suffix = kind === "pdf" ? "pdf" : "csv";
  return `management-report-${safeStamp}.${suffix}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createReportPdfBlob(
  context: ReportExportContext,
  t: ReturnType<typeof useTranslation>["t"],
  fmt: ReturnType<typeof useTranslation>["fmt"],
  locale: LocaleCode,
): Blob {
  const lines = buildReportExportLines(context, t, fmt, locale).flatMap((line) =>
    wrapExportLine(line, 94),
  );
  const pages = chunkArray(lines, 44);
  return new Blob([createPdfDocument(pages)], { type: "application/pdf" });
}

function createReportWorkbookBlob(
  context: ReportExportContext,
  t: ReturnType<typeof useTranslation>["t"],
  locale: LocaleCode,
): Blob {
  const csv = buildReportCsv(context, t, locale);
  return new Blob([csv], { type: "text/csv;charset=utf-8" });
}

function buildReportExportLines(
  context: ReportExportContext,
  t: ReturnType<typeof useTranslation>["t"],
  fmt: ReturnType<typeof useTranslation>["fmt"],
  locale: LocaleCode,
): string[] {
  const lines: string[] = [];
  lines.push(context.reportTitle);
  lines.push(`Generated: ${formatDateTime(locale, context.generatedAt)}`);
  lines.push(`Account: ${context.accountLabel}`);
  lines.push(`Equipment: ${context.equipmentLabel}`);
  lines.push(`Group by: ${t(reportGroupLabelKey(context.groupMode))}`);
  lines.push(`Sort by: ${t(reportSortLabelKey(context.rankingSortMode))}`);
  lines.push(`Period: ${t(periodSubtitleKey(context.periodMode))}`);
  lines.push("");
  lines.push("Summary");
  lines.push(`Total scans: ${fmt(context.totalScans)}`);
  lines.push(`Raster scans: ${fmt(context.rasterScans)}`);
  lines.push(`Vector scans: ${fmt(context.vectorScans)}`);
  lines.push(`Other activity: ${fmt(context.otherActivity)}`);
  lines.push(`Active accounts: ${fmt(context.activeAccounts)}`);
  lines.push(`Site groups: ${fmt(context.siteRows.length)}`);
  lines.push("");
  lines.push("Ranking");
  lines.push("Label | Raster | Vector | Total | Other | Last activity");
  for (const row of context.rankingRows) {
    lines.push(
      `${row.label} | ${fmt(row.raster_scans)} | ${fmt(row.vector_scans)} | ${fmt(row.total_scans)} | ${fmt(row.other_activity)} | ${row.last_activity ? formatDateTime(locale, row.last_activity) : "-"}`,
    );
  }
  lines.push("");
  lines.push("Sites");
  lines.push("Site | Accounts | Raster | Vector | Total | Last activity");
  for (const row of context.siteRows) {
    lines.push(
      `${siteLabel(t, row.site || row.location)} | ${fmt(row.accounts)} | ${fmt(row.raster_scans)} | ${fmt(row.vector_scans)} | ${fmt(row.total_scans)} | ${row.last_activity ? formatDateTime(locale, row.last_activity) : "-"}`,
    );
  }
  lines.push("");
  lines.push("Period Trend");
  lines.push("Bucket | Total | Raster | Vector | Other");
  for (const row of context.periodRows) {
    lines.push(
      `${row.label} | ${fmt(row.total_scans)} | ${fmt(row.raster_scans)} | ${fmt(row.vector_scans)} | ${fmt(row.other_activity)}`,
    );
  }
  lines.push("");
  lines.push("Recent Activity");
  lines.push("Date | User | Site | Equipment | Kind");
  for (const row of context.recentRows) {
    lines.push(
      `${formatDateTime(locale, row.date)} | ${row.login_name} | ${siteLabel(t, row.site || row.location)} | ${row.equipment_name || t("report.equipment.unknown")} | ${row.scan_kind.toUpperCase()}`,
    );
  }
  return lines;
}

function buildReportCsv(
  context: ReportExportContext,
  t: ReturnType<typeof useTranslation>["t"],
  locale: LocaleCode,
): string {
  const rows: string[][] = [];
  rows.push([context.reportTitle]);
  rows.push([`Generated`, formatDateTime(locale, context.generatedAt)]);
  rows.push([`Account`, context.accountLabel]);
  rows.push([`Equipment`, context.equipmentLabel]);
  rows.push([`Group by`, t(reportGroupLabelKey(context.groupMode))]);
  rows.push([`Sort by`, t(reportSortLabelKey(context.rankingSortMode))]);
  rows.push([`Period`, t(periodSubtitleKey(context.periodMode))]);
  rows.push([]);
  rows.push([`Summary`]);
  rows.push([`Total scans`, String(context.totalScans)]);
  rows.push([`Raster scans`, String(context.rasterScans)]);
  rows.push([`Vector scans`, String(context.vectorScans)]);
  rows.push([`Other activity`, String(context.otherActivity)]);
  rows.push([`Active accounts`, String(context.activeAccounts)]);
  rows.push([`Site groups`, String(context.siteRows.length)]);
  rows.push([]);
  rows.push([`Ranking`]);
  rows.push([`Label`, `Raster`, `Vector`, `Total`, `Other`, `Last activity`]);
  for (const row of context.rankingRows) {
    rows.push([
      row.label,
      String(row.raster_scans),
      String(row.vector_scans),
      String(row.total_scans),
      String(row.other_activity),
      row.last_activity ? formatDateTime(locale, row.last_activity) : "",
    ]);
  }
  rows.push([]);
  rows.push([`Sites`]);
  rows.push([`Site`, `Accounts`, `Raster`, `Vector`, `Total`, `Last activity`]);
  for (const row of context.siteRows) {
    rows.push([
      siteLabel(t, row.site || row.location),
      String(row.accounts),
      String(row.raster_scans),
      String(row.vector_scans),
      String(row.total_scans),
      row.last_activity ? formatDateTime(locale, row.last_activity) : "",
    ]);
  }
  rows.push([]);
  rows.push([`Period Trend`]);
  rows.push([`Bucket`, `Total`, `Raster`, `Vector`, `Other`]);
  for (const row of context.periodRows) {
    rows.push([
      row.label,
      String(row.total_scans),
      String(row.raster_scans),
      String(row.vector_scans),
      String(row.other_activity),
    ]);
  }
  rows.push([]);
  rows.push([`Recent Activity`]);
  rows.push([`Date`, `User`, `Site`, `Equipment`, `Kind`]);
  for (const row of context.recentRows) {
    rows.push([
      formatDateTime(locale, row.date),
      row.login_name,
      siteLabel(t, row.site || row.location),
      row.equipment_name || t("report.equipment.unknown"),
      row.scan_kind.toUpperCase(),
    ]);
  }
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function createPdfDocument(pages: string[][]): string {
  const encoder = new TextEncoder();
  const byteLength = (value: string) => encoder.encode(value).length;
  const fontObjectId = 1;
  const contentStartId = 2;
  const pageStartId = contentStartId + pages.length;
  const pagesObjectId = pageStartId + pages.length;
  const catalogObjectId = pagesObjectId + 1;

  const objects: Array<{ id: number; body: string }> = [];
  objects.push({
    id: fontObjectId,
    body: "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
  });

  pages.forEach((pageLines, index) => {
    const content = createPdfContentStream(pageLines, index + 1, pages.length);
    const contentObjectId = contentStartId + index;
    const contentLength = encoder.encode(content).length;
    objects.push({
      id: contentObjectId,
      body: `<< /Length ${contentLength} >>\nstream\n${content}\nendstream`,
    });
  });

  pages.forEach((_pageLines, index) => {
    const pageObjectId = pageStartId + index;
    const contentObjectId = contentStartId + index;
    objects.push({
      id: pageObjectId,
      body: [
        "<< /Type /Page",
        ` /Parent ${pagesObjectId} 0 R`,
        " /MediaBox [0 0 612 792]",
        ` /Resources << /Font << /F1 ${fontObjectId} 0 R >> >>`,
        ` /Contents ${contentObjectId} 0 R >>`,
      ].join(""),
    });
  });

  objects.push({
    id: pagesObjectId,
    body: `<< /Type /Pages /Kids [${pages
      .map((_pageLines, index) => `${pageStartId + index} 0 R`)
      .join(" ")}] /Count ${pages.length} >>`,
  });

  objects.push({
    id: catalogObjectId,
    body: `<< /Type /Catalog /Pages ${pagesObjectId} 0 R >>`,
  });

  objects.sort((a, b) => a.id - b.id);

  const header = "%PDF-1.4\n";
  const chunks = [header];
  const offsets = [0];
  let length = byteLength(header);
  for (const object of objects) {
    const chunk = `${object.id} 0 obj\n${object.body}\nendobj\n`;
    offsets.push(length);
    chunks.push(chunk);
    length += byteLength(chunk);
  }
  const xrefOffset = length;
  const xrefLines = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root ${catalogObjectId} 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
  ];
  return chunks.join("") + xrefLines.join("\n");
}

function createPdfContentStream(pageLines: string[], pageNumber: number, pageCount: number): string {
  const lines = [
    `Report export${pageCount > 1 ? ` (${pageNumber}/${pageCount})` : ""}`,
    ...pageLines,
  ];
  const pageText = lines.map(escapePdfText);
  return [
    "BT",
    "/F1 10 Tf",
    "14 TL",
    "50 760 Td",
    ...pageText.map((line, index) => (index === 0 ? `(${line}) Tj` : `T* (${line}) Tj`)),
    "ET",
  ].join("\n");
}

function reportGroupLabelKey(groupMode: GroupMode): TranslationKey {
  if (groupMode === "site") return "report.group.site";
  if (groupMode === "equipment") return "report.group.equipment";
  return "report.group.account";
}

function reportSortLabelKey(sortMode: RankingSortMode): TranslationKey {
  if (sortMode === "name") return "report.sort.name";
  if (sortMode === "raster") return "report.kind.raster";
  if (sortMode === "vector") return "report.kind.vector";
  if (sortMode === "recent") return "report.sort.recent";
  return "report.sort.total";
}

function wrapExportLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const words = line.split(/\s+/);
  const wrapped: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((current + " " + word).length <= width) {
      current += ` ${word}`;
    } else {
      wrapped.push(current);
      current = word;
    }
  }
  if (current) wrapped.push(current);
  return wrapped.length > 0 ? wrapped : [line];
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function escapeCsvCell(value: string): string {
  if (/["\n,\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
