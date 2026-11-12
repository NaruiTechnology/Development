# Processing tab (web app)

A **Processing** tab sits next to Scan. It draws pattern ROIs on the ROI canvas; running patterns on the beam is not part of iteration 1.

**Config.** `GlasgowDataIO/Json/processingPatterns.json` (shared with the native app; override with `PROCESSING_PATTERNS_CONFIG`). The backend serves it, validated, at `GET /api/processing/patterns` (`backend/src/processingPatternsConfig.ts`). `Patterns` is a list of one-key objects like the deploy workflow's `Actions`: the key is the pattern name, the value has `skip`, `model`, `roi` (`rect` / `circle` / `ring` / `polygon`), `caption`, `icon` and a `parameters` schema. `skip: true` entries are never sent to the browser. A bad entry is reported in the Patterns card and does not hide the others.

Workflows may omit `steps` or provide an empty list. `AreaRemoval` is parameterless but defines a Spot action: it uses the average gray level of the full source field as its target, spots ROI pixels above that level, and repeats until the target range is reached.

Workflow JSON keeps only the fields the web executor consumes: workflow and display captions, step actions, `mode`, and the Spot selection/threshold source. Action and step names are omitted. A Spot threshold uses exactly one of `thresholdMaterial`, `thresholdSource: "selectedMaterial"`, or `thresholdSource: "fullScaleAverage"`.

**Models.** `frontend/src/lib/processingPatterns.ts` has `MODEL_REGISTRY` (SolidBoxModel, OpenBoxModel, StairCutModel, CleaningLineModel, CircleModel, RingModel, LineModel, PolygonModel, FreeHandModel): ROI validation, area, containment, preview geometry. The processing slice (`store/processingSlice.ts`) holds one instance (parameters + ROI) per catalogue entry; the catalogue is fetched at app launch.

**UI.** `ProcessingPatternsPanel` renders the non-collapsible *Patterns* card (icon strip). The shared Controls card sits directly below it, followed by `ProcessingPatternCards` with one card per pattern, collapsed by default. Picking an icon arms drawing; picking it again disarms. Icon selection leaves card expansion and scroll position unchanged. Drawing or editing a pattern ROI automatically expands its corresponding card. Each card is expanded or collapsed independently using its chevron; expanding a card also selects its drawing tool. `PatternOverlay` is mounted inside the ROI canvas through `ROIEditor`'s `renderCanvasOverlay`: rect = drag; circle = drag centre to radius and release (open outline); ring = drag centre to outer circle, then click for the inner circle (same centre), Esc / right-click cancels; line = drag endpoints and release (adjustable width); polygon = four clicks; free hand = press-drag-release.

**New pattern:** add a model to `MODEL_REGISTRY` and an entry to the JSON; the card form is generated from `parameters`.


## Processing acquisition and source image

Processing shares the Scan controller and Transform settings. At the bottom,
Transform starts collapsed; Controls opens on Processing entry. Controls shares Pattern Path, Resolution, Dwell, Region, Equipment and Zoom with
the Scan tab, including the same validation and enabled/disabled behavior.
Controls offers Scan (one acquisition), Stop, and Run (continuous Default
acquisition, or one finite selected pixel workflow). Entering Processing and
clicking the image do not start acquisition. Start actions use the same
permission, vacuum readiness and validation guards as the Scan tab.
The stream stays mounted while switching between Scan and Processing.
Selecting a pixel workflow switches Processing to vector acquisition while idle.
Dose and Passes remain pattern metadata; the pilot uses the configured vector
dwell and one pass for each workflow step.

When `streamData.json` has **IsProduction exactly false**, the backend reads
`GlasgowDataIO/Json/processingPatterns.json` → `Header.LoadImage`. Paths can be
absolute or relative to that JSON file. Set `PROCESSING_PATTERNS_CONFIG` to override
the catalogue file.
An empty path uses the existing simulation source. Production does not read or
load either image setting. A bad configured image shows a localized error and
blocks automatic acquisition until corrected or an image is selected manually.
The browser can request only the configured image, not an arbitrary server path.


## Processing Split

The Processing image header shares Scan's Split and Lock controls and pane layout
rules. Split captures the displayed canvas layers and pattern SVG into a frozen
PNG beside the same live drawing canvas. Acquisition is not stopped and the
live editor is not remounted. Completed acquisitions can advance the layout to
four panes using the shared placement helper. Archived panes can be selected and
cleared. Unlock returns to one live pane; Split restores the saved layout.
Processing keeps its pane state while visiting other tabs and does not change
Scan's raster/vector pane layouts. Snapshot export includes the current display
orientation and pattern geometry.


## Pattern-driven acquisition

Processing derives its acquisition ROI list from the drawn pattern instances,
in catalogue order. ROI Scan starts enabled and can be switched off for a
full-field scan at the current Zoom. The switch remains editable during Run.
Processing uses its own derived plan and does not replace the Scan tab's
configured ROIs. With ROI Scan enabled, at least one valid enabled pattern
is required to start acquisition.

The existing live geometry/restart path applies edits, region-count changes and
Zoom to these windows. Rectangles use their drawn bounds; circles, rings and freehand
patterns use clipped bounding rectangles because the acquisition API supports
rectangular windows. Pattern shapes are preserved; this is image acquisition,
not a shape-specific milling executor in Default. Selected pilot workflows use the shape mask for vector blanking. Parallel uses the same switch, default,
interleaving and sequential fallback as Scan, and is available with two or more
valid pattern regions.

The bottom-right scale uses the same calibration, unit conversion and Zoom label
as Scan. Its line width is fixed as Zoom changes, and it stays upright outside
the transformed image layer. Processing Split snapshots also include this scale.

The Processing scan-path preview clips its sweep and marker to the current drawn shapes, including ring holes and freehand boundaries. Editing or clearing shapes refreshes the mask immediately. This is a display mask: acquisition still uses the rectangular windows described above, so the clipped preview alone is not evidence of beam blanking outside a pattern. The selected pixel workflows independently apply the shape mask to actual vector points.


## Pilot pixel workflows

The API now returns validated `Workflows` and `Materials` alongside `Patterns`.
Completing a valid ROI drawing automatically turns that pattern's Enable switch on.
Draft previews and cancelled drawings do not enable it.
Each non-Stair Cut pattern card has a Material dropdown backed by the configured Materials catalogue. Stair Cut keeps its per-step material selectors. Each pattern card has a Workflow dropdown (initially Default) and a switch.
Switching off retains the selected workflow and executes Default instead.
Default is an ordinary acquisition with no workflow or global gray filter.

`EvenLinelCut` freezes one source image and runs two finite Vector Spot steps
using the ROI gray-level range filter (Spot mode: a pixel is spotted when its
gray level lies inside the range, ends included). The dark step spots
`[spectrum min, AvgGray]`; the bright step spots `[AvgGray, spectrum max]`.
`AvgGray` is the rounded average measured over the sampled ROI; the spectrum
min/max are the lowest and highest gray levels of the frozen source image.
Both intervals include the `AvgGray` level, so pixels exactly at that level are
spotted by both steps. Both steps target the same frozen `AvgGray`. In simulation,
dark pixels brighten and bright pixels darken by at most two levels per pass,
clamping exactly at `AvgGray`; pixels already at that level stay unchanged.
Pixels outside the pattern remain unchanged. Production uses adaptive gray
feedback from the live ADC.
Spot dwell is at least two clock cycles, matching the ROI Spot action in
commit `15f6a0a9`. The display preserves the dark result when the bright step starts.

`MaterialLinelCut` spots bright pixels against the selected material's brightness
ratio. Each non-Stair Cut pattern card has a Material selector populated from the JSON
`Materials` list; Stair Cut keeps its per-step Material controls. For non-Stair Cut
patterns, Material is consumed by the image-guided `MaterialLinelCut` workflow only.
It does not affect `expose-lattice`; Stair Cut's calibrated per-step removal rate
(`Sr`), rather than its Material label, affects lattice dose and pass calculation. A Target gray
level row appears below the selectors for this workflow and displays
`AvgGray × selected material brightness`. This calculated target is also used as
the workflow threshold. The Patterns canvas hover tooltip also looks up the hovered
pixel against each material's configured `grayValueRange` and lists all inclusive
matches. If no range contains the pixel, it lists the material(s) whose range is
nearest by distance to the range boundary. Overlapping ranges can produce multiple
candidates, and these source ranges are illustrative rather than guaranteed material
identifications. Materials without a configured range, such as SiO2, cannot be returned.

`AreaRemoval` uses the rounded average of every pixel in the full source field
as its target. It uses the ROI gray filter in Spot mode over `[target + 1, 255]`
and repeats passes using the ROI target-gray two-level convergence cadence.
Production runs use adaptive gray feedback from the live ADC; simulation runs
advance their bitmap toward the same target.

For a selected cut workflow, Scan and Run execute one finite sequential plan,
including when Parallel is selected. The plan uses Vector Spot point blanking
in hardware and simulation, preserving scan path and dwell. Each step blanks
pixels outside its selected gray class and outside the drawn ROI shape,
including ring holes. The average is measured over sampled shape pixels from
one frozen complete acquired image, or the loaded bitmap if no complete frame
exists. In simulation a loaded bitmap takes precedence, and the same sampled ROI
crop is uploaded as the ADC source for every step. The request ROI matches the
actual sample extent in DAC coordinates; each point carries UI metadata mapping
its feedback to the exact source-image pixel. Blanked points preserve their
original pixels, including ring holes. The Processing scan-path overlay follows
the actual custom point list and stream cursor during a workflow. Both Even steps use that same source and threshold. Workflow pixel
coordinates follow the FOV/calibration transform; workflow masks use the drawn
ROI without the acquisition Zoom crop. The executor rejects missing source data,
unknown materials, and ROIs exceeding 250,000 vector points. It does not convert
Dose to dwell or repeat Passes; those remain pattern metadata.

Each pattern card shows its own Workflow timeline directly below its workflow
dropdown and switch. Steps run left to right, connected by arrows; narrow cards
scroll horizontally. Outgoing arrows are gray while idle, red while scanning,
and lawn green after completion. The final arrow leads to a blue end circle,
which fills when all steps complete. Each step and the workflow summary show elapsed time, updated
while running and frozen on completion, Stop, or error. Timing starts when the
step is dispatched to the scan stream and includes connection/transfer time.
It follows actual stream completion for that pattern, with current,
completed, stopped, and error states plus sample progress. Stop cancels the
remaining sequence. Cut steps run through the existing persisted scan queue.
The deployment environment explicitly points `PROCESSING_PATTERNS_CONFIG` at
the packaged catalogue; the distribution builder already requires this file.


The Processing image includes Scan's message-panel styling below the viewer.
It reports the live phase, chunks, bytes, display resolution, sample or pixel
progress, path, ROI bounds, and pixel size. Custom workflows use their actual
point count; parallel scans list each displayed ROI. Stream errors appear there
even when the control card is collapsed.


Processing's ROI Scan switch remains editable during Run. Turning it off
restarts acquisition over the full field at the current Zoom; turning it on
returns to the enabled pattern ROIs and their configured workflows. The
existing stream handover stops the old request before starting the new mode.
Parallel defaults to OFF, including when a second ROI is drawn; enable it
explicitly to interleave regions rather than scan them sequentially.


The Processing scan-path overlay follows the active acquisition display bounds.
When ROI Scan is off, its sweep and marker span the full field even while ring
and freehand patterns remain visible. Shape clipping, including ring holes,
applies only when acquisition has an ROI; sequential scans show the current
ROI and parallel scans show their active region list.


## Manual reference and new tools

Line and Polygon follow PN 21021-B p. 2-60: drag-and-release for Line, four successive vertex clicks for Polygon. Esc/right-click cancels drafts. A Line is stored as a finite-width four-corner polygon to share the acquisition bounds and workflow masks; `lineWidth` changes its geometry, not only its appearance. Polygon rejects zero-area and crossing-edge drawings. Both have icons and cards in the shared catalogue; native model and drawing support is kept compatible.

See [patterning-audit.md](patterning-audit.md) for the comparison with the supplied manual, remaining outline/stair/cleaning execution gaps, and the distinction between rectangular Default acquisition and selected shape-masked Spot workflows.


See [processing-pattern-parameters.md](processing-pattern-parameters.md) for catalogue-defined dimensions, Z/Dwell/Overlap inputs, runtime Time/X/Y labels, and their validation and execution scope.


While editing, the expanded pattern card moves to the first position below the Patterns toolbar. Collapsing it restores catalogue order; expanding or drawing another pattern promotes that card. Card state stays keyed by pattern, and acquisition/execution still uses catalogue order. During execution the presentation uses catalogue order.


Polygon is excluded from the shipped pattern stock (`skip: true` in its catalogue node), so neither the web nor native app displays its icon or card. Free hand remains available. Polygon geometry support is retained for shared geometry handling and explicitly configured catalogues.


The PROCESS / PATTERNS header includes **?** help with the imported Lens 1 Prelens data table and a spot-size lookup. See [lens-reference.md](lens-reference.md) for provenance, calculation helpers, service endpoints, interpolation rules, and the additional calibration needed for milling depth.
