import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseLensLookup,lookupSpotSize,estimateMillingDepth} from "../.test-dist/lib/lensLookup.js";
const raw=JSON.parse(readFileSync(new URL("../../../GlasgowDataIO/Json/processingPatterns.json",import.meta.url))).LensLookup;
const table=parseLensLookup(raw);
test("imported table retains bounds, SLF flags and separate 10kV data",()=>{
 assert.equal(table.rows.length,11);assert.equal(table.notes.length,6);
 assert.equal(table.rows[0].beamCurrentPA,"<1");assert.equal(table.rows[7].lens1KV,"5.82*");assert.equal(table.rows[10].stepsBetweenApertures,null);
 assert.equal(lookupSpotSize(table,30,150).spotSizeNM,35);
 assert.equal(lookupSpotSize(table,30,150).spotSizeUM,0.035);
 assert.equal(lookupSpotSize(table,10,250).spotSizeNM,300);
 assert.equal(lookupSpotSize(table,30,2700).requiresSLF,true);
});
test("interpolation is opt-in; voltage crossing, bounds and extrapolation are rejected",()=>{
 assert.equal(lookupSpotSize(table,30,250).status,"unavailable");
 assert.equal(lookupSpotSize(table,30,250,true).spotSizeNM,45);
 assert.deepEqual(lookupSpotSize(table,30,250,true).sourceRows,[6,7]);
 for(const [v,c] of [[10,150],[30,0.5],[30,1],[30,20000],[20,150]])assert.equal(lookupSpotSize(table,v,c,true).status,"unavailable");
 assert.throws(()=>lookupSpotSize(table,30,NaN));
 const bad=structuredClone(raw);bad.rows[0].spotSizeAngstrom=NaN;assert.throws(()=>parseLensLookup(bad));
 const dup=structuredClone(raw);dup.rows[1].beamCurrentPA=dup.rows[2].beamCurrentPA;assert.throws(()=>parseLensLookup(dup));
});
test("milling estimate requires material removal rate and beam-on exposure, with explicit units",()=>{
 assert.deepEqual(estimateMillingDepth(1000,1,4,2),{chargeNC:1,volumeUM3:2,depthUM:0.5});
 assert.equal(estimateMillingDepth(0,1,4,2).depthUM,0);
 assert.throws(()=>estimateMillingDepth(1000,1,4,undefined));assert.throws(()=>estimateMillingDepth(1000,1,0,2));
});
