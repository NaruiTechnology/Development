/** PATTERNS > Custom: tile picker over the ionbeam_asset.CustomPatterns image catalogue. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { customPatternApi, type CustomPattern } from "../lib/customPatternApi";
import { Icon } from "./Icon";
import { LoadingSpinner } from "./LoadingSpinner";
import { NumberStepperInput } from "./NumberStepperField";
import { useTranslation, type TranslationKey } from "../i18n";

// Pattern confirmed with the Select button. Shared so other Patterns components can consume it.
let confirmed: CustomPattern | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const confirmCustomPattern = (pattern: CustomPattern | null) => { confirmed = pattern; listeners.forEach(fn => fn()); };
export const useConfirmedCustomPattern = () => useSyncExternalStore(subscribe, () => confirmed, () => null);

export interface CustomPatternMatch {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}
export interface CustomPatternMatchState {
  requestId: number;
  pattern: CustomPattern | null;
  threshold: number;
  status: "idle" | "matching" | "complete" | "error";
  matches: CustomPatternMatch[];
  error: string | null;
}
let matchState: CustomPatternMatchState = { requestId: 0, pattern: null, threshold: 0.9, status: "idle", matches: [], error: null };
const matchListeners = new Set<() => void>();
const subscribeMatch = (fn: () => void) => { matchListeners.add(fn); return () => { matchListeners.delete(fn); }; };
const publishMatch = () => matchListeners.forEach(fn => fn());
export const requestCustomPatternMatch = (pattern: CustomPattern, threshold = 0.9) => {
  matchState = { requestId: matchState.requestId + 1, pattern, threshold, status: "matching", matches: [], error: null };
  publishMatch();
  return matchState.requestId;
};
export const finishCustomPatternMatch = (requestId: number, matches: CustomPatternMatch[], error: string | null = null) => {
  if (matchState.requestId !== requestId) return;
  matchState = { ...matchState, status: error ? "error" : "complete", matches, error };
  publishMatch();
};
export const resetCustomPatternMatch = () => {
  confirmed = null;
  matchState = { requestId: matchState.requestId + 1, pattern: null, threshold: 0.9, status: "idle", matches: [], error: null };
  listeners.forEach(fn => fn());
  publishMatch();
};
export const useCustomPatternMatchState = () => useSyncExternalStore(subscribeMatch, () => matchState, () => matchState);

export function CustomPatternsCard({ onSelect, imageAvailable = false }: { onSelect?: (pattern: CustomPattern) => void; imageAvailable?: boolean }) {
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => { const text = t(key as TranslationKey); return text === key ? fallback : text; };
  const [collapsed, setCollapsed] = useState(false);
  const [rows, setRows] = useState<CustomPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const [matchThreshold, setMatchThreshold] = useState("90");
  const confirmedPattern = useConfirmedCustomPattern();
  const match = useCustomPatternMatchState();
  const title = tr("processing.customPatterns.title", "Custom patterns");

  useEffect(() => {
    let cancelled = false;
    customPatternApi.list()
      .then(result => { if (!cancelled) { setRows(result.patterns); setError(null); } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const highlighted = rows.find(row => row.id === highlightedId) ?? null;
  const matchThresholdValue = () => {
    const parsed = Number(matchThreshold);
    return Number.isFinite(parsed) ? Math.max(10, Math.min(100, Math.round(parsed))) : 90;
  };
  const normalizeMatchThreshold = () => setMatchThreshold(String(matchThresholdValue()));
  const select = () => {
    if (!highlighted || !imageAvailable) return;
    const threshold = matchThresholdValue();
    setMatchThreshold(String(threshold));
    confirmCustomPattern(highlighted);
    requestCustomPatternMatch(highlighted, threshold / 100);
    onSelect?.(highlighted);
  };

  return <div className="card custom-patterns-card" id="pattern-table-panel" role="tabpanel" aria-labelledby="pattern-table-tab-custom">
    <div className="card__header">
      <span className="card__title">{title}</span>
      <button type="button" className="card__collapse-btn" aria-expanded={!collapsed}
        aria-label={`${title}: ${t(collapsed ? "controls.expand" : "controls.collapse")}`}
        title={t(collapsed ? "controls.expand" : "controls.collapse")}
        onClick={() => setCollapsed(value => !value)}>
        <Icon name="chevronDown" />
      </button>
    </div>
    <div className="card__body custom-patterns-card__body" hidden={collapsed}>
      {loading && <LoadingSpinner label={tr("settings.admin.customPatterns.loading", "Loading custom patterns…")} />}
      {error && <p className="patterns-card__status patterns-card__status--error" role="alert">{error}</p>}
      {!loading && !error && rows.length === 0 && <p className="patterns-card__status">{tr("processing.table.customEmpty", "No custom patterns yet.")}</p>}
      <div className="custom-pattern-match-row">
        <div className="custom-pattern-match-threshold" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) normalizeMatchThreshold();
        }}>
          <span>{tr("processing.customPatterns.matchThreshold", "Match range")}</span>
          <div className="custom-pattern-match-number">
            <NumberStepperInput value={matchThreshold} min={10} max={100} step={1} inputMode="numeric"
              ariaLabel={tr("processing.customPatterns.matchThresholdLabel", "Match confidence threshold")}
              onValueChange={setMatchThreshold} />
            <span>%</span>
          </div>
        </div>
        <button type="button" className="btn btn--primary" disabled={!highlighted || !imageAvailable || match.status === "matching"} onClick={select}
          title={!imageAvailable ? tr("processing.customPatterns.loadImage", "Load an image on the canvas first.") : undefined}>
          {tr("processing.customPatterns.select", "Select")}
        </button>
      </div>
      {rows.length > 0 && <div className="custom-pattern-tiles" role="group" aria-label={title}>
        {rows.map(row => <button key={row.id} type="button"
          className={`custom-pattern-tile${confirmedPattern?.id === row.id ? " custom-pattern-tile--confirmed" : ""}`}
          aria-pressed={highlightedId === row.id} title={row.name}
          onClick={() => setHighlightedId(row.id)}
          onDoubleClick={() => {
            setHighlightedId(row.id);
            if (imageAvailable) {
              const threshold = matchThresholdValue();
              setMatchThreshold(String(threshold));
              confirmCustomPattern(row);
              requestCustomPatternMatch(row, threshold / 100);
              onSelect?.(row);
            }
          }}>
          <img src={row.payload.data} alt={row.name} />
          <span className="custom-pattern-tile__name">{row.name}</span>
          {confirmedPattern?.id === row.id && <span className="custom-pattern-tile__badge" aria-label={tr("processing.customPatterns.selected", "Selected")}><Icon name="check" /></span>}
        </button>)}
      </div>}
      {!imageAvailable && <p className="patterns-card__status">{tr("processing.customPatterns.loadImage", "Load an image on the canvas first.")}</p>}
      {match.status === "matching" && <LoadingSpinner label={tr("processing.customPatterns.matching", "Matching on the canvas image…")} />}
      {match.status === "complete" && match.matches.length > 0 && <p className="patterns-card__status" role="status">
        {t("processing.customPatterns.matchCount", { count: match.matches.length })}
      </p>}
      {match.status === "complete" && match.matches.length === 0 && <p className="patterns-card__status patterns-card__status--warning" role="alert">
        {tr("processing.customPatterns.noMatches", "No matching custom pattern was found on this image.")}
      </p>}
      {match.status === "error" && <p className="patterns-card__status patterns-card__status--error" role="alert">{match.error}</p>}
    </div>
  </div>;
}
