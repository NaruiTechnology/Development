# Patterning audit against PN 21021-B

Reference: `/home/vboxuser/Downloads/Patterning.pdf`, manual pages 2-58 through 2-70. Reviewed 2026-11-09. Scope: the current ionbeam-web Processing implementation, its shared catalogue, and native catalogue/drawing compatibility. Open-Beam-Interface was inspected earlier; it is not the application modified here.

## New Line and Polygon tools

Manual p. 2-60 defines Line with left-button press, drag, release; Polygon with the first left-click followed by three more positions. Both are now present in the shared catalogue and web/native drawing tools.

- Line: drag two endpoints; release commits. A click or short drag does not overwrite the existing line. Its adjustable width (default 0.5 world units, displayed as um in the current catalogue) defines a flat-ended rectangular strip perpendicular to the segment. Width is an application extension: the supplied manual does not define a line-width value. The stored ROI is a four-corner polygon, allowing bounds, AvgGray, scan preview, and workflow blanking to use the same geometry, including horizontal and vertical lines. Width changes update the actual mask. Generic web move/resize preserves configured width. A line narrower than the sample grid may contain no samples; the existing workflow validation reports this rather than silently exposing a bounding rectangle.
- Polygon: four successive clicks in perimeter order close and commit the shape; pointer motion previews the next edge. The first three clicks remain a draft. Concave shapes are accepted; zero-area, repeated-vertex and crossing-edge shapes are rejected, preserving any previous ROI. Invalid fourth-click drawings are discarded; draw four positions again. Esc/right-click cancels. Leaving the web canvas preserves a pending click polygon. Free hand remains a separate press-drag-release tool.
- Both inherit workflow selection and enable switches. Web shapes support existing move/resize, clear, and undo. Native compatibility includes models, gestures, hints, and packaged icons; native's pre-existing editing limitations remain.

These additions define shapes in the existing execution framework. They do not implement calibrated milling, automatic dose/depth conversion, or a dedicated vector toolpath tracing each polygon edge. Dose and Passes remain metadata, as for existing patterns.

## Shape audit

| Manual tool (p. 2-60) | Current implementation | Assessment / remaining work |
| --- | --- | --- |
| Filled Box | SolidBoxModel, rectangle drag and filled containment | Drawing and area mask match. Default runs rectangular acquisition; selected workflows perform gray-directed Spot operations. Physical milling depth/dose is not implemented. |
| Outline Box | OpenBoxModel draws a border of configured lineWidth, but uses rectDef for area and containment | Execution mask includes the whole interior; selected workflows can act on interior pixels. Implement a border-specific containment and area model before claiming outline-only milling. |
| Line | New LineModel, drag endpoints, finite-width polygon mask | Manual drawing gesture implemented. Strip width is an explicit application extension; execution remains the shared acquisition/Spot workflow, not a calibrated line-milling recipe. |
| Regular Cross Section | StairCutModel splits the ROI into five strips by default, with direction and editable step count | Preview only approximates the five-box graphic. No depth schedule or per-strip milling levels; containment and execution use one full rectangle. |
| Cleaning Cross Section | CleaningLineModel previews parallel lines with explicit spacing/orientation | No advancing-face executor. Manual requires serial milling, material-overlap-derived spacing, and half the filled-box time estimate; none is implemented. Default acquisition can run parallel. Selected workflows run sequentially for all shapes, which is not a cleaning-specific serial rule. |
| Circle | CircleModel validates a solid disk; drawing is centre-to-radius drag | Solid mask agrees with the filled glyph in the manual, but UI shows only an outline. The text says start/stop drag without defining the centre convention; centre-to-radius is an application choice. |
| Polygon | New PolygonModel, exactly four clicks | Manual drawing gesture and filled shape mask implemented. No depth/dose-controlled polygon milling. |
| Ring / Free hand | Existing additional tools | Not specified in this excerpt; retained. |

## Menu and execution audit

| Reference | Existing behavior | Gap |
| --- | --- | --- |
| Arrow Cursor / sizing and moving (2-59) | Web tool can be disarmed by clicking its icon again; shapes have drag/resize handles | No explicit Arrow tool or group editing. |
| Serial Patterning (2-61) | Sequential acquisition and finite selected-workflow queue | Not a physical milling completion/dose model. |
| Parallel Patterning (2-61) | Rectangular acquisition interleaving; selected Spot workflows fall back to sequential | No equal-pass milling scheduler, per-pattern dwell/overlap depth handling, or summed milling-time calculation. |
| Reorder / Next / Select All (2-61) | One instance per catalogue key, catalogue order | No creation-order reorder tool, next-pattern execution switch, multiple instances of one type, or group manipulation. |
| Delete Selected Patterns (2-61) | Web context menu clears one shape; undo restores it | No multi-selection/delete workflow. |
| Start/Stop and editing lock (2-62) | Existing Scan/Run/Stop and queue state; selected workflows lock geometry while running | Default acquisition permits live ROI changes. No manual-compatible milling resume from exact exposure point or resize-reset milling elapsed-time contract. |
| Update Image after Patterning (2-62) | Existing acquisition streams and retained source frames | No explicit post-milling single-ion-frame option. |
| End Point Detection (2-63 through 2-70) | Workflow progress, elapsed time, sampled AvgGray | No EPD trace acquisition, depth/current/time display, file recall/export, trace autoscale, or annotation system described in the manual. AvgGray is not EPD. |

## Execution limits that matter

Default Processing uses rectangular bounding acquisition windows, including for Line and Polygon. The shape-clipped preview is not proof of beam blanking. Selected pixel workflows independently use MODEL_REGISTRY containment for actual vector-point blanking, and Line/Polygon participate in that path. They operate on sampled pixels rather than a line-length or polygon-edge-generated trajectory. Material brightness ratios are illustrative; they are not sputter-rate, overlap, or depth calibration. The existing 250,000-point bound and missing-source/no-sampled-pixel checks apply.

Priority for a later milling implementation: repair outline containment first; specify a common exposure plan with beam blanking, per-pattern dwell/passes, dose/depth calibration and serial/parallel scheduling; then implement the stair-depth and cleaning-face recipes. EPD is a separate feature.

## Validation and packaging

Hardware-free regression tests cover line geometry in every direction, width updates, polygon validation, sampled workflow blanking, AvgGray, acquisition bounds, web drawing/cancellation/move/resize/undo, native model and gesture compatibility, and shared catalogue loading. No beam exposure is triggered by these tests. The distribution builder requires both new native icons; the existing package-data rules include the catalogue, translations, frontend sources, and icons. Build and package verification results are reported with the change.


Validation result: the four new web tests, all 11 native pattern tests, all five backend catalogue tests, and all 41 deployment integrity tests passed. Frontend/backend production builds and the native wheel build succeeded. The compiled distribution archive passed its manifest/hash verification, and its catalogue, models, drawing sources, and icons were compared with the working files. Eight other existing Processing test files passed. The existing `frontend/tests/processingROI.test.mjs` fails at line 83 because its mocked run creates no socket; the same failure was reproduced in a separate checkout of unchanged HEAD `a97dec3a30a1`. This integration regression remains open and is not presented as a passing check. No running services or remote environments were modified; no hardware exposure was performed.
