import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveStairSteps, stairStepsError, stairStepParameters, parseStairStepsImport, stairStepsToCsv } from "../.test-dist/lib/stairRecipe.js";
import { stairExposureSteps, simulationExposureSteps } from "../.test-dist/lib/patternExposure.js";
import { prepareExposureSequence } from "../.test-dist/lib/exposureSequence.js";

const lensLookup = JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url))).LensLookup;
const params = { axis: "x", beamCurrent: 150, dwell: 1, overlap: 50, steps: 5, depth: 5, direction: "down" };
const roi = { x_start: 0, x_end: 10, y_start: 0, y_end: 10 };
const spec = { key: "stairs", caption: "Stair cut", model: "StairCutModel", roi: "rect" };
const field = { x_origin: 0, x_end: 100, y_origin: 0, y_end: 100 };
const state = (extra = {}) => ({ lensLookup, specs: [spec],
  instances: { stairs: { enabled: true, roi, parameters: params, ...extra } } });

test("defaults reproduce the previous even depth split with card-level recipe", () => {
  const steps = resolveStairSteps(params);
  assert.deepEqual(steps.map(s => s.depth), [1, 2, 3, 4, 5]);
  assert.ok(steps.every(s => s.dwell === 1 && s.overlap === 50 && s.passes === 1 && s.enabled && s.removalRate === 0));
  const old = simulationExposureSteps(spec, roi, params, 0.0175);
  assert.equal(old.length, 5);
  assert.deepEqual(old.map(s => s.requestedDepthUM), [1, 2, 3, 4, 5]);
});

test("overrides touch only their step; untouched steps still follow card parameters", () => {
  const steps = resolveStairSteps({ ...params, dwell: 2 }, [{}, { dwell: 4, passes: 3, material: "Cu" }]);
  assert.deepEqual(steps.map(s => s.dwell), [2, 4, 2, 2, 2]);
  assert.equal(steps[1].passes, 3);
  assert.equal(steps[1].material, "Cu");
  assert.equal(steps[0].passes, 1);
});

test("validation names the step and rejects shallower or out-of-range values", () => {
  assert.equal(stairStepsError(resolveStairSteps(params)), null);
  assert.match(stairStepsError(resolveStairSteps(params, [{}, {}, { depth: 1.5 }])), /step 3.*shallower/);
  assert.match(stairStepsError(resolveStairSteps(params, [{ passes: 1.5 }])), /step 1.*passes/);
  assert.match(stairStepsError(resolveStairSteps(params, [{ overlap: 100 }])), /step 1.*overlap/);
  assert.match(stairStepsError(resolveStairSteps(params, [{ dwell: 0 }])), /dwell/);
  const none = resolveStairSteps(params, Array(5).fill({ enabled: false }));
  assert.match(stairStepsError(none), /enable at least one/);
});

test("a calibrated removal rate derives dose from the layer this step adds", () => {
  const steps = resolveStairSteps(params, [{}, { removalRate: 0.5 }]);
  const p = stairStepParameters(params, steps, 1);
  assert.equal(p.targetDose, 2);               // (2 - 1) um / 0.5 um^3/nC
  assert.equal(stairStepParameters(params, steps, 0).targetDose, undefined);
});

test("disabled steps are skipped but keep their strip geometry and depth labels", () => {
  const steps = stairExposureSteps(roi, params, [{}, { enabled: false }]);
  assert.equal(steps.length, 4);
  assert.deepEqual(steps.map(s => s.caption), ["Step 1 / 5", "Step 3 / 5", "Step 4 / 5", "Step 5 / 5"]);
  assert.equal(steps[1].requestedDepthUM, 3);
});

test("production Run now expands Stair cut into one lattice per step with that step's dwell and passes", () => {
  const entries = prepareExposureSequence(state({ stairSteps: [{ dwell: 2, passes: 3, material: "Si" }, {}, { dwell: 4 }] }), field, false);
  assert.equal(entries.length, 5);
  assert.equal(entries[0].request.lattice.passes, 3);
  assert.equal(entries[0].node.exposure.dwellUS, 2);
  assert.equal(entries[0].node.exposure.material, "Si");
  assert.equal(entries[2].node.exposure.dwellUS, 4);
  assert.equal(entries[1].request.lattice.passes, 1);
  assert.equal(entries[4].node.exposure.requestedDepthUM, 5);
  assert.equal(entries.every(e => e.node.exposure.simulation === false), true);
});

test("Sr-derived passes follow the incremental layer, not the cumulative depth", () => {
  const entries = prepareExposureSequence(state({ stairSteps: [{ removalRate: 1e-4 }, { removalRate: 2e-4 }] }), field, false);
  const [a, b] = entries;
  assert.equal(a.node.exposure.incrementUM, 1);
  assert.equal(b.node.exposure.incrementUM, 1);
  // same layer thickness, twice the Sr => half the dose => no more passes than step 1
  assert.ok(b.request.lattice.passes <= a.request.lattice.passes);
  assert.ok(a.request.lattice.passes > 1);
});

test("an invalid recipe fails before any request is built", () => {
  assert.throws(() => prepareExposureSequence(state({ stairSteps: [{}, {}, { depth: 0.5 }] }), field, false), /step 3/);
});

test("other patterns keep their single production lattice", () => {
  const solid = { key: "box", caption: "Box", model: "SolidBoxModel", roi: "rect" };
  const s = { lensLookup, specs: [solid], instances: { box: { enabled: true, roi, parameters: params } } };
  assert.equal(prepareExposureSequence(s, field, false).length, 1);
});

test("import: CSV and JSON map to sparse overrides, errors cite the row", () => {
  const csv = "step,depth,dwell,passes,material,removalRate,enabled\n1,1,,2,Si,,true\n2,2.5,3,,Cu,0.4,false\n";
  const o = parseStairStepsImport(csv);
  assert.deepEqual(o[0], { depth: 1, passes: 2, material: "Si", enabled: true });
  assert.deepEqual(o[1], { depth: 2.5, dwell: 3, material: "Cu", removalRate: 0.4, enabled: false });
  assert.deepEqual(parseStairStepsImport('{"steps":[{"depth":2},{"material":"W"}]}'), [{ depth: 2 }, { material: "W" }]);
  assert.throws(() => parseStairStepsImport("depth,bogus\n1,2"), /Row 1.*bogus/);
  assert.throws(() => parseStairStepsImport("depth,passes\n1,x"), /Row 1/);
  assert.throws(() => parseStairStepsImport("depth,passes\n1,1.5"), /whole number/);
  assert.throws(() => parseStairStepsImport("step,depth\n1,1\n1,2"), /twice/);
  assert.throws(() => parseStairStepsImport("   "), /empty/);
});

test("export round-trips through import", () => {
  const steps = resolveStairSteps(params, [{ material: 'Si, "doped"', passes: 2 }]);
  const back = resolveStairSteps(params, parseStairStepsImport(stairStepsToCsv(steps)));
  assert.deepEqual(back, steps);
});

test("Stair cut card renders a per-step table and edits only the chosen step", async () => {
  const { default: React } = await import("react");
  const { Provider } = await import("react-redux");
  const { act, create } = await import("react-test-renderer");
  const { createServer } = await import("vite");
  const old = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = { location: { hostname: "example.test", port: "", protocol: "http:", host: "example.test" },
    localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const vite = await createServer({ server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
  let renderer;
  try {
    const { store } = await vite.ssrLoadModule("/src/store/index.ts");
    const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
    const { ProcessingPatternCards } = await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
    const parameters = Object.entries({ beamCurrent: 150, dwell: 1, overlap: 50, axis: "x", steps: 5, depth: 5 })
      .map(([name, value]) => ({ name, label: name, type: typeof value === "string" ? "choice" : "float", default: value, min: null, max: null, step: 1, unit: "", choices: typeof value === "string" ? [value] : [] }));
    store.dispatch(processing.fetchProcessingPatterns.fulfilled({ patterns: [{ key: "stairs", caption: "Stair cut", model: "StairCutModel", roi: "rect", icon: "patternSolidBox", parameters }], lensLookup }, "t"));
    store.dispatch(processing.setPatternRoi({ key: "stairs", roi }));
    store.dispatch(processing.selectPattern("stairs"));
    await act(async () => { renderer = create(React.createElement(Provider, { store }, React.createElement(ProcessingPatternCards, { disabled: false }))); });
    assert.equal(renderer.root.findAll(n => n.type === "tr" && n.props["data-step"]).length, 5);
    const dwell3 = () => renderer.root.findByProps({ "aria-label": "Stair cut Step 3: Dwell (µs)" });
    await act(async () => { dwell3().props.onChange({ target: { value: "4" } }); });
    assert.deepEqual(store.getState().processing.instances.stairs.stairSteps[2], { dwell: 4 });
    assert.deepEqual(store.getState().processing.instances.stairs.stairSteps[0], {});
    await act(async () => { dwell3().props.onChange({ target: { value: "" } }); });
    assert.deepEqual(store.getState().processing.instances.stairs.stairSteps[2], {});
  } finally {
    renderer?.unmount();
    await vite.close();
    Object.assign(globalThis, old);
  }
});
