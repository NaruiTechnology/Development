-- Add edit metadata without changing imported equipment assignments.
ALTER TABLE ionbeam_asset.pattern_recipe
    ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN IF NOT EXISTS updated_by integer REFERENCES iobeam_admin."user"(id);
