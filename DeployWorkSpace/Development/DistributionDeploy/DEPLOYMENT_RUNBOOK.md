# Windows Deployment Runbook

This is the supported local deployment procedure for the `POC-win` branch.

## Prerequisites

Install these Windows tools and make them available on `PATH`:

- Python 3
- Git for Windows
- Node.js LTS and npm
- PostgreSQL
- Docker Desktop

Associate the Glasgow USB device with a WinUSB/libusb-compatible driver before
using physical hardware.

## Build the distribution

Open PowerShell in `C:\Project\IobeamTech\Development`:

```powershell
py -3 .\buidCompiledDist.py `
  --source C:\Project\IobeamTech\Development `
  --dist C:\Project\IobeamTech\Development\DeployWorkSpace\Development\DistributionDeploy\dist_app `
  --output C:\Project\IobeamTech\Development\DeployWorkSpace\Development\DistributionDeploy\dist_app.zip
```

The builder validates the Python runtime dependencies, the PowerShell
Redis/Sentinel setup, and the packaged Windows local-system manager.

## Run deployment

```powershell
Set-Location C:\Project\IobeamTech\Development\DeployWorkSpace\Development\DistributionDeploy
py -3 .\distributionDeployApp.py -j .\Json\DistributionDeploy.json
```

Use `-r C:\Project\Iobeam\Deploy` to override the deployment root.
Use `--production` only when externally managed production services and
endpoints are already available.

The local workflow:

1. Recreates only a guarded deployment root named `Deploy` or
   `IobeamPlatform`.
2. Expands `dist_app.zip`.
3. Creates `.venv\Scripts\python.exe`.
4. Installs Python, Node.js, PostgreSQL, and Glasgow toolchain dependencies.
5. Creates local Redis and Sentinel containers through Docker Desktop.
6. Initializes the admin database.
7. Starts the SBC vacuum, Glasgow, vacuum executor, backend, and frontend
   processes with the PowerShell manager.

## Operate the local stack

```powershell
$manager = "C:\Project\Iobeam\Deploy\Development\Scripts\manage-local-system.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $manager restart
powershell -NoProfile -ExecutionPolicy Bypass -File $manager status
powershell -NoProfile -ExecutionPolicy Bypass -File $manager logs
powershell -NoProfile -ExecutionPolicy Bypass -File $manager stop
powershell -NoProfile -ExecutionPolicy Bypass -File $manager start
```

The manager records only processes it starts and uses `taskkill.exe /T` on
those stored PIDs. It does not terminate unrelated processes by name.

## Verify

Check these endpoints:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8766/health/ready
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/status
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8780/health/live
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4000/api/status
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5173/
```

Redis and Sentinel can be checked with:

```powershell
docker exec iobeam-redis redis-cli ping
docker exec iobeam-sentinel redis-cli -p 26379 ping
```

Local logs are written under `C:\Project\Iobeam\Deploy\Logs`; PID files
are under `C:\Project\Iobeam\Deploy\Runtime`.
