import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

test("validated artifacts are immutable snapshots, including after another workspace runs", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" } };
  let source = "SCAN";
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    return { ok: true, blob: async () => new Blob([source], { type: String(url).includes("csv") ? "text/csv" : "image/png" }) };
  };
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  try {
    const { captureScanResultArtifacts } = await vite.ssrLoadModule("/src/lib/scanResultArtifacts.ts");
    const signal = new AbortController().signal;
    const scan = await captureScanResultArtifacts({ kind: "vector" }, "native", signal);
    source = "PROCESSING";
    const processing = await captureScanResultArtifacts({ kind: "vector" }, "native", signal);
    assert.equal(atob(scan.artifacts.csvDataUrl.split(",")[1]), "SCAN");
    assert.equal(atob(scan.artifacts.figureDataUrl.split(",")[1]), "SCAN");
    assert.equal(atob(processing.artifacts.csvDataUrl.split(",")[1]), "PROCESSING");
    assert.equal(atob(processing.artifacts.figureDataUrl.split(",")[1]), "PROCESSING");
    assert.equal(requests.length, 4);
    globalThis.fetch = async () => ({ ok: false });
    const missing = await captureScanResultArtifacts({ kind: "vector" }, "native", signal);
    assert.deepEqual(missing.artifacts, { csvDataUrl: null, figureDataUrl: null }, "missing assets never reuse another run");
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  }
});
