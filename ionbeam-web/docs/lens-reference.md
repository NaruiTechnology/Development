# Lens 1 Prelens reference

`GlasgowDataIO/Json/processingPatterns.json` contains the canonical `LensLookup` block. The original `GlasgowDataIO/Calibration/LENS 1 PRELENS.xls` is preserved unchanged; its SHA256, sheet, source range, headers and source row numbers are recorded in the JSON. All eleven data rows and six notes from Sheet1 A1:F22 are imported. Sheet2 and Sheet3 contain no data. The workbook contains no BIFF formula records, so no recalculation was needed.

The import keeps the `<10 µm` aperture and `<1 pA` current as qualified text, the three starred Lens 1 values, and the blank aperture-step value at 10 kV. It does not carry the previous 3000-step value into the 10 kV row. The Angstrom values are the stored source quantity; nm and µm are calculated with 1 Å = 0.1 nm = 0.0001 µm. The 150 pA / 30 kV row is 350 Å = 35 nm = 0.035 µm. The separate 250 pA / 10 kV row is 3000 Å = 300 nm.

## Lookup behavior

The query requires both beam voltage and beam current. Exact matches are the default. Optional linear interpolation uses two numeric current anchors at the same voltage, interpolating spot size only. Interpolation is an application estimate, not a source-workbook formula. Neither voltage interpolation nor current extrapolation is allowed. The `<1 pA` row is included in the reference table but is not a numeric interpolation anchor or an exact current assignment. Unsupported requests return `status: unavailable` and null sizes, never a nearest-voltage substitute or zero size.

Results return `spotSizeNM`, `spotSizeUM`, `sourceRows`, `status` and `requiresSLF`. Starred Lens 1 values are retained as reference text. Their SLF notes are displayed verbatim; they are not treated as calibrated absolute lens setpoints. No lookup changes beam or lens hardware settings.

## Frontend

`GET /api/processing/patterns` returns `lensLookup` alongside the pattern catalogue. The processing store validates and retains it. `frontend/src/lib/lensLookup.ts` exports `parseLensLookup`, `lookupSpotSize` and `estimateMillingDepth`. Missing or malformed lens data is displayed in the help panel rather than reused from an older fetch.

The **?** beside PROCESS / PATTERNS opens the complete source table, original notes, unit conversion and a spot-size calculator. The calculator makes beam voltage explicit, starts at 30 kV and 150 pA, and requires an explicit interpolation checkbox for non-reference currents. Supported source rows are highlighted. Existing pattern cards, stock availability and execution ordering are unchanged.

## glasgow_service

`glasgow_service.lens_lookup` exports `load_lens_lookup`, `lookup_spot_size` and `estimate_milling_depth`. Catalogue resolution is: explicit path, `PROCESSING_PATTERNS_CONFIG`, the sibling of the selected `GLASGOW_CONFIG`, then the source-tree catalogue when no deployment config exists. A missing sidecar in a selected deployment is an error rather than a fallback to another checkout.

Read-only API endpoints (with the service's existing optional bearer-token authentication):

- `GET /processing/lens-lookup`
- `GET /processing/spot-size?beam_voltage_kv=30&beam_current_pa=150&interpolate=false`
- `GET /processing/milling-depth?beam_current_pa=1000&exposure_time_s=1&area_um2=4&removal_rate_um3_per_nc=2`

The last example uses an arbitrary test rate to illustrate units; it is not a material calibration. A depth estimate requires a caller-supplied, independently calibrated removal rate in µm³/nC, the milled area in µm², and **beam-on exposure time** in seconds. The calculation is charge = current_pA × exposure_s / 1000, volume = charge_nC × rate_um3_per_nC, depth = volume_um3 / area_um2. It assumes uniform removal over the specified area. The lens workbook supplies no removal rates; the existing material brightness ratios are not substitutes. Host workflow elapsed time includes transfer/host overhead and must not be used as beam-on time.

These helpers are available for future processing calculations; they do not rewrite requested Depth, convert brightness ratios into a removal rate, or implement a calibrated milling executor.

## Reimport and deployment

Install `xlrd` in an import environment, then run `python Scripts/import-prelens-table.py [source.xls]`. Only the LensLookup block is replaced; other catalogue sections are preserved. `xlrd` is an import-time dependency only. Neither the service nor browser needs Excel readers at runtime.

The distribution builder requires the source workbook, Python lookup module, frontend helper and help component. The workbook is explicitly copied as a packaging input; the canonical JSON follows the existing shared-catalogue packaging path. Service unit templates and deployment exports set `PROCESSING_PATTERNS_CONFIG` to the packaged catalogue. Custom deployments must configure the same path in the web backend and Glasgow service.

Validation covers all imported values and the source hash, both voltage groups, qualifier/SLF preservation, exact matches, opt-in interpolation, unsupported currents/voltages, duplicate and invalid data, depth units/missing calibration, API authentication and no-device API use, the help table/calculator, application builds and distribution integrity.
