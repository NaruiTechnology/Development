import type { TranslationKey } from "../i18n";

export const SITE_OPTIONS = [
  { value: "Beijing(北京)", labelKey: "site.beijing" },
  { value: "Shanghai(上海)", labelKey: "site.shanghai" },
  { value: "Shenzheng(深圳)", labelKey: "site.shenzheng" },
  { value: "Wexi(无锡)", labelKey: "site.wexi" },
  { value: "Xian(西安)", labelKey: "site.xian" },
  { value: "Chengdu(成都)", labelKey: "site.chengdu" },
  { value: "Hangzhou(杭州)", labelKey: "site.hangzhou" },
  { value: "Tianjing(天津)", labelKey: "site.tianjing" },
  { value: "Taixin(泰兴)", labelKey: "site.taixin" },
] as const satisfies ReadonlyArray<{ value: string; labelKey: TranslationKey }>;

export const DEFAULT_SITE = SITE_OPTIONS[0].value;

export function normalizeSiteValue(value: unknown): string {
  const site = String(value ?? "").trim();
  return SITE_OPTIONS.some((option) => option.value === site) ? site : DEFAULT_SITE;
}

export function siteLabelKey(value: unknown): TranslationKey | null {
  const site = String(value ?? "").trim();
  return SITE_OPTIONS.find((option) => option.value === site)?.labelKey ?? null;
}
