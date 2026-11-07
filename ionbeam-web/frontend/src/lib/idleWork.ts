/** Coalesce measurements and yield to input/painting between short work slices. */
export function createIdleWorkQueue(delay = 120) {
  let pending: (() => Generator<void, void>) | null = null;
  let current: Generator<void, void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: number | null = null;
  let disposed = false;
  const nativeIdle = typeof window.requestIdleCallback === "function";
  function scheduleSlice() {
    if (disposed) return;
    if (nativeIdle) idle = window.requestIdleCallback(run);
    else timer = setTimeout(() => run(), 16);
  }
  function run(deadline?: IdleDeadline) {
    idle = null;
    timer = null;
    if (disposed) return;
    if (!current && pending) { current = pending(); pending = null; }
    const end = performance.now() + 4;
    while (current && performance.now() < end && (!deadline || deadline.timeRemaining() > 1)) {
      if (current.next().done) current = null;
    }
    if (current) scheduleSlice();
    else if (pending) timer = setTimeout(scheduleSlice, delay);
  }
  return {
    schedule(work: () => Generator<void, void>) {
      if (disposed) return;
      pending = work;
      if (!current && timer === null && idle === null) timer = setTimeout(scheduleSlice, delay);
    },
    dispose() {
      disposed = true;
      pending = null;
      current = null;
      if (timer !== null) clearTimeout(timer);
      if (idle !== null) window.cancelIdleCallback(idle);
    },
  };
}
