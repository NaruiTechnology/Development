/**
 * scanActionRegistry — module-level cubbyhole where active scan actions
 * register their `stop` callbacks, so non-tree-adjacent
 * components (e.g. the gear button in the header) can ask the stream
 * to close without having to take a direct reference to the hook.
 *
 * Why not put this in Redux?
 * --------------------------
 * The thing we want to share is a *function reference* that closes
 * over a WebSocket, not a serialisable value. Stashing it in Redux
 * would either require a non-serialisable allow-list entry or a
 * roundabout subscription pattern. A flat module-level mutable
 * binding is the simplest thing that works, and React's effect
 * cleanup gives us a natural unregister hook on unmount.
 *
 * Concurrency model: there should be at most one scan action open at a
 * time, but a Set keeps the stop path robust while a REST validated run
 * and a stale stream cleanup overlap.
 */

type StopFn = () => void;

const activeStops = new Set<StopFn>();

/**
 * Register an active scan action's stop callback. Returns an unregister
 * function the caller must invoke on cleanup.
 */
export function registerScanActionStop(stop: StopFn): () => void {
  activeStops.add(stop);
  return () => {
    activeStops.delete(stop);
  };
}

/**
 * Ask all currently-registered scan actions to stop. Safe to call at
 * any time — no-op when nothing is registered. Errors thrown by a
 * registered callback are swallowed so a misbehaving action
 * can't block the dialog from opening.
 */
export function stopAllScanActions(): boolean {
  const stops = [...activeStops];
  if (stops.length === 0) return false;
  for (const fn of stops) {
    try {
      fn();
    } catch (err) {
      console.warn("[scanActionRegistry] stop callback threw:", err);
    }
  }
  return true;
}
