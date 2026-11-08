import { useCallback, useSyncExternalStore } from "react";

import { useAppWorkspace } from "../store";

import type { LevelSetting } from "../lib/displayLevels";
import { getLevelSetting, setLevelSetting, subscribeLevelSetting } from "../lib/levelStore";

/** Shared wedge level setting for a named view (see lib/levelStore). */
export function useLevelSetting(view: string): [LevelSetting, (next: LevelSetting) => void] {
  const workspace = useAppWorkspace();
  const key = `${workspace}:${view}`;
  const subscribe = useCallback((listener: () => void) => subscribeLevelSetting(key, listener), [key]);
  const setting = useSyncExternalStore(subscribe, () => getLevelSetting(key));
  const set = useCallback((next: LevelSetting) => setLevelSetting(key, next), [key]);
  return [setting, set];
}
