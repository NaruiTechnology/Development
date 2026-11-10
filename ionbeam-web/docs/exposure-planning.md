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

## Iteration 2: service-side lattice (`pattern: "lattice"`)

The service now generates the spots, so no point list crosses the wire.

- `glasgow_service/exposure_lattice.py`: dependency-free generator in DAC space (rect, ellipse/ring, polygon). `build_lattice`, `count_spots` and `spot_centres` mirror `latticeSpec`, `countSpots` and `exposureSpots`; `lattice_points` yields a lazy serpentine stream, repeats it per pass, and merges spots that land on one DAC code (dwell summed).
- `VectorRequest.lattice` (`LatticeRequest`: shape, `pitch_x`/`pitch_y` in DAC codes, `axis`, `dwell` ticks, `passes`) is required with, and only valid with, `pattern: "lattice"`. `pre_process` is rejected because it would encode every point into memory. A total above 200,000,000 points is rejected as a likely pitch typo.
- `service.py`: `_build_vector_cmd` passes the lazy stream as `points_factory`; simulation paths and pass-sample counts handle it. `link_dwell` is the lattice dwell.
- Frontend: `latticeRequest.ts` converts um spacing to DAC pitch per axis and shapes to DAC (ellipse on the plain FOV map, polygon under rectified scan geometry; rings need the plain map). `VectorRequestPattern` adds "lattice"; the image display layer keeps its narrower type and `startVector` refuses lattice requests until a display path exists.
- Parity: `glasgow_service/tests/fixtures/lattice_golden.json` is generated from the TypeScript planner (`node scripts/gen-lattice-golden.mjs`) and checked by both the TS and Python tests, spot for spot.

## Exposure takes precedence over Zoom

`update_live_scan_geometry` refuses every live update (Zoom ROI, parallel regions, point or gray-rule updates) while a lattice exposure is active. A ROI update cannot change a lattice, so accepting it would zoom the display while the beam kept exposing the old pattern. Zoom remains available for imaging and positioning before the exposure starts. The UI should disable the Zoom control during a lattice exposure once the UI can start one.

## Still open

1. UI: show spot size, spacing, Count and beam-on time from `planExposure` on the pattern card; replace "Point spacing (px)".
2. Display: lattice samples are not an image grid. Needs a progress/preview path (for example a pass-progress bar plus an image resampled from the spot stream) before the UI can start a lattice scan.
3. Route the Default workflow through the plan; keep gray-directed Spot workflows pixel-based until they have a physical equivalent.
4. `ionbeam-web/backend/src/mockHardware.ts` does not know `lattice`.
5. Hardware validation of a multi-million-point stream (host-link pacing, `VECTOR_MAX_CHUNK_POINTS`, abort latency) has not been run.
6. Cross-section recipes, Sr in the material catalogue, `.PAT` dwell-unit trap, and OpenBox/StairCut outline handling (they currently share the solid-rect model).

Tests: `npm run test:compile && node --test tests/exposurePlan.test.mjs` in `ionbeam-web/frontend`; `python -m pytest glasgow_service/tests/test_exposure_lattice.py glasgow_service/tests/test_lattice_vector_service.py` from the repo root.
