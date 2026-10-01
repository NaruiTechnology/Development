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
- Glasgow configuration and USB identifiers match the target hardware.

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
6. Creates and secures the backend `.env` as mode `0600`.
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
