# DistributionDeploy

For the supported internal localhost procedure, follow
[`DEPLOYMENT_RUNBOOK.md`](DEPLOYMENT_RUNBOOK.md). It is the authoritative
step-by-step build, deployment, verification, and administration guide.

A project distribution and deploy workflow built on the **AutomationPy**
framework. Mirrors the shape of `LoadFPGAImage` exactly:

* a JSON config (`Json/DistributionDeploy.json`) defines the workflow as a
  sequence of named actions,
* one concrete `*_state` class per action lives in `workstates/`,
* a single `WorkThread` (`workthreads/DistributionDeployThread.py`) loops
  the actions, instantiates each state dynamically, and runs them through
  a queue,
* an entry-point script (`distributionDeployApp.py`) wires it all together.

The target environment is **Ubuntu 24.04 or newer**.

---

## Two-stage flow

```
   (developer host)                       (deploy host: Ubuntu 24.04+)
   ┌─────────────────┐                    ┌──────────────────────────┐
   │ buidCompiledDist│  builds            │ unzip dist_app.zip       │
   │      .py        │ ─────────►  ─────► │ pip -r every             │
   │                 │   dist_app         │   requirements.txt       │
   │ source tree     │   .zip             │ python -m venv .venv     │
   │  + .venv        │                    │ install nvm + Node       │
   └─────────────────┘                    │ install uuid-runtime     │
                                          │ install toolchain        │
                                          │   (apt + pipx + pip)     │
                                          │ set up Glasgow           │
                                          │   (group, repo, udev,    │
                                          │    pipx install)         │
                                          │ export GLASGOW_CONFIG    │
                                          │ launch glasgow service   │
                                          │ launch ionbeam-web       │
                                          │   backend & frontend     │
                                          └──────────────────────────┘
```

Stage 1 — `Development/buidCompiledDist.py` — runs from the Operations root on
the developer host and produces the application and versioned handoff archives.

Stage 2 — `python3 distributionDeployApp.py` — drives the rest of the
workflow on the deploy host. Building is a separate source-host step; the
target workflow consumes the bundled `dist_app*.zip` and never rebuilds it.

The Python dependency step installs both `Development/requirements.txt` and
`Development/glasgow_service/requirements.txt` into the deployment virtual
environment. It then imports `httpx` and `redis` using that exact interpreter;
deployment fails before service launch if either HA runtime client is missing.
The archive builder also validates both packages are declared in the Glasgow
requirements file and package metadata, preventing an incomplete distribution
from being produced.

### Redis/Sentinel prerequisite

The local workflow runs `glasgow_service/deploy/setup-redis-sentinel.sh` before
starting services. It creates a single-host development topology. To run it
again manually:

```bash
cd ~/IobeamPlatform/Development/glasgow_service
bash deploy/setup-redis-sentinel.sh
```

This creates one local Redis master and one Sentinel with quorum `1`. It is
appropriate only for software verification. Production requires a replicated
Redis primary/replica topology and at least three Sentinel processes on
independent nodes. Set `VACUUM_REDIS_SENTINELS` to the Sentinel addresses and
use `GLASGOW_REQUIRE_FENCING=true` only after that topology is available.

Verify the deployment before starting the executor:

```bash
redis-cli -p 26379 ping
redis-cli -p 26379 SENTINEL get-master-addr-by-name vacuum-primary
curl -i http://127.0.0.1:8780/health/live
curl -i http://127.0.0.1:8780/health/ready
```

Copy `glasgow_service/examples/vacuum-executor.env.example` to
`/etc/vacuum-executor.env`, assign a unique `VACUUM_EXECUTOR_ID`, then install
`glasgow_service/deploy/vacuum-executor.service` into
`/etc/systemd/system/` before enabling the service.

---

## Project layout

```
DistributionDeploy/
├── distributionDeployApp.py             # Entry point
├── buidCompiledDist.py                  # Refactored builder (zip output)
├── README.md
├── Json/
│   └── DistributionDeploy.json          # Workflow definition
├── workthreads/
│   ├── __init__.py
│   └── DistributionDeployThread.py      # Action loop / queue / StateFactory
└── workstates/
    ├── __init__.py
    ├── distributionDeploy_state.py      # Abstract base
    ├── executeShellCommand_state.py     # Generic template runner
    │
    │   # Template-driven states (commandFormat does all the work):
    ├── buildDistribution_state.py
    ├── unzipDistribution_state.py
    ├── setupVirtualEnv_state.py
    ├── installUuidRuntime_state.py
    ├── launchGlasgowService_state.py
    ├── verifyGlasgowService_state.py
    ├── launchIonbeamWebBackend_state.py
    ├── launchIonbeamWebFrontend_state.py
    │
    │   # Custom-DoWork states (need branching or iteration):
    ├── installPipRequirements_state.py
    ├── installNodeJS_state.py
    ├── installToolchain_state.py
    ├── installPostgreSQL_state.py
    ├── setupGlasgow_state.py
    ├── setupIobeamAdminDb_state.py
    └── exportEnv_state.py
```

---

## How the workflow runs

`DistributionDeployThread.IntialWork()` walks `config.Actions` in order. For
each action node:

1. If `skip == true`, log it and move on.
2. If `transactionComplete == true`, log it and move on (lets you re-run
   the workflow and resume from where you left off).
3. Otherwise, instantiate the matching state class via
   `util.CreateInstance("{key}_state", thread)` and put it on the queue.

`StateFactory()` then dequeues states one at a time, runs `Execute()` (which
calls `DoWork()` async or sync), and on success marks the action's
`transactionComplete = true` in the in-memory config before pulling the
next state. On failure, the workflow halts.

### Two flavors of state

**Template-driven** states are one-line subclasses of
`executeShellCommand_state`. They drive entirely off the action's
`commandFormat` template plus its remaining `actionData` keys (positional
values), and require no Python changes when the command needs tweaking —
edit the JSON and you're done.

**Custom-DoWork** states override `DoWork()` because the step needs
branching (e.g. only clone the Glasgow repo if it doesn't exist), iteration
(e.g. apt-install N packages, pip-install N more), or multi-stage shell
sequences that share state across stages (nvm install).

---

## Running it

### Build only:

```bash
cd /path/to/Operations
python3 Development/buidCompiledDist.py
python3 Development/buidCompiledDist.py --raw
```

#### Compile modes

The default produces bytecode; `--raw` produces source for internal diagnosis.
Keep build and target Python major/minor versions aligned.

#### What's kept as `.py`

Files matching `DEFAULT_KEEP_PY` (or `--keep-py PATTERN`) are copied
verbatim instead of compiled, so they remain directly invokable with
`python3 <file>`:

* `buidCompiledDist.py` (this script — needed if the deploy host re-builds)
* `*App.py` (project entry-point convention: `loadFPGAImageApp.py`,
  `distributionDeployApp.py`)
* `setup.py`, `__main__.py`

Empty `__init__.py` files (whitespace / comments only) are also copied
as-is — they have no IP to protect.

### Full deploy:

```bash
python3 distributionDeployApp.py
python3 distributionDeployApp.py -j ./Json/DistributionDeploy.json
python3 distributionDeployApp.py -r ~/IobeamPlatform      # override deploy root
```

The `-r` flag overrides `Deployment.DeployRoot` in the loaded config; every
state reads the deploy root through the parent thread, so changing it once
re-targets the whole workflow.

The default deploy root is user-owned (`~/IobeamPlatform`) rather than `/opt`.
This matches the known-good manual workflow where Glasgow, the Node backend,
and the Vite frontend all run as the login user with the same shell-owned
Node/Python environment. Use `/opt/IobeamPlatform` only after the user-owned
deployment is stable and the service environment has been made explicit.

### Production overrides

`Deployment.IsProduction` is the workflow-wide switch. When it is `false`,
the deploy path stays on the localhost defaults.

Production mode does not invoke the local five-service manager or install the
single-host Redis topology. The target's externally managed production
services must already be installed; the workflow applies production endpoint
overrides and verifies those endpoints.

The remote VM layout and nginx setup live in:

* [ionbeam-web/deploy/remote-vm.md](/home/vboxuser/Project/IobeamTech/Development/ionbeam-web/deploy/remote-vm.md)
* [ionbeam-web/deploy/ionbeam-web.service](/home/vboxuser/Project/IobeamTech/Development/ionbeam-web/deploy/ionbeam-web.service)
* [ionbeam-web/deploy/nginx/ionbeamtech.com.conf](/home/vboxuser/Project/IobeamTech/Development/ionbeam-web/deploy/nginx/ionbeamtech.com.conf)

Per-action `ProductionConfig` blocks are merged into `actionData` only when
production mode is enabled. Use them for values that differ on the edge host:

* database host, port, user, or SSL mode
* backend proxy targets
* Vite proxy targets for the frontend dev server
* frontend readiness URLs
* browser launch URLs

Empty override values are ignored, so the same JSON can carry placeholders
without breaking the localhost path.

### Localhost compatibility

The workflow still defaults to local development addresses:

* Glasgow service defaults to `127.0.0.1:8765`
* Node backend defaults to `127.0.0.1:4000`
* Vite frontend defaults to `127.0.0.1:5173`
* Admin database defaults to `localhost:5432`

That means the existing single-machine deployment path still works without
editing the JSON. Production mode is a configuration override, not a different
code path.

### Production readiness TODO

The current workflow is functional, but these pieces still need to be treated
as production-hardening work:

* Move secrets out of plain JSON and shell env files into a proper secret
  source for production deploys.
* Add a dedicated remote-DB bootstrap path, including schema migration and
  versioned upgrade handling for non-local PostgreSQL instances.
* Wire a real production web host for the Node backend and Vite build instead
  of relying on `npm run dev` for the deploy workflow.
* Put TLS and reverse-proxy termination in front of the web entrypoints.
* Add startup validation that fails fast when a required production endpoint
  or secret is missing instead of falling back silently to localhost.
* Add an automated smoke test that covers both localhost and remote-DB
  deployment profiles.

---

## Adding a new action

1. **Add an entry to `Json/DistributionDeploy.json`** under `Actions`:

   ```json
   {
       "myNewStep": {
           "skip": false,
           "transactionComplete": false,
           "actionData": {
               "commandFormat": "echo hello {}",
               "name": "world"
           },
           "timeout": 5.0
       }
   }
   ```

2. **Create `workstates/myNewStep_state.py`**. If the JSON template covers
   it, this is a one-liner:

   ```python
   from .executeShellCommand_state import executeShellCommand_state

   class myNewStep_state(executeShellCommand_state):
       def __init__(self, parent):
           super(myNewStep_state, self).__init__(parent)
   ```

   If you need branching or iteration, subclass `distributionDeploy_state`
   and override `async def DoWork(self)` directly. Use
   `self.ParentWorkThread.GetStateConfig(self)` to get your action's JSON
   node and `await self.commandAsyncio(cmd, runDir)` to run shell.

That's it — the thread will pick the new state up automatically the next
time `IntialWork` runs, because it's keyed off the JSON, not a hard-coded
list.

---

## Notes on Ubuntu 24.04 specifics

* **PEP 668**: Ubuntu 24.04's system Python rejects naked `pip install` by
  default. The `installPipRequirements_state` and
  `installToolchain_state` both pass `--break-system-packages` when not
  using a venv; both also support pointing pip at a venv activate script
  via `useVenv` / `venvActivate`.
* **`uuid-runtime`** is installed both as a standalone action
  (`installUuidRuntime`) and as part of `installToolchain.aptPackages`. The
  former is kept for parity with the spec; the latter is the practical
  fallback. Either one is idempotent against apt.
* **PostgreSQL** is installed by `installPostgreSQL` and the `IobeamAdmin`
  schema is bootstrapped by `setupIobeamAdminDb`. The SQL scripts live under
  `Development/IobeamAdmin/Sql/` and create the `user`, `session`, and
  `activity` tables plus their stored procedures.
* For interactive DB administration, use `pgAdmin 4` if you want a
  PostgreSQL-native SSMS-style tool, or `DBeaver` for a general-purpose
  database IDE.
* **`sudo`**: actions that need root (apt install, cp into
  `/etc/udev/rules.d`, `udevadm control --reload`) call `sudo` directly
  inside the JSON command templates. Run the workflow from a user that
  has passwordless sudo, or run the steps interactively the first time.
* **Background services**: `launchGlasgowService`, `launchIonbeamWebBackend`,
  and `launchIonbeamWebFrontend` use `nohup ... &` so their processes
  outlive the state. Each writes a PID to `/tmp/<service>.pid` so you can
  stop them with `kill $(cat /tmp/glasgow.pid)`.

# Clean distribution installation

The default workflow now runs in this order:

1. Validate the incoming archive and invoke its
   `./Development/Scripts/manage-local-system.sh stop` with `OPERATIONS_ROOT`
   pointing to the installation. This stops the local stack before removing
   files, including when upgrading from an older service-manager script.
2. Remove the entire `Deployment.DeployRoot` directory (`~/IobeamPlatform`
   by default), then recreate it. Nothing inside it is retained, including
   virtual environments, logs, settings, and old `.pyc` files. The installer
   and incoming archive must reside outside this directory.
3. Extract the selected archive once. Set up the virtual environment, GPIO
   runtime, Python dependencies, FPGA toolchain, and Glasgow USB access.
4. Run the extracted `Development/Scripts/program-fpga-ram.py` using the new
   virtual environment. It builds the configured scan design using the
   connected device revision and forces a download to FPGA RAM, even if the
   image ID already matches. It verifies the device-reported ID, readiness,
   and closed scan run gate. It writes `fpga-ram-verification.json` in the
   installation root and logs `FPGA RAM VERIFIED` on success.
5. Continue Node, database, web, Redis, service restart, and health checks.

Any failed stop, deletion, download, or verification aborts the workflow.
Clean installs reject skipped or previously completed mandatory gates;
reset transaction completion flags before a new run. Missing FPGA hardware
is an installation failure, including in the local deployment mode.

RAM programming does not write persistent FPGA flash or start a scan. ADC
TEST and normal scans use different images; their runtime launchers load
their respective designs when requested. The installation receipt verifies
the scan image at installation time, not ADC signal quality or RAM contents
after a subsequent power cycle or applet switch.

Validation:

```sh
python3 -m unittest discover -s Development/DeployWorkSpace/Development/DistributionDeploy/tests -v
bash -n Development/Scripts/manage-local-system.sh
```
