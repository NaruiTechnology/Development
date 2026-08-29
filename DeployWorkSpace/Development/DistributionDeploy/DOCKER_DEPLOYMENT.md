# One-package Ubuntu and Windows Docker deployment

## Goal and package layout

The Ubuntu build produces one archive:

```text
DeployWorkspace_Docker_<version>_<timestamp>.zip
```

Copy that same ZIP to either an Ubuntu VM or a Windows VM. Do not create a
separate Windows build. After extraction, the package exposes native launchers:

```text
DeployWorkSpace/
├── install-docker-distribution.sh    # Ubuntu
├── install-docker-distribution.cmd   # Windows Command Prompt / double-click
├── install-docker-distribution.ps1   # Windows PowerShell
└── Development/DistributionDeploy/  # shared workflow and payload
```

All launchers converge on `distributionDeployApp-docker.py`. It prepares the
host Docker runtime, builds the same packaged Linux Glasgow image, and starts
the `glasgowService` container on port 8765.

## Build the single ZIP on Ubuntu

### Prerequisites

- Ubuntu with the Operations repository checked out.
- Python 3.10 or newer.
- The repository virtual environment at `Operations/.venv`.
- Current Glasgow sources and `streamData.json` in the repository.

Docker is not required just to assemble the ZIP. The target VM builds the image
from the source and Dockerfile carried inside the package.

### Steps

1. Enter the Operations repository:

   ```bash
   cd ~/Project/Operations
   ```

2. Build the raw cross-OS package:

   ```bash
   .venv/bin/python Development/buidCompiledDist-docker.py --raw
   ```

3. Note the final path printed by the builder, for example:

   ```text
   /path/to/Operations/DeployWorkspace_Docker_v0.8_082726_2302.zip
   ```

4. Optionally inspect it:

   ```bash
   unzip -l DeployWorkspace_Docker_*.zip | less
   ```

   Confirm it contains the three root launchers, `dist_app_docker_raw.zip`,
   `DistributionDeploy-docker.json`, Docker workstates, and
   `Dockerfile.glasgow-service`.

5. Copy this one ZIP, unchanged, to each target VM.

## Install on an Ubuntu VM

### Prerequisites

- Internet access for first-time Docker installation and image dependencies.
- Python 3.10 or newer.
- `sudo` access for first-time Docker Engine installation.
- Port 8765 available.

### Steps

1. Extract and enter the package:

   ```bash
   unzip DeployWorkspace_Docker_<version>_<timestamp>.zip
   cd DeployWorkSpace
   ```

2. Run the root installer:

   ```bash
   ./install-docker-distribution.sh
   ```

3. On the first run, the workflow:

   1. prepares `~/IobeamPlatform`;
   2. extracts the shared payload;
   3. detects Linux;
   4. installs and starts Docker Engine if `docker info` is unavailable;
   5. builds `glasgow-service:local`;
   6. starts the `glasgowService` container; and
   7. waits for `http://127.0.0.1:8765/status`.

4. Verify it:

   ```bash
   docker ps --filter name=glasgowService
   curl http://127.0.0.1:8765/status
   ```

On later runs, the Docker installation state is not instantiated when the
engine is ready. The image is rebuilt and the container is replaced with the
package being installed.

## Install on a Windows VM

### Prerequisites

- Windows 10 or Windows 11 with virtualization enabled.
- Administrator permission for first-time Docker Desktop/WSL 2 installation.
- `winget` (normally provided by Microsoft App Installer).
- Internet access for Docker Desktop, Python, and image dependencies.
- Port 8765 available.

Git Bash is not required when using the root `.cmd` or `.ps1` launcher.

### Steps

1. Copy the same Ubuntu-built ZIP to Windows.

2. In File Explorer, select **Extract All**. Open the extracted
   `DeployWorkSpace` folder.

3. Start installation using either method:

   - Double-click `install-docker-distribution.cmd`; or
   - Open PowerShell in the folder and run:

     ```powershell
     .\install-docker-distribution.ps1
     ```

4. Approve elevation prompts. The bootstrap installs Python 3.12 through
   `winget` if Python is absent. The workflow installs and starts Docker Desktop
   when `docker info` is unavailable.

5. First-time Docker Desktop/WSL 2 setup may require a restart or sign-out. If
   requested:

   1. restart Windows;
   2. start Docker Desktop and wait for the engine to report ready;
   3. rerun `install-docker-distribution.cmd`.

   Ready prerequisites are detected before installation workstates are created.

6. The shared workflow extracts to `%USERPROFILE%\IobeamPlatform`, builds the
   packaged Linux image, publishes port 8765 to Windows, and waits for readiness.

7. Verify from PowerShell:

   ```powershell
   docker ps --filter "name=glasgowService"
   Invoke-RestMethod http://127.0.0.1:8765/status
   ```

## Container lifecycle commands

Ubuntu:

```bash
python3 ~/IobeamPlatform/Development/Scripts/manage-local-system-docker.py status
python3 ~/IobeamPlatform/Development/Scripts/manage-local-system-docker.py logs
python3 ~/IobeamPlatform/Development/Scripts/manage-local-system-docker.py restart
python3 ~/IobeamPlatform/Development/Scripts/manage-local-system-docker.py stop
```

Windows PowerShell:

```powershell
python "$HOME\IobeamPlatform\Development\Scripts\manage-local-system-docker.py" status
python "$HOME\IobeamPlatform\Development\Scripts\manage-local-system-docker.py" logs
python "$HOME\IobeamPlatform\Development\Scripts\manage-local-system-docker.py" restart
python "$HOME\IobeamPlatform\Development\Scripts\manage-local-system-docker.py" stop
```

## Glasgow USB hardware on Windows

The HTTP API can run without USB passthrough, but physical Glasgow hardware must
be visible inside Linux. Install `usbipd-win`, attach the device to WSL 2, and
confirm it appears there before starting the container. `--privileged` cannot
expose an unattached Windows USB device.

Run in administrator PowerShell:

```powershell
winget install --exact --id dorssel.usbipd-win
usbipd list
usbipd bind --busid <BUSID>
usbipd attach --wsl --busid <BUSID>
```

Then verify from WSL:

```bash
lsusb
```

USB attachment can be lost after unplugging the device or restarting Windows;
reattach it before restarting `glasgowService`.

## Troubleshooting

- Ubuntu `docker info` failure: run `sudo systemctl enable --now docker`, then
  rerun the root installer.
- Windows `docker info` failure: start Docker Desktop, wait for its engine, and
  rerun the root launcher.
- Port 8765 occupied: stop the conflicting application or container.
- Image download/build failure: verify target internet and proxy settings, then
  rerun; Docker reuses completed layers.
- Service readiness failure: inspect `docker logs glasgowService`.
- Windows Glasgow hardware absent: repeat `usbipd attach --wsl` and verify with
  `lsusb`.
