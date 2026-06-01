SET search_path TO iobeam_admin, public;

INSERT INTO "user" (
    login_name,
    first_name,
    last_name,
    email,
    phone_number,
    company_name,
    role,
    is_active
)
SELECT
    'vboxuser',
    'henry',
    'li',
    'lyh1154@gmail.com',
    '1 (503)807-9055',
    '',
    3,
    true
WHERE NOT EXISTS (
    SELECT 1
      FROM "user"
     WHERE login_name = 'vboxuser'
);
