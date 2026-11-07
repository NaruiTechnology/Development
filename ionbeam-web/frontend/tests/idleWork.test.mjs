import test from "node:test";
import assert from "node:assert/strict";
import { createIdleWorkQueue } from "../.test-dist/lib/idleWork.js";
import { MODEL_REGISTRY, patternAvgGraySteps } from "../.test-dist/lib/processingPatterns.js";

test("idle measurements coalesce pending work, yield between slices, and cancel on disposal", t => {
  const original = globalThis.window;
  const callbacks = new Map();
  let id = 0;
  globalThis.window = {
    requestIdleCallback(fn) { callbacks.set(++id, fn); return id; },
    cancelIdleCallback(id) { callbacks.delete(id); },
  };
  t.mock.timers.enable({apis:["setTimeout"]});
  const queue = createIdleWorkQueue();
  try {
    const seen = [];
    queue.schedule(function* () { seen.push("obsolete"); });
    queue.schedule(function* () { seen.push("first"); yield; seen.push("second"); });
    assert.deepEqual(seen, [], "nothing calculated on drawing's call stack");
    t.mock.timers.tick(120);
    const slice = () => {
      const [key, fn] = callbacks.entries().next().value;
      callbacks.delete(key);
      let calls = 0;
      fn({timeRemaining: () => ++calls === 1 ? 5 : 0});
    };
    slice();
    assert.deepEqual(seen, ["first"], "yield leaves time for mouse and painting");
    queue.schedule(function* () { seen.push("old-stream-update"); });
    queue.schedule(function* () { seen.push("latest-stream-update"); });
    slice();
    assert.deepEqual(seen, ["first","second"]);
    t.mock.timers.tick(120);
    slice();
    assert.deepEqual(seen, ["first","second","latest-stream-update"]);
    queue.schedule(function* () { seen.push("after-dispose"); });
    t.mock.timers.tick(120);
    queue.dispose();
    assert.equal(callbacks.size, 0);
    t.mock.timers.tick(1000);
    assert.ok(!seen.includes("after-dispose"));
  } finally { queue.dispose(); globalThis.window = original; }
});

test("chunked gray calculation yields before reading and preserves exact average", () => {
  const rect = {x_start:0,x_end:2,y_start:0,y_end:2};
  let reads = 0;
  const steps = patternAvgGraySteps(rect, MODEL_REGISTRY.SolidBoxModel, 2, 2,
    {x_origin:0,x_end:2,y_origin:0,y_end:2}, index => { reads++; return [0,10,20,30][index]; });
  assert.equal(steps.next().done, false);
  assert.equal(reads, 0);
  assert.equal(steps.next().done, false);
  assert.equal(reads, 2);
  assert.deepEqual(steps.next(), {done:true,value:15});
});
