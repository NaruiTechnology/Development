/** PATTERNS > Custom: tile picker over the ionbeam_asset.CustomPatterns image catalogue. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MouseEvent } from "react";
import type { ReactNode } from "react";
import { customPatternApi, type CustomPattern } from "../lib/customPatternApi";
import { Icon } from "./Icon";
import { LoadingSpinner } from "./LoadingSpinner";
import { useTranslation, type TranslationKey } from "../i18n";
import { fetchCurrentRole } from "../lib/calibrationApi";
import { ROLE_SUPER_USER } from "../lib/calibrationModel";

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
  thresholdMin: number;
  status: "idle" | "matching" | "complete" | "error";
  matches: CustomPatternMatch[];
  error: string | null;
}
let matchState: CustomPatternMatchState = { requestId: 0, pattern: null, threshold: 0.98, thresholdMin: 0.7, status: "idle", matches: [], error: null };
const matchListeners = new Set<() => void>();
const subscribeMatch = (fn: () => void) => { matchListeners.add(fn); return () => { matchListeners.delete(fn); }; };
const publishMatch = () => matchListeners.forEach(fn => fn());
export const requestCustomPatternMatch = (pattern: CustomPattern, threshold = 0.98, thresholdMin = 0.7) => {
  matchState = { requestId: matchState.requestId + 1, pattern, threshold, thresholdMin, status: "matching", matches: [], error: null };
  publishMatch();
  return matchState.requestId;
};
export const updateCustomPatternMatchThreshold = (requestId: number, threshold: number) => {
  if (matchState.requestId !== requestId || matchState.status !== "matching") return false;
  matchState = { ...matchState, threshold };
  publishMatch();
  return true;
};
export const finishCustomPatternMatch = (requestId: number, matches: CustomPatternMatch[], error: string | null = null, threshold = matchState.threshold) => {
  if (matchState.requestId !== requestId) return;
  matchState = { ...matchState, threshold, status: error ? "error" : "complete", matches, error };
  publishMatch();
};
export const resetCustomPatternMatch = () => {
  confirmed = null;
  matchState = { requestId: matchState.requestId + 1, pattern: null, threshold: 0.98, thresholdMin: 0.7, status: "idle", matches: [], error: null };
  listeners.forEach(fn => fn());
  publishMatch();
};
export const useCustomPatternMatchState = () => useSyncExternalStore(subscribeMatch, () => matchState, () => matchState);

export function CustomPatternsCard({ onSelect, onResetPatternCards, imageAvailable = false, defaultWedges }: { onSelect?: (pattern: CustomPattern) => void; onResetPatternCards?: () => void; imageAvailable?: boolean; defaultWedges?: ReactNode }) {
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => { const text = t(key as TranslationKey); return text === key ? fallback : text; };
  const [collapsed, setCollapsed] = useState(false);
  const [tilesCollapsed, setTilesCollapsed] = useState(false);
  const [rows, setRows] = useState<CustomPattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const [matchRangeMin, setMatchRangeMin] = useState(70);
  const [matchRangeMax, setMatchRangeMax] = useState(98);
  const [progressUpper, setProgressUpper] = useState<number | null>(null);
  const [searchText, setSearchText] = useState("");
  const [currentRole, setCurrentRole] = useState<number | null>(null);
  const [savingPattern, setSavingPattern] = useState(false);
  const localFileInputRef = useRef<HTMLInputElement | null>(null);
  const confirmedPattern = useConfirmedCustomPattern();
  const match = useCustomPatternMatchState();
  const title = tr("processing.customPatterns.title", "Custom patterns");
  const shownUpper = progressUpper ?? matchRangeMax;
  const rangeAccuracyClick = (event: MouseEvent<HTMLDivElement>) => {
    if (match.status === "matching") return;
    if (event.target instanceof HTMLInputElement) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - 4) / Math.max(1, rect.width - 8)));
    const value = Math.round(10 + ratio * 90);
    if (Math.abs(value - matchRangeMin) <= Math.abs(value - matchRangeMax))
      setMatchRangeMin(Math.min(value, matchRangeMax));
    else
      setMatchRangeMax(Math.max(value, matchRangeMin));
    setProgressUpper(null);
  };

  useEffect(() => {
    if (match.status === "matching") setTilesCollapsed(false);
    if (match.status === "complete" && match.matches.length > 0) setTilesCollapsed(true);
    if (match.status === "matching" || match.status === "complete") setProgressUpper(Math.round(match.threshold * 100));
    else if (match.status === "idle") setProgressUpper(null);
  }, [match.status, match.matches.length, match.threshold, match.requestId]);

  useEffect(() => {
    let cancelled = false;
    customPatternApi.list()
      .then(result => { if (!cancelled) { setRows(existing => [...existing.filter(row => row.id < 0), ...result.patterns]); setError(null); } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchCurrentRole().then(role => { if (!cancelled) setCurrentRole(role); })
      .catch(() => { if (!cancelled) setCurrentRole(null); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      const selected = rows.find(row => row.id === highlightedId);
      if (!selected || selected.id >= 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (savingPattern) return;
      if (match.pattern?.id === selected.id) resetCustomPatternMatch();
      setRows(existing => existing.filter(row => row.id !== selected.id));
      setHighlightedId(null);
      setError(null);
    };
    // Capture before PatternOverlay's global ROI undo handler so a temporary
    // uploaded tile is undone first when it is the current selection.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [highlightedId, rows, match.pattern?.id, savingPattern]);

  const highlighted = rows.find(row => row.id === highlightedId) ?? null;
  const visibleRows = rows.filter(row => row.name.toLocaleLowerCase().includes(searchText.trim().toLocaleLowerCase()));
  const updateSearch = (value: string) => {
    setSearchText(value);
    const query = value.trim().toLocaleLowerCase();
    if (query) setHighlightedId(rows.find(row => row.name.toLocaleLowerCase().includes(query))?.id ?? null);
  };
  const addLocalPattern = async (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      setError("Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Images must be 10 MB or smaller.");
      return;
    }
    try {
      const payload = await new Promise<CustomPattern["payload"]>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read the selected image."));
        reader.onload = () => typeof reader.result === "string"
          ? resolve({ mimeType: file.type, data: reader.result })
          : reject(new Error("Could not read the selected image."));
        reader.readAsDataURL(file);
      });
      const name = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
      const temporary: CustomPattern = { id: -Date.now(), name, payload };
      setRows(existing => [temporary, ...existing]);
      setHighlightedId(temporary.id);
      setSearchText("");
      setError(null);
      setTilesCollapsed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (localFileInputRef.current) localFileInputRef.current.value = "";
    }
  };
  const saveLocalPattern = async () => {
    if (!highlighted || highlighted.id >= 0) return;
    if (currentRole === null || currentRole < ROLE_SUPER_USER) {
      setError("Saving a custom pattern requires SuperUser or higher access.");
      return;
    }
    if (!window.confirm(t("processing.customPatterns.saveConfirm", { name: highlighted.name }))) return;
    setSavingPattern(true);
    setError(null);
    try {
      const result = await customPatternApi.create(highlighted.name, highlighted.payload);
      setRows(existing => existing.map(row => row.id === highlighted.id ? result.pattern : row));
      setHighlightedId(result.pattern.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPattern(false);
    }
  };
  const select = () => {
    if (!highlighted || !imageAvailable) return;
    onResetPatternCards?.();
    confirmCustomPattern(highlighted);
    setProgressUpper(matchRangeMax);
    requestCustomPatternMatch(highlighted, matchRangeMax / 100, matchRangeMin / 100);
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
      {defaultWedges}
      {error && <p className="patterns-card__status patterns-card__status--error" role="alert">{error}</p>}
      {!loading && !error && rows.length === 0 && <p className="patterns-card__status">{tr("processing.table.customEmpty", "No custom patterns yet.")}</p>}
      <div className="custom-pattern-match-row">
        <div className="custom-pattern-match-threshold">
          <span>{tr("processing.customPatterns.matchThreshold", "Match accuracy")} <output>{matchRangeMin}%–{shownUpper}%</output></span>
          <div className="custom-pattern-range-slider" aria-disabled={match.status === "matching"} onClick={rangeAccuracyClick}>
            <div className="custom-pattern-range-track" />
            <div className="custom-pattern-range-selected" style={{ left: `${(matchRangeMin - 10) / 90 * 100}%`, right: `${100 - (shownUpper - 10) / 90 * 100}%` }} />
            <div className="custom-pattern-range-ticks" aria-hidden="true">
              {Array.from({ length: 19 }, (_, index) => index * 5 + 10).map(value => {
                const major = [10, 25, 50, 75, 100].includes(value);
                return <span key={value} className={major ? "custom-pattern-range-tick--major" : ""}
                  style={{ left: `${(value - 10) / 90 * 100}%` }}><i>{major ? `${value}%` : ""}</i></span>;
              })}
            </div>
            <input type="range" className={shownUpper <= matchRangeMin ? "custom-pattern-range-lower--at-limit" : undefined}
              min={10} max={100} step={1} value={matchRangeMin} disabled={match.status === "matching"}
              aria-label={tr("processing.customPatterns.matchRangeMin", "Minimum match range")}
              onChange={event => { setMatchRangeMin(Math.min(Number(event.target.value), matchRangeMax)); setProgressUpper(null); }} />
            <input type="range" className={shownUpper <= matchRangeMin ? "custom-pattern-range-upper--at-limit" : undefined}
              min={10} max={100} step={1} value={shownUpper} disabled={match.status === "matching"}
              aria-label={tr("processing.customPatterns.matchRangeMax", "Maximum match range")}
              onChange={event => { setMatchRangeMax(Number(event.target.value)); setProgressUpper(null); }} />
          </div>
        </div>
        <button type="button" className="btn btn--primary" disabled={!highlighted || !imageAvailable || match.status === "matching" || (match.status === "complete" && match.matches.length > 0 && tilesCollapsed)} onClick={select}
          title={!imageAvailable ? tr("processing.customPatterns.loadImage", "Load an image on the canvas first.") : undefined}>
          <Icon name={match.status === "complete" && match.matches.length > 0 ? "check" : match.status === "complete" ? "refresh" : "search"} />
          {match.status === "complete" && match.matches.length > 0
            ? tr("processing.customPatterns.selected", "Selected")
            : match.status === "complete" && match.matches.length === 0
              ? tr("processing.customPatterns.retry", "Retry")
              : tr("processing.customPatterns.select", "Select")}
        </button>
      </div>
      {(rows.length > 0 || loading || !imageAvailable || (highlighted !== null && highlighted.id < 0)) && <section className="custom-pattern-tiles-section" aria-busy={loading}>
        <button type="button" className="custom-pattern-tiles-toggle" aria-expanded={!tilesCollapsed}
          onClick={() => setTilesCollapsed(value => !value)}>
          <span>{tr("processing.customPatterns.title", "Custom patterns")}</span><Icon name="chevronDown" />
        </button>
        {loading && !tilesCollapsed && <div className="custom-pattern-tiles-loading"><LoadingSpinner label={tr("settings.admin.customPatterns.loading", "Loading custom patterns…")} /></div>}
        {!loading && rows.length > 0 && !tilesCollapsed && <div className="custom-pattern-tiles" role="group" aria-label={title}>
        <label className="custom-pattern-search">
          <Icon name="search" />
          <input className="input" type="text" value={searchText}
            placeholder={tr("processing.customPatterns.search", "Search custom patterns…")}
            aria-label={tr("processing.customPatterns.search", "Search custom patterns…")}
            onChange={event => updateSearch(event.target.value)} />
          {searchText && <button type="button" className="custom-pattern-search__clear"
            aria-label={tr("processing.customPatterns.clearSearch", "Clear search")}
            title={tr("processing.customPatterns.clearSearch", "Clear search")}
            onClick={() => setSearchText("")}><Icon name="x" /></button>}
        </label>
        {visibleRows.map(row => <button key={row.id} type="button"
          className={`custom-pattern-tile${confirmedPattern?.id === row.id ? " custom-pattern-tile--confirmed" : ""}`}
          aria-pressed={highlightedId === row.id} title={row.name}
          onClick={() => setHighlightedId(row.id)}
          onDoubleClick={() => {
            setHighlightedId(row.id);
            if (imageAvailable) {
              confirmCustomPattern(row);
              setProgressUpper(matchRangeMax);
              requestCustomPatternMatch(row, matchRangeMax / 100, matchRangeMin / 100);
              onSelect?.(row);
            }
          }}>
          <img src={row.payload.data} alt={row.name} />
          <span className="custom-pattern-tile__name">{row.name}</span>
          {confirmedPattern?.id === row.id && <span className="custom-pattern-tile__badge" aria-label={tr("processing.customPatterns.selected", "Selected")}><Icon name="check" /></span>}
        </button>)}
        {visibleRows.length === 0 && <p className="patterns-card__status">{tr("processing.customPatterns.noSearchResults", "No matching custom patterns.")}</p>}
        </div>}
        {!tilesCollapsed && (!imageAvailable || (highlighted !== null && highlighted.id < 0)) && <div className="custom-pattern-local-actions">
          <input ref={localFileInputRef} className="custom-pattern-local-actions__input" type="file"
            accept="image/png,image/jpeg,image/webp,image/gif" aria-label={tr("processing.customPatterns.selectFile", "Select custom pattern image")}
            onChange={event => void addLocalPattern(event.target.files?.[0])} />
          <button type="button" className="btn btn--cancel" onClick={() => localFileInputRef.current?.click()}>
            <Icon name="upload" /> {tr("processing.customPatterns.selectFile", "Select")}
          </button>
          <button type="button" className="btn btn--primary" disabled={!highlighted || highlighted.id >= 0 || currentRole === null || currentRole < ROLE_SUPER_USER || savingPattern}
            title={currentRole !== null && currentRole < ROLE_SUPER_USER ? tr("processing.customPatterns.superUserRequired", "SuperUser or higher access is required to save.") : undefined}
            onClick={() => void saveLocalPattern()}>
            {savingPattern ? tr("settings.admin.customPatterns.saving", "Saving…") : tr("settings.admin.customPatterns.save", "Save")}
          </button>
        </div>}
      </section>}
      {match.status === "matching" && <LoadingSpinner label={tr("processing.customPatterns.matching", "Matching on the canvas image…")} />}
      {match.status === "complete" && match.matches.length > 0 && <p className="patterns-card__status" role="status">
        {t("processing.customPatterns.matchCount", { count: match.matches.length })}
      </p>}
      {match.status === "complete" && match.matches.length === 0 && <p className="patterns-card__status patterns-card__status--warning" role="alert">
        {t("processing.customPatterns.matchFailedAtLimit", { threshold: Math.round(match.threshold * 100) })}
      </p>}
      {match.status === "error" && <p className="patterns-card__status patterns-card__status--error" role="alert">{match.error}</p>}
    </div>
  </div>;
}
