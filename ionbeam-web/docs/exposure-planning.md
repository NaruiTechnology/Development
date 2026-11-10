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
- Frontend: `latticeRequest.ts` converts µm spacing to DAC pitch per axis and shapes to DAC (ellipse on the plain FOV map, polygon under rectified scan geometry; rings need the plain map). Processing Run now sends this request; the stream hook counts exposure payloads and never appends them to the image buffer.
- Parity: `glasgow_service/tests/fixtures/lattice_golden.json` is generated from the TypeScript planner (`node scripts/gen-lattice-golden.mjs`) and checked by both the TS and Python tests, spot for spot.

## Scan and Run are separate

Processing **Scan** remains an image acquisition and follows Controls settings (Zoom, ROI scan, dwell and scan path). Processing **Run** prepares one finite lattice request for each enabled pattern with a drawn ROI. It uses the pattern's beam-current reference, dwell, overlap, dose/passes and X/Y axis; it maps the saved world-space pattern through the full-field DAC mapping. Controls Zoom, ROI-scan state, vector resolution, dwell and scan path are not inputs to Run. The axis radio defaults to X (horizontal serpentine); Y uses vertical serpentine.

The service rejects live Zoom/ROI/gray-rule updates during lattice exposure. Lattice detector payloads are counted for stream progress and are not rendered as image pixels; Run leaves the Scan image untouched. Exposure uses the first voltage in `LensLookup` (currently 30 kV). The Beam current field informs the spot-size lookup; it does not program the instrument current. Set the instrument to the recipe current before starting.

## Still open

1. Pattern card workflow/material selectors still describe image-gray workflows and are not inputs to Run's exposure lattice.
2. Actual milling depth still needs a calibrated material removal rate; the LENS table has no removal-rate data.
3. `ionbeam-web/backend/src/mockHardware.ts` does not know `lattice`.
4. Hardware validation of a multi-million-point stream (host-link pacing, `VECTOR_MAX_CHUNK_POINTS`, abort latency) has not been run.
5. Cross-section recipes, Sr in the material catalogue, `.PAT` dwell-unit trap, and OpenBox/StairCut outline handling (they currently share the solid-rect model).

Tests: `npm run test:compile && node --test tests/exposurePlan.test.mjs` in `ionbeam-web/frontend`; `python -m pytest glasgow_service/tests/test_exposure_lattice.py glasgow_service/tests/test_lattice_vector_service.py` from the repo root.


## Simulation visualization iteration

References reviewed again: `Focused Ion Beam patternning-Basics.pdf` (both slides),
`Patterning.pdf` printed page 2-60, `FIB Pattern 图形加工功能技术整理.docx`
sections 2.1, 6.2, 8.3, and `LENS 1 PRELENS.xls`, Sheet1 A1:F22. The workbook's
30 kV / 150 pA row specifies 350 Å = 35 nm; 50% overlap gives 17.5 nm nominal pitch.
The two PDFs establish the serpentine spot lattice, five boxes at different levels,
and serial advancing cleaning lines. The technical note's overlapping-box description
informs the simulation geometry; it does not specify a unique box-depth algorithm.

In simulation (`is_production === false`), Run prepares the complete step queue before
starting the first exposure. Stair cut defaults to five successively smaller overlapping
boxes, ordered by the saved direction. Every subsequent box adds another exposure layer
toward the deepest band. Depth labels divide the requested depth evenly across the bands;
this is an illustrative requested profile, not a material removal calibration. Clean line
creates one single-row lattice request per saved cleaning line, running all passes of one
line before advancing to the next. The saved Line spacing remains an explicit override
of the reference's overlap-derived line advance, and is reported separately from spot
pitch. Up to 1000 cleaning lines are supported; an excessive or empty sequence fails
before any request starts. Along-line pitch still comes from beam diameter and overlap.
Production Run retains its existing single-lattice behavior; shape-specific production
milling semantics and calibrated depth remain open.

The ROI preview and image canvas draw a separate SVG exposure layer. Cyan marks the
planned spot path; each step has its own colored accumulated trace, and a white marker
shows the latest sampled preview position. Gray stair bands align with the requested
final depth, darker for deeper. Completed traces remain visible; Stop freezes the received
trace, and starting Scan replaces the exposure workflow. Scan image pixels remain unchanged.

`exposurePreview.ts` samples at most about 3000 lattice centres for the whole scene
(up to 4000 for 1000 very short lines), with bounded work even for multi-million-cell
plans. It preserves serpentine direction and shape clipping, avoids bridges across ring
holes or unsampled concave polygon intervals, and marks the display as a sampled simulation
preview. The representative dots have a readable display radius rather than physical beam
size. Stream sample counts drive the preview; first-pass footprints persist while the
marker wraps on subsequent passes. Mapping is schematic for clipped shapes, estimated
counts, rectified geometry, or spots merged onto one DAC code, and is not hardware position
telemetry or a measured exposure/depth counter.

The canvas bottom message panel freezes the prepared settings, showing pattern/step/status,
current reference, beam diameter, nominal pitch, overlap, dwell, axis, planned spots per pass,
passes, and the cleaning-line spacing override. All new labels are available in English,
simplified Chinese, and traditional Chinese. The distribution builder explicitly requires
both preview libraries and the overlay component; frontend dist is regenerated locally and
deploy hosts continue rebuilding it from the packaged frontend source.

Verification: frontend production build; `exposurePreview`, `exposurePlan`,
`processingPatterns`, and `scanParamChip` tests; distribution deployment-safety tests.
An isolated local browser fixture exercises the actual overlay/message components for
running, completed, and stopped states without requiring sign-in or issuing hardware commands.


## Dedicated exposure controls in the Patterns header

The **Patterns** card header contains three exposure controls: Parallel (default off),
Stop, and Start. There is no separate Exposure card. A retained controller portals these
controls into the header and continues running when the header is hidden or unmounted
by a tab change.

`ExposureControls.tsx`, `useExposureRun.ts`, and `exposureSlice.ts` own the exposure lifetime,
progress, errors, abort acknowledgement, and socket. Regular Processing controls now
provide Scan / Stop / Infinite exclusively for image acquisition. Exposure does not read
scan resolution, dwell, scan path, Zoom, ROI-scan selection, Preview, or scan Parallel;
it uses the saved pattern recipes and the field-to-DAC mapping. It never dispatches scan
phase/counter/parameter capture or image-buffer actions. Overlays, bottom messages and
pattern exposure readouts use `exposure.progress`; image workflows keep their own
`processing.workflowProgress`. Editing pattern geometry/parameters clears a finished
exposure preview; ordinary scanning does not rewrite the exposure recipe or results.

Parallel off finishes each step and all its passes before advancing. Parallel on lazily
interleaves one pass of each enabled pattern on the single beam, preserving dependencies
between steps of a Stair cut. Patterns with fewer passes finish earlier; each recipe keeps
its requested pass count. The implementation uses a finite stream per visit, rather than
simultaneous hardware commands. Cleaning lines require serial execution: enabling Parallel
with a cleaning-line pattern disables Start and displays an explanation. Parallel cannot
be changed during an exposure.

The shared instrument ownership guard excludes scans in both workspaces while an exposure
is preparing, running, or stopping, and excludes exposure while a scan owns the instrument.
Exposure Stop cancels future queue entries and holds ownership until the HTTP abort and
socket shutdown settle, preventing a delayed exposure abort from cancelling a newly started
scan. Completed/stopped/error previews remain available. The existing scan Stop handles
only its scan controller; exposure Stop handles only its exposure controller.

Validation for this iteration: real component/hook integration with a mocked transport
checks the three header controls and Parallel off, serial five-step execution, repeated-click exclusion,
Stop/abort acknowledgement, scan-versus-exposure ownership, error isolation, unchanged scan
state and acquired pixels, and the cleaning-line restriction. Scheduler tests verify pass
interleaving, dependency order, and lazy high-pass recipes. Production build and deployment
packaging are refreshed, with the new controller, state, scheduler, and header controls explicitly
required by the distribution builder.
