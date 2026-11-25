import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulationExposureSteps, preparePatternExposure } from "../.test-dist/lib/patternExposure.js";
import { sampleExposureLattice, exposureTraceFraction, exposureHeadFraction } from "../.test-dist/lib/exposurePreview.js";
import { latticeSpec } from "../.test-dist/lib/exposurePlan.js";
import { MODEL_REGISTRY } from "../.test-dist/lib/processingPatterns.js";
import { parseLensLookup } from "../.test-dist/lib/lensLookup.js";

const roi = { x_start: 0, x_end: 1, y_start: 0, y_end: 1 };
const parameters = { steps: 5, depth: 1, direction: "down", beamCurrent: 150, dwell: 1, overlap: 50, passes: 2, axis: "x" };
const lens = parseLensLookup(JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json", import.meta.url))).LensLookup);
const fov = { x_origin: 0, x_end: 1, y_origin: 0, y_end: 1 };

test("five overlapping boxes produce increasing exposure layers in the requested direction", () => {
  for (const direction of ["down", "up", "left", "right"]) {
    const steps = simulationExposureSteps({model:"StairCutModel"}, roi, {...parameters,direction}, 0.0175, Array.from({length:5},()=>({removalRate:0.27})));
    assert.equal(steps.length, 5);
    for (let i=0;i<5;i++) {
      const band=steps[i].depthBand;
      const x=(band.x_start+band.x_end)/2, y=(band.y_start+band.y_end)/2;
      assert.equal(steps.filter(s=>MODEL_REGISTRY.StairCutModel.contains(s.shape,x,y)).length,i+1);
      assert.ok(Math.abs(steps[i].requestedDepthUM - (i+1)/5) < 1e-9);
    }
    assert.deepEqual(steps[0].shape,roi);
  }
});

test("cleaning steps are one row or column, centred on the saved line spacing", () => {
  for (const orientation of ["horizontal","vertical"]) {
    const steps = simulationExposureSteps({model:"CleaningLineModel"},roi,{...parameters,orientation,spacing:0.2,removalRate:0.27},0.0175);
    assert.equal(steps.length,5);
    for (const [i,step] of steps.entries()) {
      const prepared=preparePatternExposure({model:"CleaningLineModel",caption:"Clean line"},step.shape,step.parameters,lens,fov);
      assert.equal(orientation === "horizontal" ? prepared.plan.lattice.ny : prepared.plan.lattice.nx,1);
      assert.equal(prepared.lattice.axis,orientation === "horizontal" ? "x" : "y");
      const l=prepared.plan.lattice;
      const center=orientation === "horizontal" ? l.y0+l.pitchY/2 : l.x0+l.pitchX/2;
      assert.ok(Math.abs(center-(i+0.5)*0.2)<1e-9);
    }
  }
});

test("invalid and excessive cleaning workflows fail before queue construction",()=>{
  for (const spacing of [0,-1,NaN,Infinity,3,0.0001])
    assert.throws(()=>simulationExposureSteps({model:"CleaningLineModel"},roi,{...parameters,spacing},0.0175));
  assert.equal(simulationExposureSteps({model:"CleaningLineModel"},roi,{...parameters,spacing:0.001},0.0175).length,1000);
});

test("small preview preserves exact serpentine order on both axes",()=>{
  for (const axis of ["x","y"]) {
    const l=latticeSpec(roi,0.25,axis), points=sampleExposureLattice("SolidBoxModel",roi,l,100);
    assert.equal(points.length,16);
    assert.ok(points[4].order > points[3].order);
    assert.equal(points[0].connect,false);
    assert.equal(points[4].connect,true);
    const coordinate=axis === "x" ? "x" : "y";
    assert.ok(points[1][coordinate]>points[0][coordinate]);
    assert.ok(points[5][coordinate]<points[4][coordinate]);
  }
});

test("multi-million-point preview remains bounded and clipped to a ring",()=>{
  const ring={cx:0.5,cy:0.5,r_inner:0.2,r_outer:0.5};
  const points=sampleExposureLattice("RingModel",ring,latticeSpec(ring,0.0001,"y"),1000);
  assert.ok(points.length>0 && points.length<=1000);
  assert.ok(points.every(p=>MODEL_REGISTRY.RingModel.contains(ring,p.x,p.y)));
  assert.ok(points.every(p=>!p.connect));
});

test("completed trace persists; absent samples never fabricate progress",()=>{
  assert.equal(exposureTraceFraction(0,100,false),0);
  assert.equal(exposureTraceFraction(25,100,false),0.25);
  assert.equal(exposureTraceFraction(250,100,false),0.5);
  assert.equal(exposureTraceFraction(0,100,true),1);
});

test("preview head wraps on later passes while the footprint stays visible",()=>{
  assert.equal(exposureHeadFraction(0,100),0);
  assert.equal(exposureHeadFraction(100,100),0);
  assert.equal(exposureHeadFraction(125,100),0.25);
  assert.equal(exposureTraceFraction(125,100,false),0.25);
});

test("production Run plans one serial lattice row per cleaning line, same as simulation", async () => {
  const { prepareExposureSequence, exposureRuns } = await import("../.test-dist/lib/exposureSequence.js");
  const spec = { key: "clean", caption: "Cleaning line", model: "CleaningLineModel", roi: "rect" };
  const field = { x_origin: 0, x_end: 50, y_origin: 0, y_end: 50 };
  const cleanRoi = { x_start: 10, x_end: 18, y_start: 10, y_end: 16 };
  for (const orientation of ["horizontal", "vertical"]) {
    const queues = [true, false].map(simulation => prepareExposureSequence({ lensLookup: lens, specs: [spec], materials: [{ name: "Si", brightness: 1, removalRateUM3PerNC: 0.27 }],
      roiCreationOrder: ["clean"], instances: { clean: { enabled: true, roi: cleanRoi,
        parameters: { ...parameters, orientation, spacing: 0.2, passes: 2 } } } }, field, simulation));
    const [sim, prod] = queues;
    assert.equal(prod.length, orientation === "horizontal" ? 30 : 40, "one step per line, not one solid lattice");
    assert.deepEqual(prod.map(e => e.request.lattice), sim.map(e => e.request.lattice), "production matches simulation");
    for (const e of prod) {
      assert.equal(orientation === "horizontal" ? e.node.exposure.plan.lattice.ny : e.node.exposure.plan.lattice.nx, 1);
      assert.equal(e.node.exposure.lineSpacingUM, 0.2);
    }
    // Serial: all passes of line N finish before line N+1 starts.
    // Passes come from depth / Sr, so each line repeats thousands of times; collapse the repeats.
    const passes = prod[0].request.lattice.passes;
    assert.ok(passes > 1000);
    const order = [...exposureRuns(prod.slice(0, 3), false)].map(run => run.entry.node.id);
    assert.equal(order.length, prod.slice(0, 3).reduce((n, e) => n + e.request.lattice.passes, 0));
    assert.deepEqual([...new Set(order)], [0, 1, 2].map(i => `clean:${i}:exposure`));
    assert.deepEqual(order.slice(0, passes), Array(passes).fill("clean:0:exposure"), "all passes of line N finish before line N+1");
  }
});
