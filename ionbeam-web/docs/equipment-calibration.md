# FIB | SEM equipment calibration parameters

CONFIGURATION > **Admin** > **Calibration** manages the machine-data parameters of a registered machine
(`ionbeam_asset.equipment`), separately for its **FIB** (ion column) and **SEM** (electron column + shared stage/vacuum
hardware) side. A DualBeam such as DB235 therefore has one FIB profile and one SEM profile.

## What is stored

| | |
|---|---|
| Catalog | 2,435 parameter definitions (FIB 501, SEM 1,934), 15 table layouts, derived from the vendor files `icmd.TXT` (FIB), `md.TXT` (SEM) and `UI1280reg.txt` (registry). Each has a group, type, unit, access level, vendor symbol and source reference. |
| Profile | one row per (equipment, FIB\|SEM, profile name); exactly one is active. Holds the revision counter. |
| Values | the current value of each parameter in a profile. |
| Revisions | append-only. Every save / import / restore is a new revision with the list of changes (old -> new), who, when, why, and a full snapshot. |

Never catalogued or stored: the vendor passwords (`IONI_PSWD1-4`), registry user accounts / login keys, binary blobs, debug
and UI-preference keys (see `IobeamAdmin/CalibrationCatalog/calibration_catalog_report.json` for the full exclusion list).

**758 SEM parameters (and 4 FIB) have no vendor documentation.** They are shown with an *Undocumented* badge and cannot be
changed without an explicit acknowledgement. An admin can name one (*Details > Edit name / description*); that edit is
audited (`calibration_definition_change`) and survives a catalog re-seed.

## Who may do what

| Action | Minimum `role` |
|---|---|
| view | any signed-in account |
| edit an *adjustable* parameter, restore a revision | 1 SuperUser |
| edit a *service* / *automatic* parameter, import a vendor file | 2 Developer |
| edit a *fixed* parameter, edit the catalog | 3 Admin |

Changing a vendor-undocumented, fixed or low-confidence parameter additionally needs `acknowledge_risk` (a checkbox in
the UI). The database enforces all of this; the UI only explains refusals early.

Saves are atomic (all values valid, or nothing is written), use optimistic locking (`expected_revision`) and check the
vendor limits (`MIN`/`MAX` pairs; an unset `0/0` or inverted pair means *no limit*).

## Vendor file import

*Import vendor file* takes `icmd.TXT` / `md.TXT` or the registry export, shows a dry-run (recognised, would change,
ignored, refused, risky), and only writes after confirmation. Lines are matched by `(int|float, slot)` or registry path.
`icmd.TXT` and `md.TXT` reuse slot numbers, so the vendor symbol on each line must equal the catalog's; importing the wrong
file into a column is refused. A value outside the vendor's documented enum list (e.g. `IONI_DET_USED = 2`, documented 0/1)
is imported as found, with a warning. Recognised values that fail type, integer, enum or limit validation block the whole
commit; valid rows are never silently imported as a partial subset.

## Calibration CSV (export / import)

*Export CSV* writes `calibration_<equipment>_<FIB|SEM>_r<revision>.csv`; by default the browser downloads it. Where the
File System Access API is available, a separate *Choose export folder* button lets the operator choose a folder on
**their own computer** instead (Chrome / Edge over HTTPS or `localhost`). Unsupported browsers show no extra destination
control. The choice is remembered per browser (IndexedDB); the browser asks once per session to allow writing. If writing
is refused or fails, the file is downloaded as usual. The × button returns to browser downloads.

*Import* also accepts that CSV. Only `parameter_key` and `value` are read (column order free; `,` `;` or tab separated;
decimal commas accepted in `;` files). The file is validated as a whole by `backend/src/calibrationCsvFile.ts` and refused,
with every problem and its line number, on: broken quoting, rows with the wrong number of cells, missing / duplicate
columns, empty or malformed keys, formula-looking values (`=...`, `@...`), a key listed twice with different values, no
values at all, binary content, more than 20,000 rows, or a file name of the other column (`..._SEM_...` into FIB).
Warnings (import still possible): exported from other equipment, repeated identical rows, empty values (skipped - an import
never clears a value), decimal commas, and a file exported at an older revision than the current one. Rows are then matched
by `parameter_key` in `fn_import_equipment_calibration`, which applies the usual type / enum / limit / role / risk rules;
its per-row findings are reported with the CSV line.

Existing databases need the admin database setup re-applied once (CONFIGURATION > Admin > Configuration) to get the
updated `fn_import_equipment_calibration`.

## Deployment

* `IobeamAdmin/Sql/003_calibration_schema.sql` is applied automatically after `001_schema.sql` by
  `applyAdminDatabaseSetup` (idempotent). So is `005_dimension_calibration_schema.sql` (Dimension Cal's
  one-row-per-equipment table).
* The catalog (`004_calibration_seed.sql`, generated) is loaded on first use, or explicitly with
  `npm run db:seed:calibration` (backend). Re-running keeps human-edited names. The admin route
  `POST /api/admin/iobeam/calibration/catalog/reload` does the same.
* Regenerate the catalog after changing the taxonomy or parsers:
  `python IobeamAdmin/CalibrationCatalog/build_seed.py <folder with the three vendor files>`.

## API (`ionbeam-web/backend/src/calibrationRoutes.ts`)

`GET groups`, `GET :equipmentId/:type` (filters `group_code q access_level undocumented keys limit offset`),
`GET .../tables/:code`, `PUT .../values`, `GET .../history[/:revision]`, `POST .../restore`, `POST .../import`,
`GET .../export.csv`, `PATCH definitions/:id`, `POST catalog/reload` - all under `/api/admin/iobeam/calibration/`.
Failures are `{ ok:false, error, code, errors[] }` with 401 / 403 / 404 / 409 (`risk_ack_required`, `revision_conflict`) / 422.

Dimension Cal itself (`dimensionCalibrationRoutes.ts`): `GET` / `PUT /api/admin/iobeam/dimension-calibration/:equipmentId`,
`{ ok, calibration }` with `calibration: null` when nothing has been saved for that equipment yet. Any
signed-in account may read or write it — no per-field role gate, matching the DIMENTION CAL wedge's own
"Confirm" button.

## Tests

```bash
pip install pgserver psycopg2-binary pytest
cd IobeamAdmin/CalibrationCatalog
CALIBRATION_DOCS_DIR=<folder with the vendor files> python -m pytest tests -q   # SQL behaviour + API end-to-end against a throw-away PostgreSQL
cd ionbeam-web/backend  && npm test && npm run typecheck                        # vendor-file parsers
cd ionbeam-web/frontend && npm test && npm run typecheck                        # model logic (+ existing suites)
```
Without `CALIBRATION_DOCS_DIR` the tests that need the vendor files are skipped.

## Known limits

* Catalog text (group labels, parameter names, descriptions) is English; the surrounding UI is en / zh-CN / zh-TW.
* Server-side refusal messages are English.
* `ROLE_AUDIT` (4) is numerically above Admin, so following the existing `role < ROLE_ADMIN` convention auditors can write.

## Scan geometry (world coordinates), and Dimension Cal

*CONFIGURATION > Admin > Calibration > Scan geometry* turns the active profile into the scan frame of the
selected machine / column and rectifies it, so ROI and bitmap scans address physical world positions (µm).

```
world = stage + C · N · H · (DAC - 8191.5 - δ)
```

| Term | Meaning | From |
|---|---|---|
| H | gateware transform: `rotate90` swaps X/Y, `xflip`/`yflip` = 16383 - code | `streamData.json` transforms |
| N | rotation (`IONF_ROT_OFFSET` + scan rotation) · diag(k, k·aspect·tilt), k = HFOV / 16384 µm per code | profile, magnification calibration |
| C, δ | fiducial correction: residual scale X/Y, rotation, shear (C, dimensionless) and centre offset (δ, DAC codes) | least-squares fit |
| stage | world position of the frame centre | entered |

Pixels come from `ScanX`/`ScanY` (fallback `ScanWidth`/`ScanLines`, then `rasterScan.resolution`); pixel *i* is DAC
code `i · 16384 / N`. HFOV comes from the magnification calibration (log-log interpolation, `1/mag` outside the table),
else the vendor photo height `IONF_PHOTO_IMG_SIZE_Y / mag`, else a 127 mm reference. An unset `IONF_MAG_YX_ASPECT`
(0) means 1. Tilt correction (off by default) stretches Y by `1 / cos(IONF_IBEAM_TILT - stage tilt)`. The spot-park
registers are treated as 16-bit and shown as a world position only.

The section-3 preview (`GeometryPreview`) only renders once there's something to plot — a fiducial, or a fit —
since with neither, nominal and rectified frames are identical and it would just be an empty square
(`geometry.previewEmpty` explains this in the UI; `cornersRoughlyEqual` is the check).

**Dimension Cal** (CONFIGURATION > Calibrate > DIMENTION CAL) is the simpler, older, image-based way to set the
same world-coordinate mapping: measure a real scanned image and enter what its edges are in µm. Both paths write
to the same place (`store/dimensionCalibrationSlice.ts`, one row per equipment server-side — see below — plus
`localStorage` for instant/offline use) and `lib/roiDac.ts` falls back to Dimension Cal's plain linear bounds
whenever no rectified Scan geometry is applied. Each save is tagged with a `source` (`manual` or `scanGeometry`,
with the equipment/type/revision that produced it) so Dimension Cal can show where its current numbers came
from and warn before one source silently overwrites the other.

*CONFIGURATION > Admin > Calibration > "Go to Dimension Cal"* is a shortcut alongside the full Scan geometry
wedge for people who don't need fiducial fitting: it computes the same nominal (uncorrected) frame from the
active profile and magnification calibration, saves it as Dimension Cal's starting values, and switches straight
to the DIMENTION CAL tab so the operator can fine-tune or reconfirm it there as usual.

C and δ do not depend on magnification, so one fit holds at other magnifications; optionally the isotropic part of the
fitted scale is written into the magnification calibration (which restarts the scan service).

*Apply to scans* (SuperUser) stores a snapshot of every resolved input plus the correction in
`streamData.json > actionData.scanGeometry` (`GET`/`PUT /api/admin/scan-geometry`), sets the ROI editor axes to the
frame's world bounds and routes `worldSelectionToDacROI` through the inverse transform (a rotated selection is
scanned as its enclosing DAC rectangle). Editing the profile later does not change scans; the panel marks the snapshot
*stale* until it is re-applied. *Stop using* returns to the linear ROI mapping. The Python service is unchanged: it
still receives plain DAC ranges.

Code: `frontend/src/lib/scanGeometry.ts` (model, tests in `tests/scanGeometry.test.mjs`),
`frontend/src/components/calibration/ScanGeometryPanel.tsx`, `backend/src/scanGeometryConfig.ts`
(tests in `tests/scanGeometryConfig.test.ts`).
