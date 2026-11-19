import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

test("selecting Milling applies database pass defaults to every card", async () => {
  const vite = await createServer({server:{middlewareMode:true,watch:null,ws:false}, optimizeDeps:{noDiscovery:true,include:[]},appType:"custom"});
  try {
  const {default:reducer, fetchProcessingPatterns, applyMillingPassDefaults, setPatternParameter} = await vite.ssrLoadModule("/src/store/processingSlice.ts");
  const patterns = ["solidBox", "openBox", "line", "cleaningLine", "circle", "ring", "polygon", "freeHand"].map(key => ({
    key, model: "CircleModel", roi: "circle", caption: key, icon: "", parameters: [
      { name: "passes", type: "int", default: 3, min: 1, max: 10000 },
      { name: "dwell", type: "float", default: 1 },
    ],
  }));
  let state = reducer(undefined, fetchProcessingPatterns.fulfilled({patterns}, "test"));
  for (const {key} of patterns) state = reducer(state, setPatternParameter({key, name: "passes", value: 1}));
  state = reducer(state, applyMillingPassDefaults());
  for (const {key} of patterns) {
    assert.equal(state.instances[key].parameters.passes, 3);
    assert.equal(state.instances[key].parameters.dwell, 1);
  }
  state = reducer(state, setPatternParameter({key: "circle", name: "passes", value: 5}));
  assert.equal(state.instances.circle.parameters.passes, 5, "passes remain editable after selecting Milling");
  } finally { await vite.close(); }
});
