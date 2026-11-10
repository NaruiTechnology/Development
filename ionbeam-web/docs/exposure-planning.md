# Exposure planning in physical units (refactor iteration 1)

`frontend/src/lib/exposurePlan.ts` plans a pattern from beam physics instead of image pixels. Sources: the FEI *Pattern Scan Strategy* / *Beam Overlap* slides, the FIB Pattern technical notes (dose, dwell, DAC, point limits) and `LENS 1 PRELENS.xls` (beam current to spot size, already in `LensLookup`).

## Model

| Quantity | Formula | Source |
| --- | --- | --- |
| Spot diameter d | `lookupSpotSize(table, kV, I)` | lens table |
| Point spacing s | `d (1 - OL/100)`, i.e. `OL = (d - s) / d` | Beam Overlap slide |
| Lattice | whole number of spots per axis, cell-centred, serpentine along the long axis (or X/Y) | Pattern Scan Strategy slide, Axis Scan |
| Charge per spot | `I[pA] * dwell[us] * 1e-6` nC | |
| Dose per pass | charge per spot / (pitchX * pitchY) | |
| Passes | `ceil(dose / dose-per-pass)` unless set explicitly | |
| Beam-on time | `count * dwell * passes` | |
| Depth <-> dose | `depth = dose * Sr` (um^3/nC); needs a calibrated Sr, never defaulted | `.mtr` Sr |

Overlap 50% suits sputtering/imaging, 0% etching/depositing, -50% large gas patterns. `Count` is spots inside the true shape (`MODEL_REGISTRY.contains`), independent of `vector_resolution`. `exposureVectorPoints` merges spots that land on one DAC code and sums their dwell, so dose survives spacing finer than one DAC step; `planExposure` warns in that case when given the field width.

## Finding that shapes the next step

For the Free hand ROI in the reviewed screenshot (42.85 x 48.03 um, 150 pA, 35 nm spot, 50% overlap) the lattice has about 6.7 million spots, with about 3 passes at 1 us for 1 nC/um^2. That is above this app's 250,000-point list bound and above the manual's 1,000,000 limit. Client-built point lists therefore cannot carry physically spaced patterns of this size. `exposureSpots` throws rather than truncating.

## Not done in this iteration (proposed order)

1. Show spot size, spacing, Count and estimated beam-on time on the pattern card from `planExposure` (replaces the legacy "Point spacing (px)" idea).
2. Move lattice generation to `glasgow_service`: send the shape, pitch, axis, dwell and passes, and generate and stream points in chunks there. Reuse `latticeSpec` semantics so both sides agree.
3. Route the Default workflow through the plan; keep the gray-directed Spot workflows pixel-based until they have a physical equivalent.
4. Cleaning cross section and regular cross section recipes, Sr in the material catalogue, and the dwell-unit trap (`.PAT` seconds vs `.mtr` 0.1 us units) if `.PAT` import is added.

No existing execution path calls the new module yet; behaviour is unchanged. Tests: `npm run test:compile && node --test tests/exposurePlan.test.mjs` in `ionbeam-web/frontend`.
