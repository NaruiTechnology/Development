import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useTranslation } from "../i18n";
import { scanAuthHeaders } from "../lib/authIdentity";
import { apiUrl } from "../lib/backendUrl";
import { Icon } from "../components/Icon";
import { siteLabelKey } from "../lib/sites";
import type { TranslationKey } from "../i18n";

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

interface ActivityReportResponse {
  ok: boolean;
  data_source?: string;
  generated_at: string;
  days: number;
  selected_account_id: number | null;
  selected_equipment_id: number | null;
  accounts: ReportAccount[];
  totals: ReportTotal[];
  daily: PeriodUsage[];
  weekly: PeriodUsage[];
  monthly: PeriodUsage[];
  yearly: PeriodUsage[];
  site_groups: SiteUsage[];
  equipment_groups?: EquipmentUsage[];
  recent: Array<{
    user_id: number;
    login_name: string;
    activity_type: string;
    scan_kind: string;
    site?: string;
    location?: string;
    equipment_id?: number | null;
    equipment_name?: string;
    date: string;
    update_date?: string;
  }>;
  report_error?: string | null;
  error?: string;
}

type GroupMode = "account" | "site" | "equipment";
type BarTone = "accent" | "good" | "warn";

interface RankedRow {
  id: string;
  label: string;
  total_scans: number;
  raster_scans: number;
  vector_scans: number;
  other_activity: number;
  last_activity?: string | null;
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
    site_groups: Array.isArray(data.site_groups) ? data.site_groups : [],
    equipment_groups: Array.isArray(data.equipment_groups) ? data.equipment_groups : [],
    recent: Array.isArray(data.recent) ? data.recent : [],
  };
}

export function MobileActivityReport({
  defaultAccountId,
}: {
  defaultAccountId?: number | null;
}) {
  const { locale, t, fmt } = useTranslation();
  const [accountId, setAccountId] = useState(() =>
    Number.isInteger(defaultAccountId) && (defaultAccountId ?? 0) > 0
      ? String(defaultAccountId)
      : "all",
  );
  const [equipmentId, setEquipmentId] = useState("all");
  const [groupMode, setGroupMode] = useState<GroupMode>("account");
  const [report, setReport] = useState<ActivityReportResponse | null>(null);
  const [equipmentOptions, setEquipmentOptions] = useState<EquipmentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/admin/iobeam/equipment"), { headers: scanAuthHeaders() })
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as { ok?: boolean; equipment?: EquipmentOption[]; error?: string } | null;
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

    fetch(apiUrl(`/api/admin/iobeam/reports/activity?${params.toString()}`), {
      headers: scanAuthHeaders(),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as ActivityReportResponse | null;
        if (!r.ok || !data?.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        if (data.report_error) throw new Error(data.report_error);
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
  const mixPercentages = useMemo(() => {
    const raster = percent(rasterScans, totalScans);
    const vector = percent(vectorScans, totalScans);
    const other = Math.max(0, 100 - raster - vector);
    return { raster, vector, other };
  }, [rasterScans, totalScans, vectorScans]);
  const mixPieStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--mobility-raster": "#5fb8ff",
        "--mobility-raster-strong": "#2b78c2",
        "--mobility-vector": "#4ade80",
        "--mobility-vector-strong": "#16a34a",
        "--mobility-other": "#facc15",
        "--mobility-other-strong": "#f59e0b",
        "--raster-deg": `${(mixPercentages.raster / 100) * 360}deg`,
        "--vector-deg": `${((mixPercentages.raster + mixPercentages.vector) / 100) * 360}deg`,
      }) as CSSProperties,
    [mixPercentages.raster, mixPercentages.vector],
  );
  const groupRows = useMemo<RankedRow[]>(() => {
    if (!report) return [];
    if (groupMode === "site") {
      return report.site_groups.map((row) => ({
        id: row.site || row.location || "site",
        label: siteLabel(t, row.site || row.location),
        total_scans: row.total_scans,
        raster_scans: row.raster_scans,
        vector_scans: row.vector_scans,
        other_activity: 0,
        last_activity: row.last_activity,
      }));
    }
    if (groupMode === "equipment") {
      return (report.equipment_groups ?? []).map((row) => ({
        id: String(row.equipment_id ?? row.equipment_name),
        label: row.equipment_name || t("mobility.unknownEquipment"),
        total_scans: row.total_scans,
        raster_scans: row.raster_scans,
        vector_scans: row.vector_scans,
        other_activity: row.other_activity,
        last_activity: row.last_activity,
      }));
    }
    return report.totals.map((row) => ({
      id: String(row.user_id),
      label: row.name || row.login_name,
      total_scans: row.total_scans,
      raster_scans: row.raster_scans,
      vector_scans: row.vector_scans,
      other_activity: row.other_activity,
      last_activity: row.last_activity,
    }));
  }, [groupMode, report, t]);

  const rankingRows = [...groupRows].sort((a, b) => b.total_scans - a.total_scans).slice(0, 5);
  const recentRows = report?.recent.slice(0, 8) ?? [];
  const selectedAccountLabel =
    accountId === "all"
      ? t("mobility.allAccounts")
      : report?.accounts.find((row) => String(row.id) === accountId)?.name ||
        report?.accounts.find((row) => String(row.id) === accountId)?.login_name ||
        t("mobility.selectedAccount");
  const selectedEquipmentLabel =
    equipmentId === "all"
      ? t("mobility.allEquipment")
      : equipmentOptions.find((row) => String(row.id) === equipmentId)?.name || t("mobility.selectedEquipment");

  return (
    <section className="mobility-report">
      <header className="mobility-report__header">
        <div>
          <p className="mobility-kicker">{t("mobility.report.eyebrow")}</p>
          <h2>{t("mobility.report.title")}</h2>
          <p className="mobility-copy">
            {selectedAccountLabel} · {selectedEquipmentLabel} · {t("mobility.report.window", { days: 90 })}
          </p>
        </div>

        <div className="mobility-filters" aria-label={t("mobility.report.filters")}>
          <select
            className="mobility-select"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="all">{t("mobility.allAccounts")}</option>
            {report?.accounts.map((account) => (
              <option key={account.id ?? account.login_name} value={String(account.id ?? account.login_name)}>
                {account.name || account.login_name}
              </option>
            ))}
          </select>
          <select
            className="mobility-select"
            value={equipmentId}
            onChange={(event) => setEquipmentId(event.target.value)}
          >
            <option value="all">{t("mobility.allEquipment")}</option>
            {equipmentOptions.map((equipment) => (
              <option key={equipment.id ?? equipment.name} value={String(equipment.id ?? equipment.name)}>
                {equipment.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="mobility-stats" aria-live="polite">
        <MetricCard label={t("report.kpi.total")} value={fmt(totalScans)} tone="accent" />
        <MetricCard label={t("report.kpi.raster")} value={fmt(rasterScans)} tone="good" />
        <MetricCard label={t("report.kpi.vector")} value={fmt(vectorScans)} tone="warn" />
        <MetricCard label={t("report.kpi.activeAccounts")} value={fmt(activeAccounts)} tone="accent" />
      </div>

      <section className="mobility-panel">
        <div className="mobility-panel__header">
          <div>
            <p className="mobility-kicker">{t("mobility.scanMix")}</p>
            <h3>{t("mobility.activityBreakdown")}</h3>
          </div>
          <div className="mobility-segments" role="tablist" aria-label={t("mobility.groupBy")}>
            {(["account", "site", "equipment"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`mobility-chip${groupMode === mode ? " mobility-chip--active" : ""}`}
                onClick={() => setGroupMode(mode)}
              >
                {mode === "account" ? t("report.group.account") : mode === "site" ? t("report.group.site") : t("report.group.equipment")}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="mobility-skeleton">{t("report.loading")}</div>
        ) : error ? (
          <div className="mobility-error">{error}</div>
        ) : (
          <>
            <div
              className="mobility-mix"
              aria-label={t("mobility.scanMix")}
            >
              <div
                className="mobility-mix__pie"
                style={mixPieStyle}
                role="img"
                aria-label={t("report.mix.aria", {
                  raster: Math.round(mixPercentages.raster),
                  vector: Math.round(mixPercentages.vector),
                  other: Math.round(mixPercentages.other),
                })}
              >
                <div>
                  <strong>{fmt(totalScans)}</strong>
                  <span>{t("report.chart.total")}</span>
                </div>
              </div>
              <div className="mobility-mix__legend">
                <MixLegendRow
                  label={t("report.kind.raster")}
                  value={rasterScans}
                  percentValue={mixPercentages.raster}
                  tone="raster"
                  formatNumber={fmt}
                />
                <MixLegendRow
                  label={t("report.kind.vector")}
                  value={vectorScans}
                  percentValue={mixPercentages.vector}
                  tone="vector"
                  formatNumber={fmt}
                />
                <MixLegendRow
                  label={t("report.kind.other")}
                  value={otherActivity}
                  percentValue={mixPercentages.other}
                  tone="other"
                  formatNumber={fmt}
                />
              </div>
            </div>

            <div className="mobility-bars" aria-label={t("mobility.scanMix")}>
              <BarRow label={t("report.kind.raster")} value={rasterScans} total={Math.max(totalScans, 1)} tone="good" />
              <BarRow label={t("report.kind.vector")} value={vectorScans} total={Math.max(totalScans, 1)} tone="accent" />
              <BarRow label={t("report.kind.other")} value={otherActivity} total={Math.max(totalScans, 1)} tone="warn" />
            </div>

            <div className="mobility-ranking">
              {rankingRows.map((row, index) => (
                <article key={row.id} className="mobility-ranking__row">
                  <div className="mobility-ranking__index">{index + 1}</div>
                  <div className="mobility-ranking__body">
                    <div className="mobility-ranking__title">{row.label}</div>
                    <div className="mobility-ranking__meta">
                      {fmt(row.total_scans)} {t("report.unit.scans")} · {row.last_activity ? formatDateTime(locale, row.last_activity) : "—"}
                    </div>
                  </div>
                  <div className="mobility-ranking__value">{fmt(row.total_scans)}</div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="mobility-panel">
        <div className="mobility-panel__header">
          <div>
            <p className="mobility-kicker">{t("report.recent.title")}</p>
            <h3>{t("mobility.recentActivity")}</h3>
          </div>
        </div>
        {loading ? (
          <div className="mobility-skeleton">{t("report.loading")}</div>
        ) : (
          <div className="mobility-activity-list">
            {recentRows.length === 0 ? (
              <div className="mobility-empty">{t("report.empty.recent")}</div>
            ) : (
              recentRows.map((row) => (
                <article key={`${row.date}-${row.user_id}-${row.activity_type}`} className="mobility-activity">
                  <div className="mobility-activity__icon">
                    <Icon name={row.scan_kind === "vector" ? "route" : "grid"} tone="accent" />
                  </div>
                  <div className="mobility-activity__body">
                    <div className="mobility-activity__title">
                      {row.login_name}
                      <span className="mobility-dot" />
                      {row.scan_kind.toUpperCase()}
                    </div>
                    <div className="mobility-activity__meta">
                      {siteLabel(t, row.site || row.location)} · {row.equipment_name || t("report.equipment.unknown")}
                    </div>
                  </div>
                  <time className="mobility-activity__time" dateTime={row.date}>
                    {formatDateTime(locale, row.date)}
                  </time>
                </article>
              ))
            )}
          </div>
        )}
      </section>
    </section>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "accent" | "good" | "warn";
}) {
  return (
    <article className={`mobility-metric mobility-metric--${tone}`}>
      <span className="mobility-metric__label">{label}</span>
      <strong className="mobility-metric__value">{value}</strong>
    </article>
  );
}

function BarRow({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: BarTone;
}) {
  const pct = Math.max(0, Math.min(100, Math.round((value / total) * 100)));
  return (
    <div className="mobility-bar">
      <div className="mobility-bar__head">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="mobility-bar__rail">
        <div className={`mobility-bar__fill mobility-bar__fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MixLegendRow({
  label,
  value,
  percentValue,
  tone,
  formatNumber,
}: {
  label: string;
  value: number;
  percentValue: number;
  tone: "raster" | "vector" | "other";
  formatNumber: (n: number) => string;
}) {
  return (
    <div className="mobility-mix__legend-row">
      <div className="mobility-mix__legend-head">
        <span className="mobility-mix__swatch" data-tone={tone} />
        <span>{label}</span>
      </div>
      <strong>{formatNumber(value)}</strong>
      <small>{Math.round(percentValue)}%</small>
    </div>
  );
}

function siteLabel(t: (key: TranslationKey, vars?: Record<string, string | number>) => string, value: unknown): string {
  const key = siteLabelKey(value);
  return key ? t(key) : String(value ?? "");
}

function formatDateTime(locale: string, value: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function sum(rows: unknown[], key: string): number {
  return rows.reduce<number>(
    (acc, row) => acc + Number((row as Record<string, unknown>)[key] ?? 0),
    0,
  );
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}
