# IobeamAdmin

Security-model artifacts for the administrative account system.

Contents:

- `Json/IobeamAdmin.json` - canonical container for the admin data model.
- `Sql/001_schema.sql` - PostgreSQL tables and stored procedures, including the mobility host allowlist table.
- `Sql/002_seed_root_user.sql` - bootstrap admin account.

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
