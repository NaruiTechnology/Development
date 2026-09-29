import assert from "node:assert/strict";
import test from "node:test";

import { displayScanError } from "../.test-dist/lib/scanError.js";

test("surfaces a friendly Glasgow USB message for device-not-found failures", () => {
  assert.equal(
    displayScanError("DeviceNotReady: device not found", "Connect the Glasgow USB device."),
    "Connect the Glasgow USB device.",
  );
});

test("preserves other scan failure details", () => {
  assert.equal(displayScanError("stream timeout", "unused"), "stream timeout");
  assert.equal(displayScanError(null, "unused"), null);
});
