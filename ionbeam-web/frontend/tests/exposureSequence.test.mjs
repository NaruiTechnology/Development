import test from "node:test";
import assert from "node:assert/strict";
import { exposureRuns } from "../.test-dist/lib/exposureSequence.js";
const entry=(key,id,passes,model="StairCutModel")=>({key,node:{id,exposure:{model}},request:{pattern:"lattice",lattice:{passes}}});
test("serial finishes every pass of a step before advancing",()=>{
 const a=entry("A","A0",2),b=entry("B","B0",3);
 const runs=[...exposureRuns([a,b],false)];
 assert.deepEqual(runs.map(r=>[r.entry.node.id,r.request.lattice.passes,r.final]),[["A0",2,true],["B0",3,true]]);
});
test("parallel alternates pattern passes and preserves stair step dependencies",()=>{
 const entries=[entry("A","A0",2),entry("A","A1",2),entry("B","B0",3)];
 const runs=[...exposureRuns(entries,true)];
 assert.deepEqual(runs.map(r=>r.entry.node.id),["A0","B0","A0","B0","A1","B0","A1"]);
 assert.ok(runs.every(r=>r.request.lattice.passes===1));
 assert.deepEqual(runs.filter(r=>r.final).map(r=>r.entry.node.id),["A0","B0","A1"]);
 assert.equal(entries[0].request.lattice.passes,2,"planning snapshots are unchanged");
});
test("cleaning lines are explicitly serial and high-pass queues stay lazy",()=>{
 assert.throws(()=>exposureRuns([entry("C","C0",1,"CleaningLineModel")],true).next(),/serial/);
 const generator=exposureRuns([entry("A","A0",10000),entry("B","B0",10000)],true);
 assert.equal(generator.next().value.entry.key,"A");assert.equal(generator.next().value.entry.key,"B");
 generator.return();
});
