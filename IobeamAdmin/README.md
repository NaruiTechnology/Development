# IobeamAdmin

Security-model artifacts for the administrative account system.

Contents:

- `Json/IobeamAdmin.json` - canonical container for the admin data model.
- `Sql/001_schema.sql` - PostgreSQL tables and stored procedures, including the mobility host allowlist table.
- `Sql/002_seed_root_user.sql` - bootstrap admin account.
- `Sql/003_calibration_schema.sql` - FIB / SEM calibration-parameter tables and stored functions (applied after 001).
- `Sql/004_calibration_seed.sql` - generated parameter catalog; `CalibrationCatalog/build_seed.py` regenerates it.
  See `ionbeam-web/docs/equipment-calibration.md`.
- `Sql/005_dimension_calibration_schema.sql` - per-equipment Dimension Cal storage and functions.
- `Sql/006_equipment_csv_functions.sql` - equipment CSV export and validated, atomic import functions, applied by
  `ionbeam-web/backend/src/adminDbService.ts` during admin database setup.

For in-place schema upgrades on a live deployment, use the ionbeam-web backend
runner:

```bash
cd /home/vboxuser/Project/IobeamTech/Development/ionbeam-web/backend
npm run db:migrate:update-date
```

This module is intentionally separate from `GlasgowDataIO` and
`ionbeam-web`; the deployment workflow installs PostgreSQL and loads the
schema during host provisioning.

For day-to-day DB work, `pgAdmin 4` is the closest PostgreSQL equivalent
to SSMS; `DBeaver` is a good cross-database alternative.
