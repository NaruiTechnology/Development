# Internal local deployment runbook

This procedure builds the internal distribution, deploys it to a user-owned
`IobeamPlatform` directory, installs the local systemd services, and verifies
the complete UI stack.

The current internal deployment intentionally retains credentials in the JSON
configuration. Restrict repository and host access. Do not publish the archive.

## 1. Prepare the source host

Use Ubuntu 24.04 or newer. From the Operations checkout:

```bash
cd ~/Project/Operations
git status --short
python3 --version
node --version
npm --version
```

Review the deployment target and configuration before building:

```bash
python3 -m json.tool \
  Development/DeployWorkSpace/Development/DistributionDeploy/Json/DistributionDeploy.json \
  >/dev/null
```

The deploy root must end in `IobeamPlatform`. The workflow refuses to clear
`/`, a home directory, or a differently named target.

## 2. Build the distribution

Run the builder. It finds its workspace from its own location, so the current
directory does not matter:

```bash
python3 Development/buildCompiledDist.py
```

For an internal diagnostic package containing raw Python instead of bytecode:

```bash
python3 Development/buildCompiledDist.py --raw
```

The builder validates that every required module and file is present, writes
`dist_manifest.json` into the archive, re-verifies the finished archive, and
prints a line such as `Verified dist_app.zip: version=... commit=... mode=compiled(cpython-312)`.
It creates a versioned `DeployWorkspace_*.zip` handoff archive and places
`dist_app*.zip` inside its DistributionDeploy directory. A build that is missing
any required input exits nonzero and leaves no archive. Confirm both outputs:

```bash
ls -lh DeployWorkspace_*.zip
ls -lh Development/DeployWorkSpace/Development/DistributionDeploy/dist_app*.zip
```

## 3. Transfer and unpack on the target host

Copy the newest `DeployWorkspace_*.zip` to the internal target, then:

```bash
mkdir -p ~/DeployWorkspace
unzip DeployWorkspace_<version>_<timestamp>.zip -d ~/DeployWorkspace
cd ~/DeployWorkspace/DeployWorkSpace/Development/DistributionDeploy
```

The archive's top-level folder is `DeployWorkSpace` (capital S), so the
workflow lives one level below the folder you extracted into.

Do not unpack or run the deployment as root. Use the administrator account
that should own the user services; the workflow requests `sudo` for individual
OS-level operations.

## 4. Review target-specific values

Edit `Json/DistributionDeploy.json` and confirm at least:

- `Deployment.DeployRoot` is `~/IobeamPlatform` or another path whose final
  component is exactly `IobeamPlatform`.
- `IsProduction` is `false` for the local five-service deployment.
- Database address and account values are correct for the internal network.
  The manifest holds only `${VAR}` references for them; the values live in
  the secrets file (section 4a).
- Glasgow configuration and USB identifiers match the target hardware.

## 4a. Credentials (secrets file)

No password, login, token or connection string is stored in the repository,
`dist_app.zip`, or the DeployWorkspace archive; the build fails if one is
found. Every component reads them from one owner-only file on the target:

```text
~/.config/iobeam/secrets.env        (mode 600, directory 700; override: IOBEAM_SECRETS_FILE)
```

It lives in the service account's home, so the clean redeploy (which deletes
`DeployRoot`) never removes it. The `provisionSecrets` action creates or
completes it right after `stopLocalSystem`, **before anything is deleted, and
without asking the installer anything**. For each value the first available
source wins:

1. a prepared file given with `--secrets-file FILE` (replaces stored values);
2. the existing secrets file (so later deployments reuse it);
3. the deploy shell's environment (`export IOBEAM_FTP_PASSWORD=...`);
4. what earlier releases left on this host:
   - the installation in `DeployRoot` (its JSON files and backend `.env`);
   - earlier `DeployWorkspace_*` archives or extracted folders next to the
     one being deployed, or in `~`, `~/Downloads` and `/tmp` (their deploy
     manifest and `dist_app.zip`);
   - `~/.bashrc` (`export GLASGOW_TOKEN=...`) and `/etc/glasgow-svc.env`;
5. generated: `GLASGOW_TOKEN` and the local runtime DB password.

So an upgrade from a release that kept credentials in JSON, or a host where a
newer deployment already replaced that installation, carries the existing
values over with no input. Anything still unknown does **not** stop the
deployment: the installation runs without it and the log ends with a
"Not configured" summary:

- no shared admin database login: the app uses the local admin database
  this deployment creates (seeded with the root account and the equipment
  registry);
- no FTP login: scan upload to FTP is disabled.

Set them later without redeploying, in the web app (Settings > Admin >
Database or FTP) or with `python3 -m secretstore set NAME` followed by
`Development/Scripts/manage-local-system.sh restart`.

To provide values up front on a host that has none of the above, prepare a
file readable only by you and pass it:

```bash
umask 077
cat > ~/iobeam-secrets.env <<'EOT'
IOBEAM_ADMIN_CONFIG_DB_HOST=db.example.internal
IOBEAM_ADMIN_CONFIG_DB_USER=your-db-login
IOBEAM_ADMIN_CONFIG_DB_PASSWORD='the database password'
IOBEAM_FTP_HOST=ftp.example.internal
IOBEAM_FTP_USER=your-ftp-login
IOBEAM_FTP_PASSWORD='the FTP password'
EOT
python3 Development/DistributionDeploy/distributionDeployApp.py --secrets-file ~/iobeam-secrets.env
rm ~/iobeam-secrets.env      # its values are now in ~/.config/iobeam/secrets.env
```

To be asked for missing values instead, set `"prompt": true` in the
`provisionSecrets` action, or run `python3 -m secretstore init` any time.

| Variable | Required | Used by |
| --- | --- | --- |
| `IOBEAM_ADMIN_CONFIG_DB_HOST`, `_USER`, `_PASSWORD` | no (local admin DB when unset) | shared admin DB the app queries: `IobeamAdmin.json` Database block (Settings, Database); users, equipment, reports |
| `GLASGOW_TOKEN` | yes (generated) | bearer token shared by glasgow_service and the backend |
| `IOBEAM_ADMIN_DB_PASSWORD` | generated | local runtime role created by `setupIobeamAdminDb` (`IobeamAdminDb.json`) |
| `IOBEAM_FTP_HOST`, `IOBEAM_FTP_USER`, `IOBEAM_FTP_PASSWORD` | no | scan CSV/PNG upload (`streamData.json` ftp); empty disables upload |
| `IOBEAM_ADMIN_DB_HOST`/`_USER`, `IOBEAM_OPERATION_DB_*` | written by the deploy | runtime role and operation telemetry DB |
| `SMTP_USER`, `SMTP_PASSWORD`, `TWILIO_*` | no | optional notification providers |

Manage the file later with the bundled tool, from
`DeployWorkSpace/Development/DistributionDeploy/vendor` in the handoff
archive, or from `Development/` in a source checkout. Values are never
printed:

```bash
python3 -m secretstore init                          # ask for anything missing, generate tokens
python3 -m secretstore init --from FILE              # take values from a prepared file
python3 -m secretstore set IOBEAM_FTP_PASSWORD       # change one value (hidden prompt, asked twice)
python3 -m secretstore list                          # names, values masked
python3 -m secretstore check                         # what is still missing
```

After changing a value, restart the stack (`Scripts/manage-local-system.sh
restart`); the systemd units load the file through `EnvironmentFile=`.
Values saved from the web Settings dialog (FTP, Database) are written to this
file and take effect immediately; the JSON keeps the `${VAR}` reference.

Equipment (Settings, Configuration, Equipment) is read from the admin
database only. If that database cannot be reached, for example because the
secrets file is missing, the table shows the database error instead of
cached rows; nothing is stored in `IobeamAdmin.json`.

Keep a terminal open and authenticate sudo before the long workflow, so an
expired password prompt does not look like a stalled state:

```bash
sudo -v
```

## 5. Run the deployment workflow

```bash
python3 distributionDeployApp.py \
  -j ./Json/DistributionDeploy.json \
  -r ~/IobeamPlatform
```

The workflow now:

1. Selects exactly one `dist_app*.zip` (none or several abort the deploy) and
   verifies it against its manifest *before stopping anything*: every file's
   SHA-256, no missing or unlisted members, and bytecode built by this host's
   Python. Then it stops the running system.
2. Safely clears only the validated deployment root.
3. Extracts that archive and re-verifies the extracted tree, logging the build
   identity (`version= commit= built= mode= python=`).
4. Creates the deployment virtual environment.
5. Installs Python, Node, PostgreSQL, Glasgow, and optional Pi GPIO runtime.
   The Python step also installs `Development/ionbeam-native/requirements.txt`
   (the native desktop client) and checks that `PyQt6` imports.
6. Creates and secures the backend `.env` as mode `0600`. It contains no
   credentials; database logins and `GLASGOW_TOKEN` go to the secrets file.
7. Installs the local Redis/Sentinel smoke-test topology.
8. `installIonbeamNative`: installs the Qt runtime libraries (apt), then runs
   `Development/ionbeam-native/scripts/install_linux.sh --venv .venv --skip-pip`
   for the deploying user: `~/.local/bin/ionbeam-native` launcher, an
   applications-menu entry, and a smoke test that starts the app offscreen
   against its built-in Glasgow emulator (no hardware is touched). Skipped on
   production (remote) hosts. `desktopEntry` / `runSmokeTest` in the action's
   `actionData` turn those parts off.
9. Calls `Scripts/manage-local-system.sh restart`.
10. Verifies Glasgow (`8765`), SBC vacuum (`8766`), executor (`8780`), backend
    (`4000`), frontend (`5173`), and administrative API endpoints.

Any missing workstate, failed command, or failed readiness check now makes
`distributionDeployApp.py` exit nonzero.

Qt and Redis package installation first checks the configured package list and
skips apt when everything is installed. Otherwise it configures interrupted dpkg
work, refreshes apt, repairs dependencies, completes dpkg configuration, installs
the requested libraries, and verifies them. An initial dpkg dependency failure
does not prevent apt repair. Commands use noninteractive sudo; the entrypoint
authenticates and keeps the credential alive. Package failures report the step
name and exit code with stdout and stderr, including apt's dependency details.

## 6. Verify the deployed system

```bash
cd ~/IobeamPlatform
./Scripts/manage-local-system.sh status
curl -fsS http://127.0.0.1:8765/status
curl -fsS http://127.0.0.1:8766/health/ready
curl -fsS http://127.0.0.1:8780/health/live
curl -fsS http://127.0.0.1:4000/healthz
curl -fsS http://127.0.0.1:5173/ >/dev/null
```

Open the UI at:

```text
http://127.0.0.1:5173/control
```

Start the native desktop client from the applications menu (**Ion Beam
(native)**) or with `ionbeam-native`; it uses the same backend and shares the
Glasgow with the web stack through a device lock. See
`Development/ionbeam-native/docs/RUNBOOK.md`.

Do not run additional `npm run dev` or Uvicorn commands. The backend, frontend,
Glasgow, and vacuum processes are already supervised by systemd.

## 7. Day-to-day administration

```bash
cd ~/IobeamPlatform
./Scripts/manage-local-system.sh restart
./Scripts/manage-local-system.sh status
./Scripts/manage-local-system.sh logs
./Scripts/manage-local-system.sh stop
./Scripts/manage-local-system.sh start
```

Restart only the local SBC vacuum simulator when needed:

```bash
systemctl --user restart sbc-vacuum.service
systemctl --user status sbc-vacuum.service --no-pager -l
```

## 8. Troubleshooting

Inspect user services:

```bash
journalctl --user \
  -u sbc-vacuum.service \
  -u ionbeam-web-backend.service \
  -u ionbeam-web-frontend.service \
  -n 100 --no-pager
```

Inspect system services:

```bash
sudo journalctl \
  -u glasgow-svc.service \
  -u vacuum-executor.service \
  -n 100 --no-pager
```

Inspect listeners:

```bash
ss -ltnp | grep -E ':(8765|8766|8780|4000|5173)\\b'
```

If deployment fails, correct the reported state and rerun the workflow. The
deploy-root operation is deliberately a fresh deployment, not an in-place
upgrade. Back up site-specific data before rerunning.
