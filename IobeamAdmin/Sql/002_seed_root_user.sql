SET search_path TO iobeam_admin, public;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM "user"
         WHERE btrim(email::text) = 'lyh1154@gmail.com'
    ) THEN
        UPDATE "user"
           SET login_name = 'vboxuser',
               first_name = 'henry',
               last_name = 'li',
               phone_number = '1 (503)807-9055',
               company_name = '',
               role = 4,
               is_active = true,
               session_lifetime_limit_days = 1
         WHERE btrim(email::text) = 'lyh1154@gmail.com';
    ELSIF EXISTS (
        SELECT 1
          FROM "user"
         WHERE btrim(login_name::text) = 'vboxuser'
    ) THEN
        UPDATE "user"
           SET first_name = 'henry',
               last_name = 'li',
               email = 'lyh1154@gmail.com',
               phone_number = '1 (503)807-9055',
               company_name = '',
               role = 4,
               is_active = true,
               session_lifetime_limit_days = 1
         WHERE btrim(login_name::text) = 'vboxuser';
    ELSE
        INSERT INTO "user" (
            login_name,
            first_name,
            last_name,
            email,
            phone_number,
            company_name,
            role,
            is_active,
            session_lifetime_limit_days
        )
        VALUES (
            'vboxuser',
            'henry',
            'li',
            'lyh1154@gmail.com',
            '1 (503)807-9055',
            '',
            4,
            true,
            1
        );
    END IF;
END;
$$;

INSERT INTO ionbeam_asset.equipment (name, model, serial_number, site, description)
VALUES (
    'FEI Helios NanoLab 600i DualBeam',
    '',
    'DB123456z',
    'Taixin',
    'DualBeam SEM/FIB, containing both a focused Ga+ ion beam ("Tomahawk") and a high resolution field emission scanning electron ("Elstar") column.'
)
ON CONFLICT (serial_number) DO UPDATE
   SET name = EXCLUDED.name,
       model = EXCLUDED.model,
       site = EXCLUDED.site,
       description = EXCLUDED.description;
