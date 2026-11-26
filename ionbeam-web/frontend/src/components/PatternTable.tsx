import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { CustomPatternsCard } from "./CustomPatternsCard";
import { useAppSelector } from "../store";
import { HelpPopover } from "./HelpPopover";
import { useTranslation, type TranslationKey } from "../i18n";

function useTr() {
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => {
    const text = t(key as TranslationKey);
    return text === key ? fallback : text;
  };
  return { tr };
}

/** Sub tabs of the Patterns table: "default" holds the built-in pattern wedges, "custom" is reserved for user-defined ones. */
export type PatternTableTab = "default" | "custom";
const TABS: readonly PatternTableTab[] = ["default", "custom"];

// The strip and the pattern cards render in different parts of the tree, so the selected sub tab lives in a tiny shared store.
let current: PatternTableTab = "default";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const setTab = (tab: PatternTableTab) => { if (tab !== current) { current = tab; listeners.forEach(fn => fn()); } };

export function usePatternTableTab(): PatternTableTab {
  return useSyncExternalStore(subscribe, () => current, () => "default");
}

export function PatternTableTabs() {
  const { tr } = useTr();
  const { t } = useTranslation();
  const tab = usePatternTableTab();
  const limit = useAppSelector(state => state.exposure.millingDriftLimitUm);
  const label = (name: PatternTableTab) => name === "default" ? tr("processing.table.default", "Default") : tr("processing.table.custom", "Advanced");
  return <div className="pattern-table__tabs" role="tablist" aria-label={tr("processing.table.aria", "Pattern table")}>
    {TABS.map((name, i) => <div key={name} className="pattern-table__tab" role="presentation">
      <button type="button" role="tab"
        id={`pattern-table-tab-${name}`} aria-controls="pattern-table-panel"
        aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
        onClick={() => setTab(name)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (i + 1) % TABS.length
            : event.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length
            : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          setTab(TABS[next]);
          event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}>{label(name)}</button>
      {name === "custom" && <HelpPopover title={t("processing.advanced.helpTitle")} ariaLabel={t("processing.advanced.helpTitle")}>
        <ol>
          <li>{t("processing.advanced.helpSize", {limit})}</li>
          <li>{t("processing.advanced.helpResolution")}</li>
          <li>{t("processing.advanced.helpReference")}</li>
          <li>{t("processing.advanced.helpCapture")}</li>
          <li>{t("processing.advanced.helpRetry")}</li>
          <li>{t("processing.advanced.helpCorrection", {limit})}</li>
        </ol>
      </HelpPopover>}
    </div>)}
  </div>;
}

export function PatternTableCustom({ imageAvailable = false, defaultWedges, registrationPanel, onResetPatternCards }: {
  imageAvailable?: boolean; defaultWedges?: ReactNode; registrationPanel?: ReactNode; onResetPatternCards?: () => void;
}) {
  return <CustomPatternsCard imageAvailable={imageAvailable} defaultWedges={defaultWedges}
    registrationPanel={registrationPanel} onResetPatternCards={onResetPatternCards} />;
}
