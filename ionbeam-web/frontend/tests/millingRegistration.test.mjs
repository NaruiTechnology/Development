import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { Provider } from "react-redux";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";
import {
  millingOffset, millingRegistrationBounds, registrationMask, registrationPitch, registrationRadius,
} from "../.test-dist/lib/millingRegistration.js";
import { millingSpotPositions } from "../.test-dist/lib/millingLiveView.js";

test("registration uses the calibrated field, actual raster pitch and full physical padding", () => {
  const field = {x_origin: 0, x_end: 20, y_origin: 0, y_end: 20};
  const edge = {x_start: 1.9, x_end: 4, y_start: 8, y_end: 12};
  assert.equal(millingRegistrationBounds(edge, field), null);
  assert.ok(millingRegistrationBounds({...edge, x_start: 2}, field));
  assert.deepEqual(millingRegistrationBounds(edge, field, 1.5), edge);
  assert.equal(millingRegistrationBounds(edge, field, 3), null);
  assert.deepEqual(millingOffset([2000, 64], field, 3.5), [2000, 64]);
  assert.equal(millingOffset([2000, 64], field, 1.5), null);
  assert.equal(registrationMask({x_start: 2, x_end: 18, y_start: 2, y_end: 18}, field, 512), null);
  assert.equal(registrationPitch(512), 32);
  assert.equal(registrationPitch(1024), 16);
  assert.equal(registrationRadius({...field, x_end: 10}, 0, 512), 105, "cover 2 µm even in a narrow field");
  assert.equal(registrationRadius({...field, x_end: 10}, 0, 1024), 207);

  const scale = 1 / 819.2;
  const calibrated = {...field, scanGeometry: {enabled: true,
    forward: {a: [scale, 0.5 * scale, 0, scale], b: [0, 0]},
    inverse: {a: [1 / scale, -0.5 / scale, 0, 1 / scale], b: [0, 0]},
  }};
  const roi = {x_start: 13, x_end: 15, y_start: 10, y_end: 12};
  assert.deepEqual(millingRegistrationBounds(roi, calibrated), roi);
  const mask = registrationMask(roi, calibrated, 512).pixels;
  assert.equal(mask[256 * 512 + 256], 0, "physical point (15, 10) is excluded");
  assert.equal(mask[201 * 512 + 338], 1, "point inside the enclosing DAC box but outside physical padding is retained");
  const fineMask = registrationMask(roi, calibrated, 1024).pixels;
  assert.equal(fineMask[512 * 1024 + 512], 0);
  assert.equal(fineMask[402 * 1024 + 676], 1);
  assert.equal(millingOffset([1638.31, 0], field), null,
    "a measured shift beyond 2 µm cannot round back into range");
});

test("Advanced Milling qualifies one masked reference and gates each later pass on a fresh raster", {timeout: 20_000}, async () => {
  const previous = {window: globalThis.window, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket};
  const events = [];
  const lensLookup = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url))).LensLookup;
  globalThis.window = {
    location: {hostname: "example.test", protocol: "http:", host: "example.test"},
    localStorage: {getItem: () => null, setItem() {}},
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const success = payload => Response.json(payload);
  let capabilities = {is_production: true, exposure_cell_ranges: true, exposure_session_stream: true,
    milling_drift_registration: true, raster: {}, vector: {}};
  const matches = new Map([[0, [0, 0]], [2, [32, -64]], [3, [-96, 32]]]);
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/api/defaults")) return success(capabilities);
    if (String(url).endsWith("/api/admin/iobeam/custom-patterns")) return success({patterns: []});
    if (!String(url).endsWith("/milling-registration"))
      return success({ok: true, registered: true, user: {is_active: true, role: 5}});
    const request = JSON.parse(options.body);
    events.push({kind: "match", request});
    const offset = matches.get(request.pass_index);
    return success(offset ? {offset, correlation: 0.91, threshold_percent: 91, retries: 7}
      : {offset: null, reason: "low_correlation"});
  };
  let captures = 0;
  class Socket {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 0;
    constructor() {
      queueMicrotask(() => {
        this.readyState = Socket.OPEN;
        this.onopen?.();
      });
    }
    send(data) {
      const event = JSON.parse(data);
      events.push(event);
      queueMicrotask(() => {
        const {kind, request} = event;
        const pixels = kind === "raster"
          ? new Uint16Array(request.resolution ** 2).fill(++captures * 257)
          : new Uint16Array([...millingSpotPositions(request.lattice)].length);
        this.onmessage({data: pixels.buffer});
        this.onmessage({data: JSON.stringify({event: "done"})});
      });
    }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = Socket;
  const vite = await createServer({server: {middlewareMode: true, watch: null, ws: false},
    optimizeDeps: {noDiscovery: true, include: []}, appType: "custom"});
  let renderer;
  try {
    const {getWorkspaceStore} = await vite.ssrLoadModule("/src/store/index.ts");
    const {ProcessingPatternsPanel} = await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
    const {fetchProcessingPatterns, setPatternRoi} = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const {setExposureMode} = await vite.ssrLoadModule("/src/store/exposureSlice.ts");
    const {updateRaster, updateROI} = await vite.ssrLoadModule("/src/store/scanSlice.ts");
    const {fetchDefaultsMetadata} = await vite.ssrLoadModule("/src/store/statusSlice.ts");
    const store = getWorkspaceStore("processing");
    store.dispatch({type: "status/defaults/fulfilled", payload: capabilities});
    const values = {beamCurrent: 150, dwell: 8192, overlap: 50, axis: "x", depth: 0.001, removalRate: 1, loops: 4};
    const parameters = Object.entries(values).map(([name, value]) => ({
      name, label: name, type: typeof value === "string" ? "choice" : "float",
      default: value, min: null, max: null, step: 1, choices: typeof value === "string" ? [value] : [],
    }));
    store.dispatch(fetchProcessingPatterns.fulfilled({lensLookup, patterns: [
      {key: "box", caption: "Box", model: "SolidBoxModel", roi: "rect", icon: "patternSolidBox", parameters},
    ]}, "advanced-milling"));
    store.dispatch(updateROI({x_origin: 0, x_end: 20, y_origin: 0, y_end: 20,
      selection: {x_start: 1, x_end: 3, y_start: 1, y_end: 3}}));
    store.dispatch(updateRaster({resolution: 256, dwell: 8}));
    store.dispatch(setPatternRoi({key: "box", roi: {x_start: 9, x_end: 11, y_start: 9, y_end: 11}}));
    store.dispatch(setExposureMode("milling"));
    const initialScan = store.getState().scan;

    await act(async () => {
      renderer = create(React.createElement(Provider, {store}, React.createElement(ProcessingPatternsPanel, {disabled: false})));
    });
    const advancedTab = renderer.root.findByProps({id: "pattern-table-tab-custom"});
    const registrationPanelClass = {className: "milling-registration-panel"};
    assert.equal(renderer.root.findAllByProps(registrationPanelClass).length, 0);
    await act(async () => advancedTab.props.onClick());
    const panel = renderer.root.findByProps(registrationPanelClass);
    const savedPatterns = renderer.root.findByProps({className: "custom-pattern-tiles-section"});
    const registrationPanel = panel.parent;
    const cardBody = savedPatterns.parent;
    assert.equal(registrationPanel.parent, cardBody);
    assert.equal(cardBody.children.indexOf(savedPatterns), cardBody.children.indexOf(registrationPanel) + 1);
    const selector = panel.findByType("select");
    assert.equal(selector.props.value, 512);
    assert.deepEqual(selector.findAllByType("option").map(option => option.props.value), [512]);
    const start = renderer.root.findAllByType("button").find(button => button.children.includes("Start"));
    const driftLimit = renderer.root.findAllByType("input")
      .find(input => input.props["aria-label"] === "Drift correction limit (µm)");
    assert.equal(driftLimit.props.value, "2");
    await act(async () => driftLimit.props.onChange({target: {value: ""}}));
    assert.equal(start.props.disabled, true);
    await act(async () => driftLimit.props.onChange({target: {value: "2"}}));
    assert.equal(start.props.disabled, false);
    const run = async () => {
      let unsubscribe;
      const finished = new Promise(resolve => {
        unsubscribe = store.subscribe(() => {
          if (["completed", "error"].includes(store.getState().exposure.phase)) resolve();
        });
      });
      try {
        await act(async () => { start.props.onClick(); await finished; });
      } finally { unsubscribe(); }
    };
    await run();

    const raster = events.filter(event => event.kind === "raster");
    const registration = events.filter(event => event.kind === "match").map(event => event.request);
    assert.equal(raster.length, 4, store.getState().exposure.error);
    assert.equal(raster[0].request.resolution, 512);
    assert.equal(raster[0].request.dwell, 3);
    assert.deepEqual(raster[0].request.roi, {x_start: 0, x_end: 16383, y_start: 0, y_end: 16383});
    assert.ok(raster.every(event => JSON.stringify(event.request) === JSON.stringify(raster[0].request)));
    assert.deepEqual(registration.map(request => request.pass_index), [0, 2, 3, 4]);
    for (const [index, request] of registration.entries()) {
      assert.equal(request.reference, registration[0].reference);
      assert.equal(request.mask, registration[0].mask);
      assert.equal(request.resolution, 512);
      assert.equal(request.pitch_x, 32);
      assert.equal(request.pitch_y, 32);
      const pixels = Buffer.from(request.current, "base64");
      assert.equal(pixels.readUInt16LE(0), (index + 1) * 257);
      assert.equal(pixels.readUInt16LE(2 * (256 * 512 + 256)), 0);
    }
    assert.equal(registration[0].reference, registration[0].current);
    const passes = [];
    for (let index = 0; index < events.length; index++) {
      const {kind, request} = events[index];
      if (kind === "match") {
        assert.equal(events[index - 1].kind, "raster");
        passes.push([]);
      }
      if (kind === "vector") passes.at(-1).push(request.lattice);
    }
    assert.ok(passes[0].length > 1, "exercise multiple segments in each pass");
    const chunks = passes[0].map(({shape, cell_start, cell_end}) => ({shape, cell_start, cell_end}));
    for (const [index, offset] of [undefined, [32, -64], [-96, 32]].entries()) {
      assert.deepEqual(passes[index].map(({shape, cell_start, cell_end}) => ({shape, cell_start, cell_end})), chunks);
      assert.ok(passes[index].every(chunk => JSON.stringify(chunk.dac_offset) === JSON.stringify(offset)));
    }
    assert.deepEqual(passes[3], [], "failed match must stop before any segment of the next pass");
    assert.equal(store.getState().exposure.phase, "error");
    assert.equal(store.getState().scan, initialScan);

    events.length = 0;
    matches.set(4, [2000, 64]);
    capabilities = {...capabilities, milling_registration_resolutions: [512, 1024]};
    await act(async () => { await store.dispatch(fetchDefaultsMetadata()).unwrap(); });
    assert.deepEqual(selector.findAllByType("option").map(option => option.props.value), [512, 1024]);
    await act(async () => { selector.props.onChange({target: {value: "1024"}}); });
    await act(async () => driftLimit.props.onChange({target: {value: "3.5"}}));
    await run();
    assert.equal(store.getState().exposure.phase, "completed", store.getState().exposure.error);
    assert.equal(events.filter(event => event.kind === "raster").length, 4, "no raster after the last pass");
    assert.ok(events.filter(event => event.kind === "raster").every(event => event.request.resolution === 1024));
    for (const {request} of events.filter(event => event.kind === "match")) {
      assert.equal(request.resolution, 1024);
      assert.deepEqual([request.pitch_x, request.pitch_y], [16, 16]);
      const mask = Buffer.from(request.mask, "base64");
      assert.equal(mask.length, 1024 ** 2);
      assert.equal(mask[512 * 1024 + 335], 0, "the 3.5 µm limit expands the reference mask");
      assert.equal(mask[512 * 1024 + 260], 1);
      assert.equal(request.radius_x, 182);
      assert.equal(request.radius_y, 182);
      assert.equal(Buffer.from(request.current, "base64").length, 2 * 1024 ** 2);
      assert.equal(Buffer.from(request.current, "base64").readUInt16LE(2 * (512 * 1024 + 512)), 0);
    }
    assert.notEqual(events.find(event => event.kind === "match").request.reference, registration[0].reference,
      "each run captures its own reference");
    assert.deepEqual(events.at(-1).request.lattice.dac_offset, [2000, 64]);

    events.length = 0;
    capabilities = {...capabilities, milling_registration_resolutions: [512]};
    await run();
    assert.equal(store.getState().exposure.phase, "error");
    assert.deepEqual(events, [], "a changed service must reject the stale choice before any raster or exposure");
    await act(async () => { await store.dispatch(fetchDefaultsMetadata()).unwrap(); });
    assert.equal(selector.props.value, 512);
    assert.deepEqual(selector.findAllByType("option").map(option => option.props.value), [512]);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    await vite.close();
    Object.assign(globalThis, previous);
  }
});
