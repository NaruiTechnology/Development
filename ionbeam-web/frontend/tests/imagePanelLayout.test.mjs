import assert from "node:assert/strict";
import test from "node:test";

import { placeCompletedScan } from "../.test-dist/lib/imagePanelLayout.js";

test("locked multi-scan replaces only the selected pane and preserves the layout", () => {
  const result = placeCompletedScan({
    slots: ["scan-1", "scan-2", "scan-3", "scan-4"],
    layout: 4,
    selectedPane: 1,
    locked: true,
    imageUrl: "new-scan",
  });

  assert.deepEqual(result, {
    slots: ["scan-1", "new-scan", "scan-3", "scan-4"],
    layout: 4,
    selectedPane: 1,
  });
});

test("unlocked multi-scan keeps advancing to an empty target pane", () => {
  const result = placeCompletedScan({
    slots: ["scan-1", "scan-2"],
    layout: 2,
    selectedPane: 0,
    locked: false,
    imageUrl: "scan-3",
  });

  assert.deepEqual(result, {
    slots: ["scan-2", "scan-3", null],
    layout: 3,
    selectedPane: 2,
  });
});

test("locked multi-scan into the newest pane opens the next empty pane", () => {
  assert.deepEqual(
    placeCompletedScan({ slots: ["scan-1", null], layout: 2, selectedPane: 1, locked: true, imageUrl: "scan-2" }),
    { slots: ["scan-1", "scan-2", null], layout: 3, selectedPane: 2 },
  );
  assert.deepEqual(
    placeCompletedScan({ slots: ["scan-1", "scan-2", null], layout: 3, selectedPane: 2, locked: true, imageUrl: "scan-3" }),
    { slots: ["scan-1", "scan-2", "scan-3", null], layout: 4, selectedPane: 3 },
  );
});

test("locked multi-scan stops growing at four panes", () => {
  assert.deepEqual(
    placeCompletedScan({ slots: ["scan-1", "scan-2", "scan-3", null], layout: 4, selectedPane: 3, locked: true, imageUrl: "scan-4" }),
    { slots: ["scan-1", "scan-2", "scan-3", "scan-4"], layout: 4, selectedPane: 3 },
  );
});

test("locked re-scan of an older selected pane does not add a pane", () => {
  assert.deepEqual(
    placeCompletedScan({ slots: ["scan-1", "scan-2", null], layout: 3, selectedPane: 0, locked: true, imageUrl: "again" }),
    { slots: ["again", "scan-2", null], layout: 3, selectedPane: 0 },
  );
});
