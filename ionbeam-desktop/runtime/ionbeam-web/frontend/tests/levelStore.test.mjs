import test from "node:test";
import assert from "node:assert/strict";

import { getLevelSetting, setLevelSetting, subscribeLevelSetting } from "../.test-dist/lib/levelStore.js";

test("level store defaults to auto and notifies only on real changes", () => {
  assert.deepEqual(getLevelSetting("t-a"), { mode: "auto" });
  let calls = 0;
  const off = subscribeLevelSetting("t-a", () => calls++);
  setLevelSetting("t-a", { mode: "auto" });
  assert.equal(calls, 0);
  setLevelSetting("t-a", { mode: "manual", low: 10, high: 200 });
  setLevelSetting("t-a", { mode: "manual", low: 10, high: 200 });
  assert.equal(calls, 1);
  assert.deepEqual(getLevelSetting("t-a"), { mode: "manual", low: 10, high: 200 });
  setLevelSetting("t-b", { mode: "manual", low: 1, high: 9 });
  assert.equal(calls, 1, "other keys do not notify");
  off();
  setLevelSetting("t-a", { mode: "auto" });
  assert.equal(calls, 1, "unsubscribed listeners stay quiet");
});
