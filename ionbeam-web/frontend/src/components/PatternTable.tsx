import { useSyncExternalStore } from "react";
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
  const tab = usePatternTableTab();
  const label = (name: PatternTableTab) => name === "default" ? tr("processing.table.default", "Default") : tr("processing.table.custom", "Custom");
  return <div className="pattern-table__tabs" role="tablist" aria-label={tr("processing.table.aria", "Pattern table")}>
    {TABS.map((name, i) => <button key={name} type="button" role="tab"
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
        (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
      }}>{label(name)}</button>)}
  </div>;
}

export function PatternTableCustom() {
  const { tr } = useTr();
  return <p className="patterns-card__status" role="tabpanel" id="pattern-table-panel" aria-labelledby="pattern-table-tab-custom">
    {tr("processing.table.customEmpty", "No custom patterns yet.")}
  </p>;
}
