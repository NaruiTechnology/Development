# secretstore: credentials outside the repository

Tracked configuration never contains a password, login, token or connection
string. A JSON value that needs one holds a reference instead:

```json
"ftp": {
    "enabled": true,
    "host": "${IOBEAM_FTP_HOST}",
    "username": "${IOBEAM_FTP_USER}",
    "password": "${IOBEAM_FTP_PASSWORD}",
    "folder": "/upload"
}
```

`${NAME:-default}` supplies a default (also used when the value is empty).

## Where values come from

For each reference, the first of these wins:

1. the process environment, `NAME`;
2. a file named by `NAME_FILE` (Docker/systemd credentials);
3. the secrets file: `$IOBEAM_SECRETS_FILE`, else
   `$XDG_CONFIG_HOME/iobeam/secrets.env` (default `~/.config/iobeam/secrets.env`).

The secrets file belongs to the service account, must be mode `600` (readers
refuse anything else), and uses systemd `EnvironmentFile=` syntax, so the
systemd units load the same file. It sits outside the checkout, outside
`dist_app.zip` and outside the deploy root that each deployment recreates.

## Who reads it

| Component | How |
| --- | --- |
| ionbeam-web backend | `src/secretStore.ts`: loaded at start-up; JSON placeholders resolved on read |
| glasgow_service, vacuum services, backend units | `EnvironmentFile=-@SECRETS_FILE@` in the unit templates |
| ionbeam-native, setup_remote_*.py | `import secretstore` |
| DistributionDeploy | `provisionSecrets` action (vendored copy, see `secretsSupport.py`) |

When an administrator types a credential into the web Settings dialog (FTP or
Database), the backend stores it in the secrets file and writes the reference
back to the JSON. Files from older releases are cleaned the same way the first
time they are read.

## Command line

Run from `Development/` (or `DistributionDeploy/vendor/` in a handoff archive):

```bash
python3 -m secretstore init                          # create/complete the file interactively
python3 -m secretstore init --from FILE              # ... or from a prepared KEY=VALUE file
python3 -m secretstore path                          # where the file is
python3 -m secretstore list                          # names; values masked
python3 -m secretstore set IOBEAM_FTP_PASSWORD       # hidden prompt, asked twice
python3 -m secretstore set GLASGOW_TOKEN --generate hex32
python3 -m secretstore check                         # missing values / unresolved ${VARS}
python3 -m secretstore harvest --root DIR            # copy literals out of an older installation
python3 -m secretstore scan .                        # fail on literal credentials
```

## Adding a new credential

1. Put `"${MY_SERVICE_PASSWORD}"` in the JSON (never the value).
2. Add the binding to `SECRET_BINDINGS` (Python) and, if the web Settings
   dialog edits it, to `secretStore.ts`.
3. Read the JSON through `secretstore.load_json()` / `expandPlaceholders()`.
4. Add it to `VARIABLES` in `secretstore/__init__.py`, which the deploy
   (`provisionSecrets`) and `init` use to decide what to generate or ask for.

`secretstore/tests` and the build both fail if a literal credential is
committed or packaged.
