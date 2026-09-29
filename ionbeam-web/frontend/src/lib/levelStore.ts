/**
 * Tiny shared store for wedge level settings, keyed by view ("roi", ...).
 *
 * Several components can show the same image (the ROI canvas and the small ROI
 * preview), and they must agree on its black/white levels, so the setting
 * lives here instead of in one component's state. It also survives the view
 * being unmounted when the operator switches tabs.
 */
import type { LevelSetting } from "./displayLevels";

const AUTO: LevelSetting = { mode: "auto" };

const settings = new Map<string, LevelSetting>();
const listeners = new Map<string, Set<() => void>>();

export function getLevelSetting(key: string): LevelSetting {
  return settings.get(key) ?? AUTO;
}

export function setLevelSetting(key: string, next: LevelSetting): void {
  const current = settings.get(key) ?? AUTO;
  const same =
    current.mode === next.mode &&
    (current.mode === "auto" ||
      (next.mode === "manual" && current.low === next.low && current.high === next.high));
  if (same) return;
  settings.set(key, next);
  listeners.get(key)?.forEach((listener) => listener());
}

export function subscribeLevelSetting(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
  };
}
