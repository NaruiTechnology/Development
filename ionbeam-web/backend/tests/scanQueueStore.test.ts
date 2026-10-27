import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ionbeam-queue-test-"));
process.env.IONBEAM_SCAN_QUEUE_DIR = directory;

test("queue progress survives reload and only the unfinished entry resumes", async () => {
  const store = await import("../src/scanQueueStore");
  const queue = store.createScanQueue("operator", [
    { kind: "raster", req: { resolution: 128 } },
    { kind: "raster", req: { resolution: 256 } },
  ]);
  store.setScanQueueStep(queue.id, 0, "running", "operator");
  assert.throws(() => store.setScanQueueStep(queue.id, 0, "running", "operator"), /already running/);
  store.setScanQueueStep(queue.id, 0, "completed", "operator");
  assert.equal(store.queuePage(queue.id, "operator", 0, 1).entries.length, 1);
  assert.equal(store.readScanQueue(queue.id, "operator").next_index, 1);
  store.setScanQueueStep(queue.id, 1, "running", "operator");
  store.recoverInterruptedScanQueues();
  const recovered = store.readScanQueue(queue.id, "operator");
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.next_index, 1);
  assert.throws(() => store.readScanQueue(queue.id, "other"));
  store.setScanQueueStep(queue.id, 1, "running", "operator");
  store.setScanQueueStep(queue.id, 1, "completed", "operator");
  assert.equal(store.readScanQueue(queue.id, "operator").status, "completed");
});
