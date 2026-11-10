# Pattern card inputs and runtime results

The catalogue `GlasgowDataIO/Json/processingPatterns.json` now declares numeric `parameters` and non-editable `readouts` for every enabled pattern. This implements the annotated PatternSetup screenshot. The requested User.zip was unavailable; the user explicitly asked to skip it. These are application validation rules, not a claim of FEI manual conformance.

## Editable fields

- Every active pattern has Depth in micrometres (0.001 to 1000), Dwell in microseconds (0.125 to 8192), and Overlap in percent (0 to 99.9). Depth reuses the existing Stair Cut depth field and limit. The overlap interval is an application assumption; 100% is excluded because it implies zero advancement. The dwell limits correspond to 1 through 65536 RevC3 ADC conversions at 8 MS/s.
- Ring has Rin and Rout. Both update the actual concentric-circle geometry; Rin must be nonnegative and strictly less than Rout. Changing one never swaps the radii. Circle has Radius; rectangular and polygonal patterns have Width/Height; Line has Length and its existing Line width. Numeric edits retain the shape centre; Line retains direction. Geometry fields use the canvas world unit (catalogue `unit: "world"`), which normally displays micrometres. They are not interpreted as micrometres when the canvas uses another unit.
- Drawing, resizing, moving, and undo keep the numeric geometry and readouts in sync. Catalogue reload merges added defaults with existing values and derives dimensions from any preserved ROI. Invalid numeric input is visibly marked and keeps the previous valid state; NaN, infinity, empty strings, out-of-range values, and invalid ring ordering are not committed.
- Geometry is disabled until the pattern has a drawn ROI. Existing Enable, Workflow, Dose, and Passes fields remain.

## Runtime results

Each pattern declares `readouts.time`, `readouts.count`, `readouts.centerX`, and `readouts.centerY`. The API validates the supported sources (`elapsed`, `spotCount`, `centerX`, `centerY`). The web cards render output labels, not editable text inputs. Time is the sum of actual elapsed workflow step durations, formatted `hh:mm:ss`; hours can exceed 99. It updates while running and freezes on completion/Stop/error. It is not a calculated milling estimate. An unstarted pattern shows a dash.

X/Y are signed offsets between the pattern bounding-box centre and the full displayed source-image centre, in the current world unit. Circular shapes use their common centre. The reference is the full image bounds (or hardware FOV when no bitmap is loaded), not the acquisition ROI or Zoom crop. Negative values represent positions before the image centre along the existing world axes. With no ROI, outputs show a dash. Clearing a pattern removes its old timing through the existing workflow-reset path. The native UI shares editable geometry, catalogue metadata and centre outputs; it shows a dash for Time because it has no corresponding workflow elapsed-time stream.

## Execution scope

The selected web pixel workflows use each pattern's Dwell, converting microseconds to `ceil(us / 0.125) - 1` gateware dwell ticks. The existing minimum Spot dwell still applies. Default image acquisition continues using Controls dwell; its live/parallel behavior is unchanged. Beam current, Depth, Overlap, Dose and Passes remain recipe metadata. No calibrated depth, overlap-derived spot spacing, sputter-rate time estimate or new milling executor is implied by displaying them. Field tooltips explain these distinctions.

## Packaging and checks

The existing source-copy and native package-data rules include the updated JSON, translations and widgets. The distribution manifest now requires PatternRuntimeReadouts.tsx so an incomplete UI package fails validation. Tests cover every active catalogue node, ring numeric editing and rejection, centre-preserving dimension edits, undo/drawing synchronization, full-image-relative offsets, frozen runtime elapsed time, dwell conversion and the web output labels. Native pattern tests and deployment integrity checks are also run. No beam operation is needed for these checks.


Validation completed: four new web parameter/readout tests, four Line/Polygon regression tests, existing geometry/workflow/scan-region tests, six backend catalogue tests, twelve native model tests, and forty-seven deployment integrity/dependency tests passed. The web card was visually inspected using the actual components in a temporary isolated preview; its sample runtime values were fixtures, not a beam run. The live local backend was restarted after it stopped responding and its API was verified to return all nine patterns and the new readouts. No sign-in code was sent and no hardware operation was performed.


Pattern numeric fields use three columns per row. Float values display two decimal places when not focused; integer fields retain integer formatting. Focusing a field reveals the full stored precision, so display rounding never changes the drawn geometry, dwell, or recipe value.


## Beam current, Depth and Count

Every JSON pattern node, including skipped future patterns, includes `beamCurrent` in pA with default 150 and a nonnegative numeric value. The active model's `depth` attribute is now explicitly labelled **Depth (µm)** instead of Z; existing stored depth values are preserved. Beam current and depth are recipe attributes and do not program the instrument current or calibrated milling depth.

Each active pattern declares a read-only `count` output (`source: "spotCount"`, `unit: "spots"`). It sits next to Time; X/Y occupy the following row. Count sums the prepared workflow's unblanked spots across its steps, including upcoming steps. It is not a measured delivered-exposure counter and does not accumulate repeated adaptive passes. Default acquisition has no Spot plan, so Count displays a dash. Before a plan exists and after clearing/resetting it, Count also displays a dash; a prepared plan with zero selected spots shows 0. Native has no Spot workflow plan and displays a dash. The API and native config accept the new source, and translations include Beam current, Depth and Count in all supported languages.
