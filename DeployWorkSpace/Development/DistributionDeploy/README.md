
# DistributionDeploy

Windows 11 deployment workflow for the IobeamTech application stack.

For the supported localhost procedure, follow
[`DEPLOYMENT_RUNBOOK.md`](DEPLOYMENT_RUNBOOK.md). It covers build, deployment,
verification, and administration using PowerShell.

The deployment config in `Json/DistributionDeploy.json` builds `dist_app.zip` from:

`C:\Project\IobeamTech\Development`

and deploys it to:

`C:\Project\Iobeam\Deploy`

## Workflow

1. Build `dist_app.zip` with `buidCompiledDist.py`.
2. Expand the archive into `C:\Project\Iobeam\Deploy`.
3. Create `C:\Project\Iobeam\Deploy\.venv`.
4. Install Python requirements into the venv.
5. Verify or install Node.js LTS with Windows tooling.
6. Install and verify Python-based FPGA dependencies:
   - `fx2`
   - `libusb1`
   - `pyusb`
   - `amaranth`
   - `yowasp-yosys`
   - `yowasp-nextpnr-ice40`
7. Verify or install PostgreSQL and initialize the `iobeam_admin` database from `IobeamAdmin\Sql`.
8. Set `GLASGOW_TOOLCHAIN=builtin` so Yosys, nextpnr-ice40, and icepack resolve through YosysHQ WASM Python packages on Windows.
9. Verify Docker Desktop and create the local Redis/Sentinel development topology.
10. Launch the Glasgow, vacuum, backend, and frontend processes with the
    PowerShell local-system manager.

## Run

From this folder:

```powershell
python .\distributionDeployApp.py -j .\Json\DistributionDeploy.json
```

If your machine uses the Windows Python launcher:

```powershell
py -3 .\distributionDeployApp.py -j .\Json\DistributionDeploy.json
```

## Local Redis/Sentinel

The Windows workflow uses Docker Desktop and
`glasgow_service\deploy\setup-redis-sentinel.ps1`. Run it manually with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `..\..\..\glasgow_service\deploy\setup-redis-sentinel.ps1`
```

The complete local stack is controlled with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `..\..\..\Scripts\manage-local-system.ps1 restart`
powershell -NoProfile -ExecutionPolicy Bypass -File `..\..\..\Scripts\manage-local-system.ps1 status`
```

## Important Windows Notes

Python must be available as either `python` or `py -3`.

Node.js LTS should be available on PATH. If it is missing and `winget` is available, the deploy state can install `OpenJS.NodeJS.LTS`.

PostgreSQL should be available on PATH, or installed under `C:\Program Files\PostgreSQL\<version>\bin`. If it is missing and `winget` is available, the deploy state attempts to install `PostgreSQL.PostgreSQL`. Set `IOBEAM_ADMIN_DB_PASSWORD` before running the workflow when the local `postgres` account requires a password.

For Glasgow USB access on Windows, install or associate a WinUSB/libusb-compatible driver for the Glasgow device. The deploy workflow verifies Python USB packages, but Windows driver binding is still a machine-level setup step.

Logs and PID files are written under:

`C:\Project\Iobeam\Deploy\Logs`

The Glasgow service config is:

`C:\Project\Iobeam\Deploy\GlasgowDataIO\Json\streamData.json`

The Iobeam admin config is:

`C:\Project\Iobeam\Deploy\IobeamAdmin\Json\IobeamAdmin.json`

## Toolchain

This Windows deployment intentionally uses Python-provided FPGA tools instead of system package-manager or USB-rule setup steps. The FPGA build path uses the bundled Python packages listed above. The Glasgow build code prefers Windows build scripts (`.bat` or `.cmd`) when Amaranth provides them.
