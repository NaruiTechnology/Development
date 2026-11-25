# Advanced milling and manufacturer calibration

In PATTERNS, select Advanced, draw and enable a pattern ROI, then start Milling.
Start checks width and height independently against the full, unzoomed field.
Each ROI dimension plus 2 µm must fit on its axis. The reference scan excludes
the bounds of the ROI with 1 µm added on each side and clips the exclusion to the
scan field. With affine calibration, it encloses the exclusion in DAC space.
It also excludes the planned beam footprint with the same allowance.

The reference is a set of detector frames acquired outside the exclusion and
held in memory for the run. For runs with further passes, the first cut
requires a reference with distinguishable features. Before each subsequent
pass, including a new Stair Cut step, image registration compares fresh frames
with the initial frames. Each match starts at 98% correlation and retries in
one percentage point steps down to the 75% milling minimum. The retries reuse
the same images and still require agreement between reliable strips.
The service adds the measured integer DAC translation
to every emitted spot after lattice generation. This keeps segment order, spot
identity and dwell intact. The live feedback still renders in the pattern's
original coordinate system so corresponding spots can be compared across passes.
The run stops when a match is ambiguous, the measured translation exceeds the
margin, or the corrected lattice would leave the DAC field. The field and scan
settings are captured at Start.

The message panel below the image canvas shows capture progress, match
correlation and the accepted threshold, and the detected X/Y drift before
rounding in µm and fractional DAC codes. The rounded correction is shown
separately and marked applied after the first corrected segment completes.
The panel keeps the drift and correction for the last 20 applied passes in
the current run.

## Manufacturer Data Set format

Use UTF-8 JSON as the portable calibration record. Store MDS records separately
from equipment recipes and run receipts. Identify a record by manufacturer,
process, and immutable revision. Moving a record to another FIB system preserves
those identifiers and all units. Instrument-specific calibration records refer
to the MDS revision rather than changing it.

Illustrative record shape, with nominal dimensions in µm:

```json
{
  "schema_version": 1,
  "manufacturer_id": "example",
  "process_id": "example-stack",
  "revision": "1",
  "layers": [
    {"id": "M2", "kind": "metal", "material_id": "Cu", "thickness_um": 0.15, "line_width_um": 0.12},
    {"id": "B2", "kind": "barrier", "material_id": "example-barrier", "thickness_um": 0.02},
    {"id": "ILD2", "kind": "oxide", "material_id": "SiO2", "thickness_um": 0.20},
    {"id": "M1", "kind": "dummy_metal", "material_id": "Cu", "thickness_um": 0.10, "line_width_um": 0.08},
    {"id": "P1", "kind": "poly", "material_id": "polysilicon", "thickness_um": 0.09, "line_width_um": 0.08}
  ]
}
```

Layers are ordered from the surface down. IDs are unique within a revision,
thickness must be positive, and line width is optional on unpatterned layers.
Validate the revision, layer ordering, identifiers and units on import.
Installation-specific calibration needs to record instrument and detector
settings, beam energy and current, material removal rates, expected detector
responses, and their acceptable variation. The dimensions above are illustrative
and are not calibration inputs.

### Milling workflows and receipts

| Workflow | How the MDS is used |
| --- | --- |
| Direct removal | Use the selected layer sequence and cumulative thickness to bound expected depth. Compare detector peaks and transitions with measured responses for those layers. Stop for review if signal, layer count, and predicted depth disagree. |
| Step removal | Resolve the selected start and end layer IDs to depths. Use the top and bottom ROIs and calibrated removal rates to prepare the step recipe. |
| Area cleaning | Use the executed step recipe and an acquired grayscale image to identify excess material. Generate a cleaning pattern constrained to the selected area, with a protection mask and dose limits from the instrument calibration. |
| Layer review | Let the operator confirm the expected metal, dummy metal, oxide, barrier, or poly label against the image and detector trace before continuing when a transition is uncertain. |
| Calibration and receipts | Run calibration cuts under recorded conditions, measure depth independently, and save a receipt with the MDS revision, instrument settings, selected layers, per-pass offsets, trace, delivered dose, measured depth, and outcome. |

The current implementation uses the existing dose and pass planner and does not
infer layer depth from the registration image. The format and workflow table
specify the additional inputs and outputs for an instrument calibration and
layer endpoint feature.
