# LiveView contrast audit

Date: 2026-11-19. Scope: the Milling LiveView Auto levels, sample retention, and the proposed selective normalization range. This audit does not change display or acquisition behavior.

## Current behavior and findings

- `frontend/src/components/LiveViewCanvas.tsx:29–34` measures the latest valid pixels and sets Auto to the absolute minimum and maximum. The common percentile-based `resolveLevels` path is bypassed whenever LiveView has data. Extreme dropout/saturated samples therefore consume the display range.
- The histogram has 512 bins. Simply switching to the existing percentile helper improves outlier rejection, but bin widths can exceed the entire useful signal variation when extremes span the ADC range.
- `normalizeLevels` permits a four-sample-unit window, equivalent to one native 14-bit ADC code. A single-code fluctuation can therefore become full black-to-white variation. The display currently has no configurable gain ceiling, minimum useful window, or Auto-level stabilization.
- `frontend/src/store/imageSlice.ts:182–192` retains only the latest value in each 256 × 256 preview pixel. Multiple exposure spots can overwrite the same pixel. There is no previous-pass buffer, stable per-spot identity, or per-pass validity mask. This is a preview-pixel histogram, not an exposure-spot histogram.
- Levels are recomputed as feedback chunks arrive. There is no temporal reference, so the current Auto stretch cannot measure same-spot changes across passes. Independent re-normalization can also conceal uniform changes between passes.
- Milling simulation requests loopback feedback. Repeating the same DAC point produces the same loopback value; this is useful for spatial mapping tests but does not simulate material-removal intensity changes.

## Reproducible numerical checks

The existing compiled display-level functions were evaluated with 10,000 useful samples spanning 40000–40096 (24 ADC codes), plus two extreme samples at 0 and 65532.

| Mapping | Useful-signal output gray range |
| --- | --- |
| Current LiveView absolute min/max | 156–156 |
| Existing 512-bin percentile Auto | 113–211 |
| Exact 0.5–99.5 percentile reference | 0–255 |

A separate check with inputs 40000 and 40004 produced outputs 0 and 255 under current Auto: one code of variation receives maximum gain. These are synthetic checks, not production detector measurements.

## Recommended enhancement

1. **Robust Auto:** calculate percentiles from full-resolution raw sample counts or exact sample values, using valid acquired data only. Start with 0.5th/99.5th percentiles; provide a minimum window/gain limit so detector noise is not promoted to apparent milling detail. Stabilize level updates and retain manual wedge behavior. Do not broaden the raw data path to 8-bit display values.
2. **Change view:** for repeated milling passes, preserve a completed reference pass and compare matching spatial samples. Display signed change around midgray, with brighter positive change and darker negative change. Match pattern, geometry and pass identity; reset the baseline when any changes. The first pass establishes the reference. If storage remains 256 × 256, label this as preview-pixel change; true individual-spot comparison requires retaining corresponding lattice-spot data or computing deltas upstream.
3. **Normalize range:** provide a separate, optional nonlinear brightening mode for a user-selected ADC interval. Use a monotonic curve, not a constant brightness assignment, so differences remain visible. An illustrative target maps a normalized midpoint of 0.5 from gray 128 to gray 204 using gamma ≈ 0.322; retain endpoints and expose brightness strength. Selected-band brightening is a display enhancement and should be identified as such.
4. **Range UI:** a two-handle slider beside ROIContrast, using 0–16383 ADC codes consistently with its wedge. Include a range-enable switch, low/high readouts, “Around mean” initialization, normalization strength, and reset. Keep acquired samples outside the selected interval visible with the base contrast mapping. Empty bands must show “No acquired spots in range”, not synthesize or stretch unavailable data. Use the same selected population for statistics and mapping.
5. **Separate the two use cases:** difference amplification and near-average brightening should be explicit selectable modes. Flattening all near-average samples to one bright value would destroy the small differences needed by the first use case.

## Validation before release

Cover dropout/saturation outliers, constant images, one-code noise, valid zero samples, partial passes, sparse and empty selected bands, monotonic brightening, untouched raw data, manual/Auto switching, baseline invalidation, and spot/bin collisions. Test a controlled small intensity change between passes and a uniform intensity shift; ordinary loopback alone cannot establish temporal sensitivity. Verify that ROIContrast changes only LiveView and leaves the lower full-image contrast independent.

## Outstanding choice

Does “gray-level delta” mean the same spot between milling passes, or differences from the current ROI average? The former needs a temporal reference; the latter can be computed from the current frame. The UI and sample-retention design should follow that choice.
