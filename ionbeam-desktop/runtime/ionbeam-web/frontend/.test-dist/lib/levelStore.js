const AUTO = { mode: "auto" };
const settings = new Map();
const listeners = new Map();
export function getLevelSetting(key) {
    return settings.get(key) ?? AUTO;
}
export function setLevelSetting(key, next) {
    const current = settings.get(key) ?? AUTO;
    const same = current.mode === next.mode &&
        (current.mode === "auto" ||
            (next.mode === "manual" && current.low === next.low && current.high === next.high));
    if (same)
        return;
    settings.set(key, next);
    listeners.get(key)?.forEach((listener) => listener());
}
export function subscribeLevelSetting(key, listener) {
    let set = listeners.get(key);
    if (!set) {
        set = new Set();
        listeners.set(key, set);
    }
    set.add(listener);
    return () => {
        set.delete(listener);
    };
}
