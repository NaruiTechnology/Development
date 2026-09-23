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
is imported as found, with a warning.

## Deployment

* `IobeamAdmin/Sql/003_calibration_schema.sql` is applied automatically after `001_schema.sql` by
  `applyAdminDatabaseSetup` (idempotent).
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

## Scan geometry (world coordinates)

*Calibration > Scan geometry* turns the active profile into the scan frame of the selected machine / column and
rectifies it, so ROI and bitmap scans address physical world positions (µm).

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
