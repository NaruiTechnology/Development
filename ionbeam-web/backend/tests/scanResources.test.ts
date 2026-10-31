import test from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import { streamMockRaster, streamMockVector } from "../src/mockHardware";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareMockScanAsset, appendMockScanAsset, completeMockScanAsset, getMockScanAsset } from "../src/mockScanAssets";

for (const kind of ["raster", "vector"] as const) {
  test(`${kind} bitmap metadata is scanned once per bitmap, not once per sample`, async () => {
    const edge = 64;
    let reads = 0;
    const pixels = new Proxy(Array<number>(edge * edge).fill(80), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const sent: Buffer[] = [];
    const ws = { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (data: Buffer | string) => {
      if (Buffer.isBuffer(data)) sent.push(data);
    } } as unknown as WebSocket;
    const params = { resolution: edge, vector_resolution: edge, pattern: "default" as const,
      scan_path: "horizontal_sawtooth" as const, dwell: 1, latency_bytes: edge * edge,
      simulation: { mode: "zeros" }, simulation_bitmap: { width: edge, height: edge, pixels } };
    if (kind === "raster") await streamMockRaster(ws, params);
    else await streamMockVector(ws, params);
    assert.equal(sent.reduce((n, b) => n + b.length, 0), edge * edge * 2);
    assert.ok(reads <= edge * edge * 2 + 16, `bitmap read ${reads} times`);
  });
}

test("a slow scan consumer pauses generation until its send backlog drains", async () => {
  let drained = false;
  const ws = { OPEN: 1, readyState: 1, bufferedAmount: 2 * 1024 * 1024,
    send: () => assert.equal(drained, true) };
  const timer = setTimeout(() => { drained = true; ws.bufferedAmount = 0; }, 25);
  try {
    await streamMockRaster(ws as unknown as WebSocket, { resolution: 2, dwell: 1, latency_bytes: 4,
      simulation: { mode: "zeros" } });
  } finally { clearTimeout(timer); }
});

test("evicted mock assets remain available to queued scans and failed uploads release chunks", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ionbeam-scan-assets-"));
  const previous = process.env.IONBEAM_MOCK_SCAN_ASSET_DIR;
  process.env.IONBEAM_MOCK_SCAN_ASSET_DIR = directory;
  try {
    const ids: string[] = [];
    for (let value = 1; value <= 6; value++) {
      const data = Buffer.from(JSON.stringify({ width: 1, height: 1, pixels: [value] }));
      const id = crypto.createHash("sha256").update(data).digest("hex");
      prepareMockScanAsset(id, data.length);
      appendMockScanAsset(id, 0, data);
      completeMockScanAsset(id);
      ids.push(id);
    }
    assert.deepEqual(getMockScanAsset(ids[0]), { width: 1, height: 1, pixels: [1] });
    const corruptId = crypto.createHash("sha256").update("corrupt").digest("hex");
    prepareMockScanAsset(corruptId, 1);
    appendMockScanAsset(corruptId, 0, Buffer.from("x"));
    assert.throws(() => completeMockScanAsset(corruptId), /checksum/);
    assert.equal(prepareMockScanAsset(corruptId, 1).offset, 0);
  } finally {
    if (previous === undefined) delete process.env.IONBEAM_MOCK_SCAN_ASSET_DIR;
    else process.env.IONBEAM_MOCK_SCAN_ASSET_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
