# DistributionDeploy

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

Stage 1 — `buidCompiledDist.py` — runs on the developer host and produces
`dist_app.zip` (compiled `.pyc` files + JSON configs + assets + `.venv`).

Stage 2 — `python3 distributionDeployApp.py` — drives the rest of the
workflow on the deploy host. The first action of the workflow re-invokes
`buidCompiledDist.py` so the same JSON-driven workflow can be used end to
end (or you can mark `buildDistribution.skip = true` if you ship the zip
out of band).

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
    ├── setupGlasgow_state.py
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
python3 buidCompiledDist.py                      # default: Cython -> .so, dist_app/ + dist_app.zip
python3 buidCompiledDist.py --use-pyc            # legacy: bytecode .pyc instead
python3 buidCompiledDist.py --no-zip             # folder only
python3 buidCompiledDist.py --no-venv            # skip copying .venv
python3 buidCompiledDist.py --verbose            # log every file as it compiles
python3 buidCompiledDist.py --keep-py 'tests/*'  # extra patterns to leave as .py
python3 buidCompiledDist.py --source . \
                            --dist  ./dist_app \
                            --output ./dist_app.zip
```

#### Compile modes

* **`--use-cython` (default)** runs each `.py` through `cython -3` to produce
  C, then compiles that C with `cc` to a native `.so`. Result: ELF shared
  objects whose source is **not** recoverable. Bytecode decompilers like
  `decompyle3` / `uncompyle6` don't apply (wrong file format), and
  `inspect.getsource` returns "source not available".
  Build-host needs: `cython` (`pip install Cython`), a C compiler
  (`apt install build-essential`), and Python headers
  (`apt install python3-dev`).
  **Deploy-host constraint**: the target's Python major.minor must match
  the build host's. A `.cpython-312-x86_64-linux-gnu.so` will only load
  under Python 3.12 on x86_64 Linux.

* **`--use-pyc`** is the legacy bytecode mode kept as a fast iteration
  fallback. Trivially decompiled, so don't ship it externally.

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
python3 distributionDeployApp.py -r /opt/IobeamTech    # override deploy root
```

The `-r` flag overrides `Deployment.DeployRoot` in the loaded config; every
state reads the deploy root through the parent thread, so changing it once
re-targets the whole workflow.

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
* **`sudo`**: actions that need root (apt install, cp into
  `/etc/udev/rules.d`, `udevadm control --reload`) call `sudo` directly
  inside the JSON command templates. Run the workflow from a user that
  has passwordless sudo, or run the steps interactively the first time.
* **Background services**: `launchGlasgowService`, `launchIonbeamWebBackend`,
  and `launchIonbeamWebFrontend` use `nohup ... &` so their processes
  outlive the state. Each writes a PID to `/tmp/<service>.pid` so you can
  stop them with `kill $(cat /tmp/glasgow.pid)`.
