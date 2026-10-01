# Ion Beam native desktop app — runbook

Operator and maintainer procedures for `Development/ionbeam-native`. For the design and the measurements behind it, see `DESIGN.md`.

---

## 1. What runs where

| Component | Needed by the native app? | Notes |
|---|---|---|
| **ionbeam-native** (this app) | — | Talks to the Glasgow over USB **in-process**; keeps the session open between scans |
| Node backend (`ionbeam-web/backend`, port 4000) | **Yes** | Sign-in, equipment, vacuum/HV, sample stage, calibration storage, recording, reports, FTP |
| `glasgow-svc` (web stack's device service) | No | May keep running. The two share a device lock (§5), so only one of them uses the Glasgow at a time |
| Web frontend | No | Still needed for the ⚙ CONFIGURATION dialog, which the native app does not include |

---

## 2. Prerequisites

**Linux (instrument PC)**
- Python ≥ 3.10 with `venv` (`sudo apt install python3-venv`)
- Qt runtime libraries (the installer tells you if any are missing):
  `sudo apt install libxcb-cursor0 libxkbcommon-x11-0 libxcb-icccm4 libxcb-keysyms1 libxcb-shape0 libegl1`
- USB access to the Glasgow without root: install once with `--udev` (§3), then replug the board
- Node backend running (`Scripts/manage-local-system.sh status`)

**Windows**
- Python ≥ 3.10 (`winget install Python.Python.3.12`)
- Glasgow bound to **WinUSB** once per PC with Zadig (hardware scans only; the emulator needs nothing)
- Node backend reachable (local or `--api-url`)

---

## 3. Install

### With the Operations deployment (instrument PC, recommended)
The normal Operations build and deploy install the native client with the rest of the platform. There is nothing extra to run:
1. The source host runs `python3 Development/buildCompiledDist.py`. `dist_app.zip` now contains `Development/ionbeam-native` (compiled, with its icons, translations and docs).
2. The target host runs `distributionDeployApp.py` as usual (see `DeployWorkSpace/.../DistributionDeploy/DEPLOYMENT_RUNBOOK.md`):
   - `installPipRequirements` installs `ionbeam-native/requirements.txt` into `~/IobeamPlatform/.venv`.
   - `installIonbeamNative` installs the Qt libraries, the `ionbeam-native` launcher and the menu entry for the deploying user, then runs the emulator smoke test.

   Production (remote) hosts skip the native install. To turn off the menu entry or the smoke test, set `desktopEntry` or `runSmokeTest` to `false` in that action's `actionData`.
3. Glasgow USB access comes from the workflow's existing `setupGlasgow` udev rule, so `--udev` is not needed.

Use the manual procedures below for a developer checkout, a Windows PC, or a machine outside the Operations deployment.

### From the Development checkout (Linux)
```bash
cd <Operations>/Development
ionbeam-native/scripts/install_linux.sh --udev
# share the Operations venv with glasgow_service instead of a private one:
ionbeam-native/scripts/install_linux.sh --venv <Operations>/.venv --udev
```
The script creates or updates the venv, installs the pinned requirements and the app (editable), verifies the imports, writes `~/.local/bin/ionbeam-native` and an applications-menu entry, and runs a smoke test against the built-in emulator. It is safe to re-run.

Options: `--skip-pip` (requirements already in the venv), `--dev` (adds pytest/pyflakes), `--no-desktop-entry`, `--no-launcher`, `--skip-smoke`, `--python BIN`, `--uninstall`.

### From a release bundle
```bash
tar xzf ionbeam-native-<version>-<sha>.tar.gz
cd ionbeam-native-<version>-<sha>
Development/ionbeam-native/scripts/install_linux.sh --udev
```
Check the download first: `sha256sum -c SHA256SUMS`.

### Windows
```powershell
powershell -ExecutionPolicy Bypass -File Development\ionbeam-native\scripts\install_windows.ps1
# options: -Venv C:\Operations\.venv  -Dev  -NoShortcut  -SkipSmoke  -Uninstall
```
This creates `%LOCALAPPDATA%\IonBeamNative\ionbeam-native.cmd` and a Start-menu shortcut **Ion Beam (native)**, and sets the user variables `IONBEAM_DEVELOPMENT_ROOT` and `GLASGOW_CONFIG`.

### Make targets (Linux, maintainers)
`make install | install-dev | test | lint | smoke | bench | build | run | run-emulator | parity | clean` (run inside `ionbeam-native/`).

---

## 4. Configure

The app reads the **same** `streamData.json` as the web service. Scan-related configuration (IsProduction, DumpData, FTP, beam and ADC settings) is still edited in the web app's ⚙ CONFIGURATION dialog or directly in the file. Restart the native app after changing it.

| Setting | Default | Purpose |
|---|---|---|
| `GLASGOW_CONFIG` / `--config` | discovered like glasgow_service (env → systemd unit → `GlasgowDataIO/Json/streamData.json`) | Stream config |
| `IONBEAM_API_URL` / `--api-url` | `http://127.0.0.1:4000` | Node backend |
| `IONBEAM_DEVELOPMENT_ROOT` | parent of `ionbeam-native/` | Where `GlasgowDataIO`, `glasgow_service`, `AutomationPy` live |
| `IONBEAM_DEVICE_LOCK` | `<temp>/ionbeam-glasgow-device.lock` | Device lock file; must be **the same** for the native app and glasgow-svc (default is shared) |
| `IONBEAM_LOG_LEVEL` / `--log-level` | `INFO` | `DEBUG` also shows the per-chunk transfer lines |
| `--log-dir` | `~/.ionbeam-native/logs` | App log and the service loggers' `*.log` files |
| `--force-reload` | off | Re-download the bitstream on the first connect even if the FPGA already runs it |
| `--emulator` | off | Byte-level Glasgow emulator instead of USB (demo/training; forces the hardware code path) |

**Key `streamData.json` fields:** `IsProduction` (true = real hardware; false = the service's simulation mode), `DumpData` (write CSV+PNG per scan to `~/Output`; the native app renders these in a background process), and `Actions[0].streamData.actionData.ftp` (when enabled and complete, recorded scans upload CSV+PNG through the backend).

**Per-user preferences** (theme, language, signed-in user, selected equipment, dimension calibration, panel width) are stored with Qt settings: Linux `~/.config/IonBeamTech/ionbeam-native.conf`, Windows registry `HKCU\Software\IonBeamTech\ionbeam-native`. They use the same key names as the browser's localStorage, but they are separate from it.

---

## 5. Daily operation

1. Start the backend stack if it is not running: `Scripts/manage-local-system.sh start`.
2. Start **Ion Beam (native)** from the menu, or run `ionbeam-native`. The app opens the Glasgow immediately, so the first scan has no connect delay. The log shows either `desktop launcher: programmed bitstream …` (first start after power-on) or `reusing running bitstream …`.
3. Sign in (the dialog opens automatically when signed out). Scanning requires a registered, active account with role ≥ 1, exactly as on the web.
4. Scan as on the web: Scan → ROI/Raster/Vector, Calibrate, ADC test, Dashboard (management report), vacuum and stage dashboards.

### Sharing the Glasgow with the web app
Only one process may use the Glasgow at a time. While the native app is open it **holds the device**.
- To scan from the web UI, open the device menu (the ▾ next to the link icon in the header) and choose **Release Glasgow**, or close the native app. The next native scan re-opens the device automatically, which takes one connect of a few seconds.
- If the web stack is scanning, a native scan fails with *"Glasgow device is held by … (pid N)"*, and the same happens the other way round. Wait for the other scan to finish, or release the device there.

### Hardware-free demo / training
`ionbeam-native --emulator` runs every feature against the built-in emulator. The backend is still needed for sign-in. For a fully offline demo, run `python -m ionbeam_native.testing.mock_backend --port 4000` in a second terminal: it pre-authorises an `admin` account.

---

## 6. Measuring performance on the instrument

Every frame logs two lines (default log `~/.ionbeam-native/logs/ionbeam-native.log`):
```
[perf] raster {'resolution': 512, 'dwell': 1, 'latency_bytes': 65536} wall=82.85ms first_sample=80.73ms beam=65.54ms duty=0.791 samples=262144 chunks=1 reconnected=False soft_reset=0.07ms stopped=False
[session] {'connects': 1, 'images_programmed': 0, 'soft_resets': 2, 'hard_closes': 0, 'last_connect_s': 0.0, 'last_reset_ms': 0.07, 'mean_reset_ms': 0.067}
```
- **duty** = beam / wall: the fraction of frame time the beam is scanning. The web pipeline was ~0.01 at 512².
- **reconnected=True** on a frame other than the first one after start or after *Release Glasgow*, or a growing **hard_closes**, means the soft reset fell back to a full re-open. Report it with the log (§8).

Summarise a run:
```bash
grep -o 'wall=[0-9.]*ms.*beam=[0-9.]*ms duty=[0-9.]*' ~/.ionbeam-native/logs/ionbeam-native.log | tail -20
```

**Acceptance checklist on hardware** (see DESIGN §8 for the reasoning):
1. Restart the app with the board powered → `reusing running bitstream`.
2. 20 × raster 512², dwell 1 → `reconnected=False` on every frame, `hard_closes: 0`, median duty ≥ 0.7.
3. Same scan in the web app and the native app with DumpData on → the CSVs agree (shape, orientation, value range).
4. Stop a 2048² scan halfway, then scan 256² → no stripes from the previous scan.
5. ADC test, then raster → the scan image is re-programmed and the image is correct.
6. Release Glasgow → web scan works → native scan works again.

Emulator reference numbers (no hardware): `ionbeam-native/.venv/bin/python ionbeam-native/scripts/benchmark_pipeline.py --frames 5 --resolution 512` (add `--dump`, `--dwell`, `--json`).

---

## 7. Logs and files

| What | Where |
|---|---|
| App log (rotating 5 MB × 3) | `~/.ionbeam-native/logs/ionbeam-native.log` (Windows `%USERPROFILE%\.ionbeam-native\logs`) |
| glasgow_service / launcher logs used in-process | same folder (`GlasgowService.log`, `PatternScan*.log`, …) |
| DumpData CSV/PNG | `~/Output` (same names as glasgow-svc) |
| Downloads from the Run report | the folder chosen in the report (auto-download) or the save dialog |
| Preferences | §4 |

---

## 8. Troubleshooting

| Symptom | Cause / action |
|---|---|
| *"Glasgow device is held by … (pid N)"* | The other stack is using the device. Release it there (web: wait for the scan to end; native: header ▾ → Release Glasgow). A stale lock is impossible, because the OS drops it when the holder exits. |
| `device not found` / `DeviceNotReady` at first scan | Board unplugged or no USB permission. Replug the board. Linux: run the installer with `--udev` and replug. Windows: bind WinUSB with Zadig. |
| Every frame shows `reconnected=True` | The soft reset is failing on this gateware. The app keeps working in the web-style reconnect mode. Collect the log with `--log-level DEBUG` and send it to engineering. |
| Scans work but are slow and the log says `programmed bitstream` every time | Something else (ADC test, another tool) keeps loading a different image, or `--force-reload` is set |
| Status pill shows **Error** after an ADC test in `--emulator` | Expected: the ADC test needs the real ADC image. Use the simulation switch for the demo. |
| Sign-in fails, equipment list empty, report page empty | Backend not reachable. Check `IONBEAM_API_URL` and `Scripts/manage-local-system.sh status`; the app log shows `Connection refused`. |
| Window does not open on Linux: `Could not load the Qt platform plugin "xcb"` | Missing system libraries. Re-run the installer (it lists them) or install the apt packages in §2. |
| FTP artifacts missing for native scans | FTP must be enabled and complete in `streamData.json`, and the scan must be non-preview. The backend must include the native `output-data` artifacts change (part of the same patch). |
| Preferences look reset | The native app does not share browser localStorage; sign in and choose theme/language once |

---

## 9. Upgrade, rollback, uninstall

- **Upgrade:** pull/unpack the new version, then re-run the installer. It is idempotent and keeps preferences.
- **Rollback:** check out or unpack the previous version and re-run the installer. The web UI is unaffected either way.
- **Uninstall:** `install_linux.sh --uninstall` (or `install_windows.ps1 -Uninstall`) removes the launcher and menu entry. Delete `ionbeam-native/.venv` to reclaim the venv. The udev rule is `/etc/udev/rules.d/60-glasgow-ionbeam.rules`.

---

## 10. Build and CI (maintainers)

```bash
cd Development/ionbeam-native
./scripts/install_linux.sh --dev --no-desktop-entry
.venv/bin/python scripts/build.py            # lint → tests → glasgow_service tests → smoke → dist/*.tar.gz, *.zip, SHA256SUMS
.venv/bin/python scripts/build.py --skip-tests
```
- **CI:** `.github/workflows/ionbeam-native.yml` runs on changes to `ionbeam-native/`, `glasgow_service/`, `GlasgowDataIO/`, `AutomationPy/` or the web `frontend/src/lib/`. It checks the web parity fixture, installs with the operator script on Linux and Windows, runs lint/tests/smoke, builds the bundle and records the emulator benchmark. Bundles are downloadable from the run's artifacts.
- **Web parity:** when web logic in `frontend/src/lib/` changes, regenerate the golden cases with `make parity` (Node 18+), port the change, and commit both. CI fails if the fixture no longer matches the web code.
- **Translations:** the locale tables and help topics are extracted from the web frontend (`cd scripts/i18n && npm ci && npm run extract`). Re-run this when the web `i18n/` changes. Strings for native-only controls live in `ionbeam_native/i18n/native_strings.json`.
- **Tests only:** `make test` (native + glasgow_service), `QT_QPA_PLATFORM=offscreen` is set automatically.
