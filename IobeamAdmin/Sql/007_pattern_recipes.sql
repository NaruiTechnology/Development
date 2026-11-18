-- Equipment-specific recipe collections. JSONB preserves ordered nodes and steps.
-- Imports never overwrite an existing equipment/pattern assignment.
CREATE TABLE IF NOT EXISTS ionbeam_asset.pattern_recipe (
    equipment_id integer NOT NULL REFERENCES ionbeam_asset.equipment(id) ON DELETE CASCADE,
    pattern_key text NOT NULL CHECK (length(trim(pattern_key)) > 0),
    collections jsonb NOT NULL CHECK (jsonb_typeof(collections) = 'array'),
    source_sha256 text NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (equipment_id, pattern_key)
);
