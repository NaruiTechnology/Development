import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import {Provider} from "react-redux";
import {act, create} from "react-test-renderer";
import {createServer} from "vite";

function gridConfig() {
  return {ssr: {noExternal: ["ag-grid-react"]}, plugins: [{name: "test-grid", enforce: "pre",
    resolveId(id) {if (id === "ag-grid-react") return "\0test-grid";},
    load(id) {if (id === "\0test-grid") return 'import React from "react"; export const AgGridReact = props => React.createElement("test-grid", props);';}}]};
}

async function harness({canManage = true, conflict = false, missing = false} = {}) {
  const old = {window: globalThis.window, fetch: globalThis.fetch};
  globalThis.window = {location: {hostname: "example.test", port: "", protocol: "http:", host: "example.test"},
    localStorage: {getItem: () => null, setItem() {}}, addEventListener() {}, removeEventListener() {}};
  const calls = []; let saved = 0;
  const collection = {model: "StairRecipeDefaults", caption: "Test recipe", stepDefaults: {dwellUS: 1, overlapPercent: 50, passes: 1, after: "none"},
    nodes: [{name: "28nm", steps: [0.2, 0.4].map(depthUM => ({enabled: true, depthUM, material: "Si", removalRateUM3PerNC: 0.27,
      dwellUS: 1, overlapPercent: 50, passes: 1, after: "none"}))}]};
  globalThis.fetch = async (url, options = {}) => {
    calls.push({url: String(url), ...options});
    const isRecipe = String(url).includes("/pattern-recipes/");
    const isDefaults = String(url).includes("/pattern-recipe-defaults/");
    const failed = options.method === "PUT" && conflict;
    const response = {ok: !failed, status: failed ? 409 : 200, json: async () => failed ? {ok: false, error: "Recipes changed in another session. Reload before saving."}
      : isDefaults ? {ok: true, collections: [{SMProcess: {...collection, nodes: ["28nm", "14nm", "7nm", "5nm", "2nm", "1nm"].map(name => ({name, steps: collection.nodes[0].steps}))}}]}
      : isRecipe ? {ok: true, recipe: missing && options.method !== "PUT" ? null : {equipment_id: 1290, pattern_key: "stairCut",
        collections: options.body ? JSON.parse(options.body).collections : [{SMProcess: collection}], revision: options.method === "PUT" ? 4 : 3}}
      : {ok: true, patterns: [{key: "stairCut", caption: "Stair cut"}]}};
    response.headers = new Headers({"content-type": "application/json"});
    response.text = async () => JSON.stringify(await response.json());
    return response;
  };
  const vite = await createServer({...gridConfig(), server: {middlewareMode: true, watch: null, ws: false}, optimizeDeps: {noDiscovery: true, include: []}, appType: "custom"});
  const {store} = await vite.ssrLoadModule("/src/store/index.ts");
  const {ProcessingPatternCards, ProcessingPatternsPanel} = await vite.ssrLoadModule("/src/components/ProcessingPatternsPanel.tsx");
  const processing = await vite.ssrLoadModule("/src/store/processingSlice.ts");
  const {PatternRecipesPanel} = await vite.ssrLoadModule("/src/components/PatternRecipesPanel.tsx");
  let renderer;
  await act(async () => {renderer = create(React.createElement(Provider, {store}, React.createElement(PatternRecipesPanel,
    {equipment: [{id: 1290, name: "DB235", site: "Test", serial_number: "123"}], initialEquipmentId: 1290,
      canManage, onSaved: () => saved++})));});
  const button = text => renderer.root.findAllByType("button").find(node => node.children.includes(text));
  const grid = () => renderer.root.findByType("test-grid");
  const editStep = async index => {await act(async () => grid().props.context.edit(index));};
  const dialog = () => renderer.root.findByProps({role: "dialog"});
  return {renderer, calls, button, grid, editStep, dialog, store, processing, ProcessingPatternCards, ProcessingPatternsPanel, get saved() {return saved;}, close: async () => {
    await act(async () => renderer.unmount()); await vite.close(); Object.assign(globalThis, old);
  }};
}

test("recipe editor loads the linked equipment, edits steps, and saves with its revision", async () => {
  const h = await harness();
  try {
    assert.equal(h.renderer.root.findByProps({"aria-label": "Equipment"}).props.value, 1290);
    assert.equal(h.renderer.root.findByProps({"aria-label": "Technology node"}).findByType("option").children[0], "28nm");
    await h.editStep(0);
    await act(async () => h.dialog().findByProps({"aria-label": "Dwell (µs)"}).props.onChange({target: {value: "7"}}));
    await act(async () => h.button("Update").props.onClick());
    assert.equal(h.renderer.root.findByProps({"aria-label": "Equipment"}).props.disabled, true);
    await act(async () => h.renderer.root.findAllByType("fieldset")[0].findAllByType("input")[0].props.onChange({target: {value: "4"}}));
    assert.equal(h.grid().props.rowData[0].dwellUS, 7);
    assert.equal(h.grid().props.rowData[1].dwellUS, 4);
    await act(async () => {await h.button("Save recipes").props.onClick();});
    const call = h.calls.find(item => item.method === "PUT");
    assert.ok(call.url.endsWith("/1290/stairCut"));
    const payload = JSON.parse(call.body);
    assert.equal(payload.expected_revision, 3);
    assert.equal(payload.collections[0].SMProcess.nodes[0].steps[0].dwellUS, 7);
    assert.equal(h.saved, 1);
  } finally {await h.close();}
});

test("conflicting saves retain the edited recipe and show the server error", async () => {
  const h = await harness({conflict: true});
  try {
    await h.editStep(0);
    await act(async () => h.dialog().findByProps({"aria-label": "Dwell (µs)"}).props.onChange({target: {value: "9"}}));
    await act(async () => h.button("Update").props.onClick());
    await act(async () => {await h.button("Save recipes").props.onClick();});
    assert.match(h.renderer.root.findByProps({role: "alert"}).children.join(""), /another session/);
    assert.equal(h.grid().props.rowData[0].dwellUS, 9);
    assert.equal(h.saved, 0);
  } finally {await h.close();}
});

test("an unassigned equipment/pattern can create a draft, and readonly accounts cannot save", async () => {
  const h = await harness({missing: true, canManage: false});
  try {assert.equal(h.button("Create recipes").props.disabled, true);}
  finally {await h.close();}
  const editable = await harness({missing: true});
  try {
    await act(async () => {await editable.button("Create recipes").props.onClick();});
    assert.equal(editable.grid().props.rowData.length, 2);
    assert.deepEqual(editable.renderer.root.findByProps({"aria-label": "Technology node"}).findAllByType("option").map(option => option.children[0]),
      ["28nm", "14nm", "7nm", "5nm", "2nm", "1nm"]);
    await act(async () => {await editable.button("Save recipes").props.onClick();});
    assert.equal(JSON.parse(editable.calls.find(item => item.method === "PUT").body).expected_revision, 0);
  } finally {await editable.close();}
});


test("Equipment recipe column opens the relationship for that equipment ID", async () => {
  const old = globalThis.window;
  globalThis.window = {localStorage: {getItem: () => null}};
  const vite = await createServer({
    ssr: {noExternal: ["ag-grid-react"]},
    plugins: [{name: "test-grid", enforce: "pre", resolveId(id) {if (id === "ag-grid-react") return "\0test-grid";},
      load(id) {if (id === "\0test-grid") return 'import React from "react"; export const AgGridReact = props => React.createElement("test-grid", props);';}}],
    server: {middlewareMode: true, watch: null, ws: false}, optimizeDeps: {noDiscovery: true, include: []}, appType: "custom"});
  let renderer; let cell; let opened;
  try {
    const {EquipmentGrid} = await vite.ssrLoadModule("/src/components/EquipmentGrid.tsx");
    const {store} = await vite.ssrLoadModule("/src/store/index.ts");
    await act(async () => {renderer = create(React.createElement(Provider, {store}, React.createElement(EquipmentGrid, {equipment: [{id: 1290, name: "FIB200"}],
      disabled: false, actionDisabled: false, canManage: true, recipeCounts: {1290: 2}, onOpenRecipes: id => opened = id,
      onDelete() {}, onApplyEdit() {}, onBlockedAction() {}})));});
    const grid = renderer.root.findByType("test-grid");
    const column = grid.props.columnDefs.find(item => item.colId === "patternRecipes");
    assert.equal(column.headerName, "Pattern recipes");
    await act(async () => {cell = create(React.createElement(column.cellRenderer, {data: {id: 1290}, context: grid.props.context}));});
    assert.deepEqual(cell.root.findByType("button").children, ["2 patterns"]);
    await act(async () => cell.root.findByType("button").props.onClick());
    assert.equal(opened, 1290);
  } finally {
    await act(async () => {cell?.unmount(); renderer?.unmount();}); await vite.close(); globalThis.window = old;
  }
});


test("step modal Cancel, validation, add and delete preserve the staged recipe", async () => {
  const h = await harness();
  try {
    assert.equal(h.renderer.root.findAllByProps({"aria-label": "Node name"}).length, 0);
    assert.ok(h.grid().props.columnDefs.some(column => column.colId === "actions" && column.pinned === "right"));
    await h.editStep(0);
    await act(async () => h.dialog().findByProps({"aria-label": "Dwell (µs)"}).props.onChange({target: {value: "8"}}));
    await act(async () => h.button("Cancel").props.onClick());
    assert.equal(h.grid().props.rowData[0].dwellUS, 1);
    assert.equal(h.button("Save recipes").props.disabled, true);
    await h.editStep(0);
    await act(async () => h.dialog().findByProps({"aria-label": "Depth (µm)"}).props.onChange({target: {value: "2"}}));
    await act(async () => h.button("Update").props.onClick());
    assert.match(h.dialog().findByProps({role: "alert"}).children.join(""), /shallower|increase/);
    await act(async () => h.button("Cancel").props.onClick());
    const add = () => h.renderer.root.findByProps({"aria-label": "Add step"});
    await act(async () => add().props.onClick());
    assert.equal(h.grid().props.rowData.length, 2);
    await act(async () => h.button("Update").props.onClick());
    assert.equal(h.grid().props.rowData.length, 3);
    assert.ok(Math.abs(h.grid().props.rowData[2].depthUM - 0.6) < 1e-9);
    await act(async () => h.grid().props.context.remove(1));
    assert.equal(h.grid().props.rowData.length, 2);
    assert.equal(h.grid().props.rowData[1].material, "Si");
    assert.equal(h.calls.filter(call => call.method === "PUT").length, 0);
  } finally {await h.close();}
});


test("Admin technology nodes save and populate the Stair cut selector from the database response", async () => {
  const h = await harness(); let cards;
  try {
    await act(async () => h.button("Add node").props.onClick());
    await act(async () => h.dialog().findByProps({"aria-label": "Node name"}).props.onChange({target: {value: "14nm"}}));
    await act(async () => h.button("Update").props.onClick());
    assert.equal(h.renderer.root.findByProps({"aria-label": "Technology node"}).props.value, 1);
    await act(async () => h.renderer.root.findByProps({"aria-label": "Edit technology node"}).props.onClick());
    await act(async () => h.dialog().findByProps({"aria-label": "Node name"}).props.onChange({target: {value: "7nm"}}));
    await act(async () => h.button("Update").props.onClick());
    await act(async () => {await h.button("Save recipes").props.onClick();});
    const saved = JSON.parse(h.calls.find(call => call.method === "PUT").body);
    const names = saved.collections[0].SMProcess.nodes.map(node => node.name);
    assert.deepEqual(names, ["28nm", "7nm"]);
    const payload = {recipeEquipmentId: 1290, stairReceipes: saved.collections[0], patterns: [
      {key: "stairCut", caption: "Stair cut", model: "StairCutModel", roi: "rect", parameters: [], icon: "patternStairCut"}]};
    const id = h.store.getState().processing.recipeRequestId;
    await act(async () => h.store.dispatch(h.processing.fetchProcessingPatterns.fulfilled(payload, id)));
    await act(async () => {cards = create(React.createElement(Provider, {store: h.store}, React.createElement(h.ProcessingPatternCards, {disabled: false})));});
    const selector = () => cards.root.findByProps({"aria-label": "Stair cut: Technology node"});
    assert.deepEqual(selector().findAllByType("option").map(option => option.props.value), names);
    await act(async () => selector().props.onChange({target: {value: "7nm"}}));
    assert.equal(h.store.getState().processing.instances.stairCut.stairRecipeNode, "7nm");
    assert.equal(h.store.getState().processing.instances.stairCut.parameters.steps, 2);
  } finally {await act(async () => cards?.unmount()); await h.close();}
});

test("PATTERNS shows a spinner during catalogue/recipe loading and clears it afterward", async () => {
  const h = await harness(); let panel;
  try {
    h.store.dispatch(h.processing.fetchProcessingPatterns.pending("loading-test"));
    await act(async () => {panel = create(React.createElement(Provider, {store: h.store}, React.createElement(h.ProcessingPatternsPanel, {disabled: false, visible: true})));});
    assert.equal(panel.root.findByProps({"aria-busy": true}).props.className.includes("patterns-card"), true);
    assert.equal(panel.root.findAllByProps({className: "loading-spinner__gif"}).length, 1);
    await act(async () => h.store.dispatch(h.processing.fetchProcessingPatterns.fulfilled({patterns: []}, "loading-test")));
    assert.equal(panel.root.findAllByProps({className: "loading-spinner__gif"}).length, 0);
    assert.equal(panel.root.findByProps({"aria-busy": false}).props.className.includes("patterns-card"), true);
  } finally {await act(async () => panel?.unmount()); await h.close();}
});
