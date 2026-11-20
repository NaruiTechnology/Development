# Equipment and pattern recipe lookup

Recipe ownership is `(ionbeam_asset.equipment.id, pattern_key)`. A pattern key is the stable catalogue type key (`stairCut`), never the ID of a drawn ROI instance. Each assignment contains the named collections, ordered technology nodes, ordered steps, source SHA-256, and import timestamp. The first migrated recipe format is `StairRecipeDefaults`; other pattern types may have independent assignments using this step format. Other recipe models need a corresponding parser and editor.

`007_pattern_recipes.sql` adds `ionbeam_asset.pattern_recipe` with a foreign key to equipment and a composite primary key. It is included in admin database setup and distribution packaging. JSONB retains the existing ordered recipe structure without requiring one SQL column for each future recipe field. There is no global or cross-equipment recipe fallback. The application uses the configured admin database connection, including its secret resolution, and retries the provisioned local database after a remote connectivity failure.

## Migration

From `ionbeam-web/backend`:

```sh
npm run db:import:recipes -- EQUIPMENT_ID stairCut ../../GlasgowDataIO/Json/stepReceipes.json
```

Run once for each explicitly selected equipment ID. The command validates the full source before writing, applies the additive schema through existing database setup, and imports atomically. Repeating it preserves an existing assignment, including any independently modified machine recipes. It never copies to all machines implicitly. Equipment must already exist. The JSON file is retained as the legacy import source and rollback aid; runtime API reads bypass its reference in `processingPatterns.json`.

## Runtime

- `GET /api/processing/recipes/:equipmentId/:patternKey` returns `{ok, collections}` for exactly that assignment; absence is 404.
- `GET /api/processing/patterns?equipment_id=N` loads the static shape catalogue and database Stair cut recipes. `stairReceipes` remains the compatibility response field; `recipeEquipmentId` identifies ownership. With no selected equipment it returns no recipes, and Stair cut exposure requires equipment selection.
- The selected equipment is the existing application equipment selection. Changes reload recipes, discard previous machine overrides and ignore superseded fetch responses. Lookup failure clears the lens reference used to prepare exposure, so old machine data cannot silently execute.
- Technology node selection, editor placeholders, runtime estimates and exposure execution use the same database presets. Empty cells and Reset inherit that node's defaults. User overrides remain per ROI instance.
- `LensLookup`, shape definitions and material catalogue remain in JSON in this phase. No beam or lens setting is changed by recipe lookup.

The existing JSON parser is retained for importing legacy files and offline compatibility tests. The Admin tab now provides a recipe editor and an authenticated write endpoint; command-line imports still only create missing assignments. Deployment requires rebuilding the backend and frontend and importing recipes for the machines that will use Stair cut before switching the running application. Existing installations are not restarted by this change.

## Rollback

Switch back to the previous application build to resume JSON recipes. Leave the additive recipe table intact so imported assignments remain available. No legacy file is removed or rewritten, and existing equipment/calibration rows are untouched.


## Admin editor

CONFIGURATION > ADMIN > **Pattern recipes** selects a registered equipment ID and catalogue pattern. The **Pattern recipes** column in the Equipment tab shows the count of assigned patterns and opens that machine in the editor. The relation remains the recipe table's foreign key to equipment; no duplicate equipment-side recipe ID is stored. Unsaved equipment rows must be saved first.

Signed-in accounts can view assignments; Admin and Auditor accounts (role >= 3, matching the existing Equipment editor) can create and save them. The UI edits collection descriptions, technology node names, step defaults and individual step values. Changing a default updates steps that still match the previous default; distinct per-step values are preserved. A JSON import becomes an editable draft and is only written on Save. No data is automatically assigned to other machines.

Migration `008_pattern_recipe_editing.sql` adds revision, update timestamp and updating account. Saves require `expected_revision` (zero for a new assignment). A concurrent change produces HTTP 409 and keeps the unsaved draft visible. Validation checks every collection/node/step before an atomic save; depths must increase and pass counts, dwell and overlap must be in range. The foreign key prevents orphaned assignments. Node selection and Reset inherit database values so later saved defaults appear without baking them into user overrides.

Admin API:

- `GET /api/admin/iobeam/pattern-recipes`: assignment summaries.
- `GET /api/admin/iobeam/pattern-recipes/:equipmentId/:patternKey`: editable recipe and revision, or `recipe: null` for an unassigned pair.
- `PUT /api/admin/iobeam/pattern-recipes/:equipmentId/:patternKey`: `{collections, expected_revision}`; returns the new recipe and revision. Account identity comes from the authenticated session.

The additive schema migrations are included in database setup and distribution packaging. Rebuild the frontend and backend to deploy the new tab. Existing recipe imports are not bulk-copied or overwritten during setup.


The recipe step list uses the shared Admin AG Grid theme. The + toolbar button opens an add-step dialog; each row has Edit and Delete icons. Edit opens a modal with themed numeric controls and Update/Cancel. Update validates and stages the row in the recipe draft; Cancel leaves the row unchanged. Save recipes persists the staged document with its revision check. The separate Node name input is hidden; the technology-node selector still identifies the active node.


The Stair cut card's Technology node dropdown uses the selected equipment's saved SMProcess nodes, just like Admin. Admin opens on the active equipment by default and supports naming new nodes and renaming existing nodes in a dialog. Saving refreshes the active equipment's processing catalogue. The PATTERNS panel shows a labelled loading spinner and disables exposure start while its catalogue/recipe request is pending. Technology node choices are database data; importing the CSV does not invent named semiconductor technology nodes.


## Original technology-node restoration

Migrations 009/010 restore the exact Git HEAD presets in order: **28nm, 14nm, 7nm, 5nm, 2nm, 1nm**. The first value in HEAD is 28nm (not 128nm). The original five-step material/depth/removal-rate values are embedded as a frozen SQL seed, so neither API nor UI depends on a local JSON file at runtime. Both Stair cut and Admin read the selected equipment's database row. New equipment receives these defaults through an equipment-insert trigger; the Admin Create action also fetches them from the database defaults API.

The one-time migration replaces the generic `Imported CSV` node, preserves custom named nodes and modifications to existing named presets, and archives every changed document in `ionbeam_asset.pattern_recipe_history`. Subsequent saves are archived by the same update trigger. Existing CSV values remain available in history. Schema reapplication does not repeatedly restore nodes deliberately removed later by an operator. Explicit restoration is available with `npm run db:restore:technology-nodes` from the backend folder.

`GET /api/admin/iobeam/pattern-recipe-defaults/stairCut` returns the original named defaults to signed-in accounts. The Glasgow service exposes authenticated `GET /processing/recipes/{equipment_id}/{pattern_key}` and reads the same database-backed Node recipe API, using `IONBEAM_RECIPE_API_URL` (default `http://127.0.0.1:4000`). Remote service installations must point that setting to their Node backend. Missing assignments return 404 and an unavailable backend returns 503; there is no JSON fallback. Glasgow still executes prepared exposure lattices; reading recipes never changes a device setting.
