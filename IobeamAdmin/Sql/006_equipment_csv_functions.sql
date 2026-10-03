-- =====================================================================================================
-- 006_equipment_csv_functions.sql - Equipment table CSV import/export functions.
-- Loaded after 001/002/003/005 by applyAdminDatabaseSetup(); safe to apply repeatedly.
-- =====================================================================================================
SET search_path TO iobeam_admin, ionbeam_asset, public;

CREATE OR REPLACE FUNCTION fn_equipment_csv_cell(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_value ~ E'[,"\r\n]' THEN '"' || replace(p_value, '"', '""') || '"'
        ELSE p_value
    END;
$$;

CREATE OR REPLACE FUNCTION fn_equipment_csv_site_allowed(p_site text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT btrim(COALESCE(p_site, '')) = ANY(ARRAY[
        'Beijing(北京)',
        'Shanghai(上海)',
        'Shenzheng(深圳)',
        'Wuxi(无锡)',
        'Xian(西安)',
        'Chengdu(成都)',
        'Hangzhou(杭州)',
        'Tianjing(天津)',
        'Taixin(泰兴)'
    ]::text[]);
$$;

CREATE OR REPLACE FUNCTION fn_export_equipment_csv()
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT 'id,name,model,serial_number,site,description' || E'\r\n' ||
           COALESCE(
               string_agg(
                   concat_ws(',',
                       fn_equipment_csv_cell(e.id::text),
                       fn_equipment_csv_cell(btrim(e.name::text)),
                       fn_equipment_csv_cell(btrim(e.model::text)),
                       fn_equipment_csv_cell(btrim(e.serial_number::text)),
                       fn_equipment_csv_cell(btrim(e.site::text)),
                       fn_equipment_csv_cell(btrim(e.description::text))
                   ),
                   E'\r\n' ORDER BY e.site, e.name, e.id
               ),
               ''
           )
      FROM ionbeam_asset.equipment e
     WHERE btrim(e.site::text) IN (
        'Beijing(北京)',
        'Shanghai(上海)',
        'Shenzheng(深圳)',
        'Wuxi(无锡)',
        'Xian(西安)',
        'Chengdu(成都)',
        'Hangzhou(杭州)',
        'Tianjing(天津)',
        'Taixin(泰兴)'
     );
$$;

CREATE OR REPLACE FUNCTION fn_import_equipment_csv(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    item jsonb;
    v_row_number bigint;
    v_id integer;
    v_name text;
    v_model text;
    v_serial text;
    v_site text;
    v_description text;
    v_by_id integer;
    v_by_serial integer;
    v_match_count integer;
    v_target_id integer;
    v_seen_ids integer[] := ARRAY[]::integer[];
    v_seen_serials text[] := ARRAY[]::text[];
    v_added integer := 0;
    v_updated integer := 0;
BEGIN
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'array' THEN
        RAISE EXCEPTION 'equipment must be a CSV row array'
            USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_payload) < 1 OR jsonb_array_length(p_payload) > 10000 THEN
        RAISE EXCEPTION 'equipment must contain between 1 and 10,000 CSV rows'
            USING ERRCODE = '22023';
    END IF;

    LOCK TABLE ionbeam_asset.equipment IN SHARE ROW EXCLUSIVE MODE;

    FOR item, v_row_number IN
        SELECT rows.value, rows.ordinality
          FROM jsonb_array_elements(p_payload) WITH ORDINALITY AS rows(value, ordinality)
    LOOP
        IF jsonb_typeof(item) <> 'object' THEN
            RAISE EXCEPTION 'equipment row % is invalid', v_row_number USING ERRCODE = '22023';
        END IF;

        IF jsonb_typeof(item->'name') <> 'string'
           OR jsonb_typeof(item->'serial_number') <> 'string' THEN
            RAISE EXCEPTION 'equipment row % needs a name and serial number', v_row_number USING ERRCODE = '22023';
        END IF;

        v_name := btrim(item->>'name');
        v_serial := btrim(item->>'serial_number');
        IF v_name = '' OR v_serial = '' THEN
            RAISE EXCEPTION 'equipment row % needs a name and serial number', v_row_number USING ERRCODE = '22023';
        END IF;
        IF char_length(v_name) > 100 OR char_length(v_serial) > 15 THEN
            RAISE EXCEPTION 'equipment row % exceeds the name or serial number length limit', v_row_number USING ERRCODE = '22023';
        END IF;
        IF v_name ~ E'[\r\n]' OR v_serial ~ E'[\r\n]' THEN
            RAISE EXCEPTION 'equipment row % name and serial number cannot contain line breaks', v_row_number USING ERRCODE = '22023';
        END IF;

        v_id := NULL;
        IF item ? 'id' AND item->'id' <> 'null'::jsonb THEN
            IF jsonb_typeof(item->'id') <> 'number'
               OR item->>'id' !~ '^[1-9][0-9]*$'
               OR (item->>'id')::numeric > 2147483647 THEN
                RAISE EXCEPTION 'equipment row % has an invalid ID', v_row_number USING ERRCODE = '22023';
            END IF;
            v_id := (item->>'id')::integer;
            IF v_id = ANY(v_seen_ids) THEN
                RAISE EXCEPTION 'CSV repeats equipment ID %', v_id USING ERRCODE = '22023';
            END IF;
            v_seen_ids := array_append(v_seen_ids, v_id);
        END IF;

        v_model := NULL;
        v_site := NULL;
        v_description := NULL;
        IF item ? 'model' THEN
            IF jsonb_typeof(item->'model') <> 'string' THEN
                RAISE EXCEPTION 'equipment row % has an invalid model', v_row_number USING ERRCODE = '22023';
            END IF;
            v_model := btrim(item->>'model');
            IF char_length(v_model) > 100 OR v_model ~ E'[\r\n]' THEN
                RAISE EXCEPTION 'equipment row % has an invalid model', v_row_number USING ERRCODE = '22023';
            END IF;
        END IF;
        IF item ? 'site' THEN
            IF jsonb_typeof(item->'site') <> 'string' THEN
                RAISE EXCEPTION 'equipment row % has an invalid site', v_row_number USING ERRCODE = '22023';
            END IF;
            v_site := btrim(item->>'site');
            IF char_length(v_site) > 50 OR v_site ~ E'[\r\n]' OR NOT fn_equipment_csv_site_allowed(v_site) THEN
                RAISE EXCEPTION 'equipment row % has an invalid site', v_row_number USING ERRCODE = '22023';
            END IF;
        END IF;
        IF item ? 'description' THEN
            IF jsonb_typeof(item->'description') <> 'string' THEN
                RAISE EXCEPTION 'equipment row % has an invalid description', v_row_number USING ERRCODE = '22023';
            END IF;
            v_description := btrim(item->>'description');
            IF char_length(v_description) > 1000 THEN
                RAISE EXCEPTION 'equipment row % has an invalid description', v_row_number USING ERRCODE = '22023';
            END IF;
        END IF;

        IF lower(v_serial) = ANY(v_seen_serials) THEN
            RAISE EXCEPTION 'CSV repeats serial number %', v_serial USING ERRCODE = '22023';
        END IF;
        v_seen_serials := array_append(v_seen_serials, lower(v_serial));

        v_by_id := NULL;
        IF v_id IS NOT NULL THEN
            SELECT e.id INTO v_by_id
              FROM ionbeam_asset.equipment e
             WHERE e.id = v_id;
        END IF;

        SELECT min(e.id), count(*)::integer
          INTO v_by_serial, v_match_count
          FROM ionbeam_asset.equipment e
         WHERE lower(btrim(e.serial_number::text)) = lower(v_serial);
        IF v_match_count > 1 THEN
            RAISE EXCEPTION 'serial number % matches multiple existing equipment rows', v_serial USING ERRCODE = '22023';
        END IF;
        IF v_by_id IS NOT NULL AND v_by_serial IS NOT NULL AND v_by_id <> v_by_serial THEN
            RAISE EXCEPTION 'equipment ID % and serial number % identify different existing rows', v_id, v_serial
                USING ERRCODE = '22023';
        END IF;

        v_target_id := COALESCE(v_by_id, v_by_serial);
        IF v_target_id IS NOT NULL THEN
            UPDATE ionbeam_asset.equipment
               SET name = v_name,
                   model = CASE WHEN item ? 'model' THEN v_model ELSE model END,
                   serial_number = v_serial,
                   site = CASE WHEN item ? 'site' THEN v_site ELSE site END,
                   description = CASE WHEN item ? 'description' THEN v_description ELSE description END
             WHERE id = v_target_id;
            v_updated := v_updated + 1;
        ELSE
            IF NOT fn_equipment_csv_site_allowed(v_site) THEN
                RAISE EXCEPTION 'new equipment row % needs a supported site', v_row_number USING ERRCODE = '22023';
            END IF;
            INSERT INTO ionbeam_asset.equipment (name, model, serial_number, site, description)
            VALUES (v_name, COALESCE(v_model, ''), v_serial, COALESCE(v_site, ''), COALESCE(v_description, ''));
            v_added := v_added + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'equipment', fn_list_equipment(),
        'added', v_added,
        'updated', v_updated
    );
END;
$$;
