# Processing tab (web app)

A **Processing** tab sits next to Scan. It draws pattern ROIs on the ROI canvas; running patterns on the beam is not part of iteration 1.

**Config.** `GlasgowDataIO/Json/processingPatterns.json` (shared with the native app; override with `PROCESSING_PATTERNS_CONFIG`). The backend serves it, validated, at `GET /api/processing/patterns` (`backend/src/processingPatternsConfig.ts`). `Patterns` is a list of one-key objects like the deploy workflow's `Actions`: the key is the pattern name, the value has `skip`, `model`, `roi` (`rect` / `circle` / `ring` / `polygon`), `caption`, `icon` and a `parameters` schema. `skip: true` entries are never sent to the browser. A bad entry is reported in the Patterns card and does not hide the others.

**Models.** `frontend/src/lib/processingPatterns.ts` has `MODEL_REGISTRY` (SolidBoxModel, OpenBoxModel, StairCutModel, CleaningLineModel, CircleModel, RingModel, FreeHandModel): ROI validation, area, containment, preview geometry. The processing slice (`store/processingSlice.ts`) holds one instance (parameters + ROI) per catalogue entry; the catalogue is fetched at app launch.

**UI.** `ProcessingPatternsPanel` renders the non-collapsible *Patterns* card (icon strip). The shared Controls card sits directly below it, followed by `ProcessingPatternCards` with one card per pattern, collapsed by default. Picking an icon arms drawing; picking it again disarms. Icon selection leaves card expansion and scroll position unchanged. Each card is expanded or collapsed independently using its chevron; expanding a card also selects its drawing tool. `PatternOverlay` is mounted inside the ROI canvas through `ROIEditor`'s `renderCanvasOverlay`: rect = drag; circle = drag centre to radius and release (open outline); ring = drag centre to outer circle, then click for the inner circle (same centre), Esc / right-click cancels; free hand = press-drag-release.

**New pattern:** add a model to `MODEL_REGISTRY` and an entry to the JSON; the card form is generated from `parameters`.


## Processing acquisition and source image

Processing shares the Scan controller and Transform settings. At the bottom,
Transform starts collapsed; Controls opens on Processing entry. Controls shares Pattern Path, Resolution, Dwell, Region, Equipment and Zoom with
the Scan tab, including the same validation and enabled/disabled behavior.
Controls offers Scan (one acquisition),
Stop, and Run (continuous/live acquisition). Entering Processing starts live
acquisition once the configured image is ready, unless a stream is already
running; clicking the image while stopped also requests live acquisition. These
requests use the same permission, vacuum readiness, validation and start guards
as the Scan tab. Stop consumes the pending start request and is not followed by
an automatic restart; another tab entry or image click is required.

The existing stream remains mounted while switching between Scan and Processing.
The last raster/vector subtab chooses the acquisition type. Samples are shown
under the pattern drawing layer; pattern editing remains available during live
acquisition. Scan and Run acquire images; this change does not implement pattern
milling or interpret pattern Dose/Passes as beam execution commands.

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
in catalogue order. A first drawing enables ROI Scan automatically; clearing the
last drawing returns to full-field acquisition. The read-only ROI Scan switch
shows this automatic mode. Processing uses its own derived plan and does not
replace the Scan tab's configured ROIs.

The existing live geometry/restart path applies edits, region-count changes and
Zoom to these windows. Rectangles use their drawn bounds; circles, rings and freehand
patterns use clipped bounding rectangles because the acquisition API supports
rectangular windows. Pattern shapes are preserved; this is image acquisition,
not a shape-specific milling executor. Parallel uses the same switch, default,
interleaving and sequential fallback as Scan, and is available with two or more
valid pattern regions.

The bottom-right scale uses the same calibration, unit conversion and Zoom label
as Scan. Its line width is fixed as Zoom changes, and it stays upright outside
the transformed image layer. Processing Split snapshots also include this scale.

The Processing scan-path preview clips its sweep and marker to the current drawn shapes, including ring holes and freehand boundaries. Editing or clearing shapes refreshes the mask immediately. This is a display mask: acquisition still uses the rectangular windows described above, so the clipped preview is not evidence of beam blanking outside a pattern.
