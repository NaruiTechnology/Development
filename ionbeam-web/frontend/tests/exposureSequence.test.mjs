import test from "node:test";
import assert from "node:assert/strict";
import { exposureRounds, exposureRuns, exposureSegments } from "../.test-dist/lib/exposureSequence.js";
const entry=(key,id,passes,model="StairCutModel")=>({key,node:{id,exposure:{model}},request:{pattern:"lattice",lattice:{passes}}});
test("serial finishes every pass of a step before advancing",()=>{
 const a=entry("A","A0",2),b=entry("B","B0",3);
 const runs=[...exposureRuns([a,b],false)];
 assert.deepEqual(runs.map(r=>[r.entry.node.id,r.request.lattice.passes,r.final]),[["A0",1,false],["A0",1,true],["B0",1,false],["B0",1,false],["B0",1,true]]);
});
test("parallel alternates pattern passes and preserves stair step dependencies",()=>{
 const entries=[entry("A","A0",2),entry("A","A1",2),entry("B","B0",3)];
 const runs=[...exposureRuns(entries,true)];
 assert.deepEqual(runs.map(r=>r.entry.node.id),["A0","B0","A0","B0","A1","B0","A1"]);
 assert.ok(runs.every(r=>r.request.lattice.passes===1));
 assert.deepEqual(runs.filter(r=>r.final).map(r=>r.entry.node.id),["A0","B0","A1"]);
 assert.equal(entries[0].request.lattice.passes,2,"planning snapshots are unchanged");
});
test("parallel rounds schedule a pass from each enabled pattern before either advances",()=>{
 const entries=[entry("A","A0",2),entry("B","B0",2)];
 const rounds=[...exposureRounds(entries,true)];
 assert.deepEqual(rounds.map(round=>round.map(run=>[run.entry.key,run.final])),[
  [["A",false],["B",false]], [["A",true],["B",true]],
 ]);
});
test("cleaning lines are explicitly serial and high-pass queues stay lazy",()=>{
 assert.throws(()=>exposureRuns([entry("C","C0",1,"CleaningLineModel")],true).next(),/serial/);
 const generator=exposureRuns([entry("A","A0",10000),entry("B","B0",10000)],true);
 assert.equal(generator.next().value.entry.key,"A");assert.equal(generator.next().value.entry.key,"B");
 generator.return();
});


test("exposure segments cover the original cells once and bound dwell between View opportunities", () => {
    for (const shape of [
      {kind: "rect", x0: 0, x1: 1000, y0: 0, y1: 1000},
      {kind: "ellipse", cx: 500, cy: 500, rx: 500, ry: 500, inner_rx: 250, inner_ry: 250},
      {kind: "polygon", points: [[0,0],[1000,0],[0,1000]]},
    ]) {
      const segments = [...exposureSegments({shape, pitch_x: 1, pitch_y: 1, axis: "y", dwell: 7, passes: 1})];
      assert.equal(segments[0].cell_start, 0);
      assert.equal(segments.at(-1).cell_end, 1_000_000);
      let end = 0;
      for (const segment of segments) {
        assert.equal(segment.cell_start, end);
        assert.ok((segment.cell_end - segment.cell_start) * (segment.dwell + 1) <= 800000);
        end = segment.cell_end;
      }
    }
});
