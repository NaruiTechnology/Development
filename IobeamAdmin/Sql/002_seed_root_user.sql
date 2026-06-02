SET search_path TO iobeam_admin, public;

UPDATE "user"
   SET email = 'lyh1154@gmail.com',
       role = 4
 WHERE login_name = 'vboxuser';

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
SELECT
    'vboxuser',
    'henry',
    'li',
    'lyh1154@gmail.com',
    '1 (503)807-9055',
    '',
    4,
    true,
    1
ON CONFLICT (login_name) DO UPDATE
   SET first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       email = EXCLUDED.email,
       phone_number = EXCLUDED.phone_number,
       company_name = EXCLUDED.company_name,
       role = EXCLUDED.role,
       is_active = EXCLUDED.is_active,
       session_lifetime_limit_days = EXCLUDED.session_lifetime_limit_days;

INSERT INTO Equipment (name, model, serial_number, site, description)
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
