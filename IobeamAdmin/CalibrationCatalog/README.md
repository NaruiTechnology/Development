# CalibrationCatalog

Builds the FIB | SEM parameter catalog (`../Sql/004_calibration_seed.sql`) from the vendor machine-data files.

```bash
python build_seed.py <folder with icmd.TXT, md.TXT, UI1280reg.txt>
```

`calibration_catalog/` parses the files (`md_parser`, `registry_parser`), classifies every parameter (`taxonomy`:
group, unit, access level, table layout), and `seed_export` writes the SQL. `calibration_catalog_report.json` lists the
statistics and everything deliberately left out (passwords, credentials, binary blobs, debug keys).
`ionbeam-web/backend/src/calibrationVendorFile.ts` is a line-for-line TypeScript port of the two parsers used by the
import; keep them in step. Tests: see `ionbeam-web/docs/equipment-calibration.md`.
