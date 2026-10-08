-- =====================================================================================================
-- 006_equipment_csv_functions.sql - Equipment table CSV import/export functions.
-- Loaded after 001/002/003/005 by applyAdminDatabaseSetup(); safe to apply repeatedly.
-- =====================================================================================================
SET search_path TO iobeam_admin, ionbeam_asset, public;

ALTER TABLE ionbeam_asset.equipment ALTER COLUMN serial_number DROP NOT NULL;
ALTER TABLE ionbeam_asset.equipment
    ADD COLUMN IF NOT EXISTS equipment_code varchar(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS host_computer_model varchar(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS motherboard_model varchar(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS windows_version varchar(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS software_version varchar(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS coreco_processing_card varchar(1000) NOT NULL DEFAULT '';

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
    SELECT 'id,name,model,serial_number,site,equipmentCode,hostComputerModel,motherboardModel,windowsVersion,softwareVersion,corecoProcessingCard,description' || E'\r\n' ||
           COALESCE(
               string_agg(
                   concat_ws(',',
                       fn_equipment_csv_cell(e.id::text),
                       fn_equipment_csv_cell(btrim(e.name::text)),
                       fn_equipment_csv_cell(btrim(e.model::text)),
                       fn_equipment_csv_cell(COALESCE(btrim(e.serial_number::text), '')),
                       fn_equipment_csv_cell(btrim(e.site::text)),
                       fn_equipment_csv_cell(btrim(e.equipment_code::text)),
                       fn_equipment_csv_cell(btrim(e.host_computer_model::text)),
                       fn_equipment_csv_cell(btrim(e.motherboard_model::text)),
                       fn_equipment_csv_cell(btrim(e.windows_version::text)),
                       fn_equipment_csv_cell(btrim(e.software_version::text)),
                       fn_equipment_csv_cell(btrim(e.coreco_processing_card::text)),
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
    v_field text;
    v_field_value text;
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
           OR (item ? 'serial_number' AND jsonb_typeof(item->'serial_number') NOT IN ('string', 'null')) THEN
            RAISE EXCEPTION 'equipment row % needs a name and a valid serial number', v_row_number USING ERRCODE = '22023';
        END IF;

        v_name := btrim(item->>'name');
        v_serial := NULLIF(btrim(item->>'serial_number'), '');
        IF v_name = '' THEN
            RAISE EXCEPTION 'equipment row % needs a name', v_row_number USING ERRCODE = '22023';
        END IF;
        IF char_length(v_name) > 100 OR char_length(v_serial) > 15 THEN
            RAISE EXCEPTION 'equipment row % exceeds the name or serial number length limit', v_row_number USING ERRCODE = '22023';
        END IF;
        IF v_name ~ E'[\r\n]' OR COALESCE(v_serial ~ E'[\r\n]', false) THEN
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

        FOREACH v_field IN ARRAY ARRAY[
            'equipment_code', 'host_computer_model', 'motherboard_model',
            'windows_version', 'software_version', 'coreco_processing_card'
        ] LOOP
            IF item ? v_field THEN
                IF jsonb_typeof(item->v_field) <> 'string' THEN
                    RAISE EXCEPTION 'equipment row % has an invalid %', v_row_number, v_field USING ERRCODE = '22023';
                END IF;
                v_field_value := btrim(item->>v_field);
                IF char_length(v_field_value) > 1000 OR v_field_value ~ E'[\r\n]' THEN
                    RAISE EXCEPTION 'equipment row % has an invalid %', v_row_number, v_field USING ERRCODE = '22023';
                END IF;
            END IF;
        END LOOP;

        IF v_serial IS NOT NULL AND lower(v_serial) = ANY(v_seen_serials) THEN
            RAISE EXCEPTION 'CSV repeats serial number %', v_serial USING ERRCODE = '22023';
        END IF;
        IF v_serial IS NOT NULL THEN
            v_seen_serials := array_append(v_seen_serials, lower(v_serial));
        END IF;

        v_by_id := NULL;
        IF v_id IS NOT NULL THEN
            SELECT e.id INTO v_by_id
              FROM ionbeam_asset.equipment e
             WHERE e.id = v_id;
        END IF;

        SELECT min(e.id), count(*)::integer
          INTO v_by_serial, v_match_count
          FROM ionbeam_asset.equipment e
         WHERE v_serial IS NOT NULL AND lower(btrim(e.serial_number::text)) = lower(v_serial);
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
                   serial_number = CASE WHEN item ? 'serial_number' THEN v_serial ELSE serial_number END,
                   site = CASE WHEN item ? 'site' THEN v_site ELSE site END,
                   equipment_code = CASE WHEN item ? 'equipment_code' THEN btrim(item->>'equipment_code') ELSE equipment_code END,
                   host_computer_model = CASE WHEN item ? 'host_computer_model' THEN btrim(item->>'host_computer_model') ELSE host_computer_model END,
                   motherboard_model = CASE WHEN item ? 'motherboard_model' THEN btrim(item->>'motherboard_model') ELSE motherboard_model END,
                   windows_version = CASE WHEN item ? 'windows_version' THEN btrim(item->>'windows_version') ELSE windows_version END,
                   software_version = CASE WHEN item ? 'software_version' THEN btrim(item->>'software_version') ELSE software_version END,
                   coreco_processing_card = CASE WHEN item ? 'coreco_processing_card' THEN btrim(item->>'coreco_processing_card') ELSE coreco_processing_card END,
                   description = CASE WHEN item ? 'description' THEN v_description ELSE description END
             WHERE id = v_target_id;
            v_updated := v_updated + 1;
        ELSE
            IF NOT fn_equipment_csv_site_allowed(v_site) THEN
                RAISE EXCEPTION 'new equipment row % needs a supported site', v_row_number USING ERRCODE = '22023';
            END IF;
            INSERT INTO ionbeam_asset.equipment (
                name, model, serial_number, site, equipment_code, host_computer_model,
                motherboard_model, windows_version, software_version, coreco_processing_card, description
            )
            VALUES (
                v_name, COALESCE(v_model, ''), v_serial, COALESCE(v_site, ''),
                btrim(COALESCE(item->>'equipment_code', '')),
                btrim(COALESCE(item->>'host_computer_model', '')),
                btrim(COALESCE(item->>'motherboard_model', '')),
                btrim(COALESCE(item->>'windows_version', '')),
                btrim(COALESCE(item->>'software_version', '')),
                btrim(COALESCE(item->>'coreco_processing_card', '')),
                COALESCE(v_description, '')
            );
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
