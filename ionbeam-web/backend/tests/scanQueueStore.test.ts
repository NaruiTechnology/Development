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

test("completed newer queue does not expose an older interrupted scan", async () => {
  const store = await import("../src/scanQueueStore");
  const owner = "superseded-operator";
  const old = store.createScanQueue(owner, [{ kind: "vector", req: {} }]);
  store.setScanQueueStep(old.id, 0, "running", owner);
  store.setScanQueueStep(old.id, 0, "interrupted", owner);
  const oldPath = path.join(directory, `${old.id}.json`);
  fs.writeFileSync(oldPath, JSON.stringify({ ...store.readScanQueue(old.id, owner), created_at: "2000-01-01T00:00:00.000Z" }));
  assert.equal(store.latestScanQueue(owner)?.id, old.id);
  const newer = store.createScanQueue(owner, [{ kind: "vector", req: {} }]);
  store.setScanQueueStep(newer.id, 0, "running", owner);
  store.setScanQueueStep(newer.id, 0, "completed", owner);
  assert.equal(store.latestScanQueue(owner), null);
  assert.equal(store.readScanQueue(old.id, owner).status, "interrupted");
});


test("SCAN and Processing recovery queues stay separate for the same operator", async () => {
  const store = await import("../src/scanQueueStore");
  const owner = "workspace-operator";
  const scan = store.createScanQueue(owner, [{ kind: "raster", req: { resolution: 64 } }], "scan");
  store.setScanQueueStep(scan.id, 0, "running", owner);
  store.setScanQueueStep(scan.id, 0, "interrupted", owner);
  const processing = store.createScanQueue(owner, [{ kind: "vector", req: { vector_resolution: 128 } }], "processing");
  assert.equal(store.latestScanQueue(owner, "scan")?.id, scan.id);
  assert.equal(store.latestScanQueue(owner, "processing")?.id, processing.id);
  assert.throws(() => store.queuePage(processing.id, owner, 0, 100, "scan"), /not found/);
  assert.throws(() => store.queuePage(scan.id, owner, 0, 100, "processing"), /not found/);
  store.setScanQueueStep(processing.id, 0, "running", owner);
  store.setScanQueueStep(processing.id, 0, "completed", owner);
  assert.equal(store.latestScanQueue(owner, "processing"), null);
  assert.equal(store.latestScanQueue(owner, "scan")?.id, scan.id);
});
