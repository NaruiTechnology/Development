import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

test("dispatching pixel-buffer image actions does not trip the serializability check", async () => {
  const originals = Object.fromEntries(["window", "console"].map((key) => [key, globalThis[key]]));
  globalThis.window = {
    location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, removeEventListener() {},
  };
  const errors = [];
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const image = await vite.ssrLoadModule("/src/store/imageSlice.ts");
    const edge = 4;
    store.dispatch(image.setupVector({ pattern: "default", edge, initialImage: new Uint16Array(edge * edge) }));
    const original = console.error;
    console.error = (...args) => { errors.push(args.join(" ")); };
    try {
      store.dispatch(image.seedVectorRegions({
        image: new Uint16Array(edge * edge).fill(900),
        regions: [{ x_start: 0, x_end: 16383, y_start: 0, y_end: 16383 }],
      }));
    } finally {
      console.error = original;
    }
    assert.deepEqual(errors, [], "seedVectorRegions must be listed in serializableCheck.ignoredActions");
    assert.equal(store.getState().image.vectorImage[0], 900);
  } finally {
    await vite.close();
    Object.assign(globalThis, originals);
  }
});
