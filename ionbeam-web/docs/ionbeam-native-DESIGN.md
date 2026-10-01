# Ion Beam native desktop app — design and results

**Folder:** `Development/ionbeam-native/` (standalone; the web UI is untouched and keeps working)
**Base:** `NaruiTechnology/Development`, branch `Operations` @ `e7e58e1`
**Scope:** every feature of the web app except the ⚙ CONFIGURATION (Settings) dialog
**Status:** complete and tested against a byte-level Glasgow emulator; **hardware validation on the instrument is still pending** (plan in §8)

---

## 1. Summary

The team's diagnosis was that scans are slow because the web front end talks to the scanner over WebSockets. Measurement says otherwise, which is why removing or tuning the WebSocket path moved performance by only ~0.1%.

The time goes into the acquisition service itself: after **every** transfer, `glasgow_service` closes the Glasgow USB session, so the next frame has to rebuild the FPGA image, re-download the bitstream, and sit through **4.7 s of fixed settle sleeps**. On a 512×512 frame whose beam time is 65 ms, that is ~5.2 s of dead time per frame. The WebSocket hop costs a few milliseconds.

The native app does what upstream OBI does. It opens the device once and keeps it open, programs the FPGA only when the running image differs, and between scans does a *soft reset* (a few register writes) instead of a full re-open. It also moves the per-sample Python work and the CSV/PNG rendering off the acquisition loop, and paints frames from shared numpy buffers.

| Emulator benchmark (median frame time) | web pipeline model | native app | speed-up | native beam duty |
|---|---:|---:|---:|---:|
| raster 512², dwell 1 (beam 65.5 ms) | 5 256.8 ms | **79.7 ms** | **66×** | 82% |
| raster 1024², dwell 3 (beam 524.3 ms) | 5 746.0 ms | **568.9 ms** | **10.1×** | 92% |
| raster 2048², dwell 1, DumpData on (beam 1 048.6 ms) | 7 750.1 ms | **1 250.4 ms** | **6.2×** | 84% |

*Beam duty* is beam time divided by wall time, i.e. how much of each frame the beam is actually scanning. The web model **understates** the web cost, because it charges the measured launcher build and fixed sleeps but not the bitstream download. The instrument itself will set the final numbers (§8).

---

## 2. Root cause (measured on `e7e58e1`)

Per-scan host overhead in the web path, in order of size:

| Cost | Where | Size |
|---|---|---|
| USB hard close after every transfer, full re-launch on the next | `GlasgowConnection._post_transfer_cleanup → _hard_close`; next scan runs `IobeamLauncher` | — |
| Fixed settle sleeps after "programming" | `IobeamLauncher`: 3.0 s + 1.2 s + 0.5 s | **4.7 s / scan** |
| Bitstream always re-downloaded | `download_target(reload=True)` even when the FPGA already runs that image; this is also what triggers the sleeps | USB download time / scan |
| Amaranth elaboration to compute the bitstream ID | `applet.build` + `target.build_plan` | ~0.45 s / scan |
| Per-sample Python ADC presence monitor on the event loop | `_AdcPresenceMonitor.observe` | 82 ms @512², 296 ms @1024², 1 137 ms @2048² |
| DumpData CSV+PNG, synchronous, on the loop (`DumpData: true` ships in `streamData.json`) | service `finally:` | 0.5–1.6 s / scan |
| `print(..., flush=True)` ×3 per chunk | `recv_res`, `GlasgowStream.read` | small, unbounded on slow consoles |
| WebSocket proxy + wire re-encode | backend `wsProxy`, frontend | **0.9–12 ms** ← what the earlier `ionbeam-desktop` attempt optimised |

Beam time comes from the gateware: ADC half-period 3 → 8 MS/s conversions, and one pixel = dwell + 1 conversions. So 512² at dwell 1 takes 65.5 ms and 2048² takes 1.05 s. With ~5.2 s of fixed overhead per scan, the web pipeline cannot exceed ~0.2 frames/s at 512² no matter how fast the transport is.

---

## 3. Architecture

```
┌──────────────────────────── ionbeam-native process ─────────────────────────────┐
│  Qt UI thread (PyQt6)                                                            │
│   MainWindow ─ Header/Footer ─ tabs ─ parameter panels ─ canvases ─ dashboards   │
│        │  AppController (state = web Redux slices; timers; recording; auth)      │
│        │     ▲ UiPoster (queued signal: engine → UI)                             │
│        ▼     │                                                                   │
│  Engine thread (own asyncio loop) ──────────────────────────┐                    │
│   DesktopDeviceService (subclass of glasgow_service.DeviceService)               │
│     └ PersistentGlasgowConnection (USB stays open, soft reset)                   │
│   RasterFrame / VectorFrame / AdcTimeline: preallocated numpy buffers            │
│        │ (UI polls at 30 Hz, paints from the buffers with a LUT; no copies/JSON) │
│        ▼                                                                         │
│  ArtifactWorker (spawned process): CSV / PNG / DumpData / figure rendering       │
└──────────────┬───────────────────────────────────────────────┬──────────────────┘
               │ REST (control plane only)                     │ USB
     Node backend :4000 (auth, equipment, vacuum,              Glasgow (rev C3)
     HV, stage, recording, FTP, reports)                       + OBI-derived gateware
               │
     cross-process device lock (file lock) ◄── glasgow_service (web stack) respects it too
```

**Acquisition is in-process.** The app imports the **same** `GlasgowDataIO` macros and `glasgow_service.DeviceService` scan code as the web stack. It only replaces the connection lifecycle and the places where side work ran on the scan loop. Request validation, pydantic models, scan types, cookies, validation checks and snapshot/CSV formats are all the service's own code. No acquisition logic was forked.

**Persistent session** (`engine/persistent.py`):
- *Connect once.* `PersistentLauncher` calls `download_target(reload=False)`, which compares the running bitstream ID and skips the download and the settle sleeps when it already matches. The sleeps only happen when an image really is loaded, e.g. the first start, or after the ADC-test image replaced the scan image.
- *Soft reset between scans.* `iface.reset()` cancels in-flight bulk transfers, pulses the gateware reset, clears host buffers and re-arms the IN queue. The applet run gate (`addr_reset`) is then re-asserted, and the next transfer re-synchronises with a fresh cookie, so stale samples cannot be mistaken for the new scan. Background sender tasks that the macros never reap are reaped explicitly, which the hard close used to do implicitly.
- *Safety net.* Any exception during the soft reset falls back to the original hard close, so the next scan reconnects exactly as the web service would. A streaming transport error triggers one automatic reconnect and restart, the same policy as the web `useScanStream`.

**Frames:** `engine/frames.py` holds preallocated `uint16` buffers written by the engine thread. The UI polls a monotonic counter at 33 ms and repaints only what changed, using a 65 536-entry LUT for levels. This is the same paint logic as the web canvases (`ui/painters.py`), vectorised. The ADC presence monitor is vectorised with numpy inside `glasgow_service` itself (shared fix, see §5).

**Side work off the scan loop.** CSV/PNG artifacts, DumpData files and validated "server figure" renders run in a separate spawned process (`engine/artifacts.py`), so a 2048² dump never stalls the next frame.

**Control plane unchanged.** Auth, equipment, vacuum/HV, sample stage, dimension/mag calibration persistence, recording (operation input-setup/output-data), reports and FTP all go through the existing Node backend REST API, with the same bodies, headers (`X-Iobeam-Auth`) and gating rules as the browser.

**Device ownership.** The native app and the web stack's `glasgow_service` are two processes that could both open the Glasgow. A shared file lock (`glasgow_service/device_lock.py`: `fcntl.flock` on POSIX, `msvcrt.locking` on Windows, released automatically if the holder dies) guarantees only one of them talks to the USB device. The loser gets a clear message: *"Glasgow device is held by Ion Beam desktop app (pid N). Close the scan in that application (or release the device there) and try again."* The native header's device menu has **Release Glasgow** to hand the device over without quitting.

---

## 4. Feature parity (web → native)

Everything below is implemented natively, with the same i18n tables (en, zh-CN, zh-TW), themes (navy, black, light), help topics and preference keys as the browser app.

| Area | Implemented |
|---|---|
| Shell / header | Brand + version, language picker, theme picker, beam pill, status pill (idle/busy/connecting/error/disconnected, ADC connecting), dashboard ↔ console toggle, reconnect, vacuum and sample-stage buttons (when enabled), HV toggle (vacuum ready), auth chip, production LED, footer |
| Auth | Current-account + user list, user and site select, sudo warning, SMS send/verify, register form, session expiry, persisted user (`session_token` → `X-Iobeam-Auth`), auto-open once when signed out; scan privilege check (registered, active, not expired, role ≥ 1) |
| Panel lock | `scanActive ∥ !signedIn ∥ (vacuumEnabled && !vacuumReady)` |
| Tabs | Scan (ROI / Raster / Vector), Calibrate (Dimension / Mag), ADC test (hidden when `adc_test` is false) |
| Raster panel | Beam energy, mode guide, resolution presets + custom, dwell presets with RevC3 timing labels, latency presets + custom, cookie, output mode, ADC valid, frame blank, validated-run options |
| Vector panel | Pattern default/custom (custom points, 1 M cap), scan path ×4 + glyph, resolution presets + validation, dwell, output mode, ADC valid, latency (≥ 8196 with gray filter), cookie, pre-process, validation; vector gray-level filter (range slider, two-click commit, spot/skip confirm) |
| DAC check | Collapsible card: start/stop, axis, fixed code, dwell, status, waveform |
| Scan controls | Region and equipment selectors, preview switch, Run, Stop, Infinite, Run validated, Clear, Repeat 1–50 with countdown, ROI-action variant (ROI raster wedges / ROI gray vector), inline errors |
| Image canvas | Raster/vector painters (default, native block fill, custom points, spot colours), level wedge (histogram, handles, region drag, auto, keyboard), axis overlay + grid, scan-path overlay, decimated/native render modes, progress bar, meta row, server-figure fallback, annotation editor (highlight/comment/rectangle/circle, colour/style/width, undo/remove/clear), merge + FTP merged-figure upload, vertical-raster line-shift correction |
| Run report | Meta, validation checks, output prefix, folder select, auto-download, CSV/figure download, DB status note, errors |
| Error wedge | Scan/status/service errors, "request scan role" mail link |
| ROI | Load image / last scan, clear image/region, scale unit, origin/end readouts, drag-select, ctrl-corner resize, axes/ticks/grid, gray highlight mask, live vector overlay, level wedge, gray spectrum (step-delta boxes, two-click range, spot/skip confirm), ROI preview side card (zoom 50–2000%), ROI action runs (adaptive gray feedback / custom points / bitmap selection, repeat loop) |
| Dimension calibration | Calibration viewport handles, measure line → correction dialog, fields, HFOV/VFOV, source badge, confirm (local + remote PUT per equipment), restore on start, scan-geometry load |
| Mag calibration | Beam, magnification, measured length/pixels, resolution, HFOV, add point, save, CSV export/import, table, log-log chart |
| ADC test | Duration 5/10/15/20 min, simulation (+seed), settings readout, run/stop, elapsed/remaining/samples, 2048-bin timeline |
| Management report | Account/equipment/group/sort filters, KPIs, scan-mix pie + bars, usage trend, site list, ranking table, recent list, PDF and CSV export, duplicate cleanup |
| Vacuum dashboard | 1 s poll, workflow or grid layout, pump cards (threshold, realtime, pins, power), minimise, device line, cascade footer, auto-open once when enabled |
| Sample stage | 1 s poll, X/Y/Z/T/R targets + Move, axis sliders, stage canvas, kinematic glyph, readouts, minimise |
| Recording | Non-preview raster/vector scans: `operation/input-setup` at frame start → `activity_id`; `operation/output-data` at frame end with `scan_result`, and CSV/PNG artifacts when FTP is configured (the backend uploads the bytes it is given, see §5); UTC `yymmdd_HHMMSS` artifact names identical to the web |

**Excluded by request:** the ⚙ CONFIGURATION dialog (streamData editor, FTP/DB/admin settings, scan-geometry editor, user admin). Configure through the web app, or edit `streamData.json` directly; the native app reads the same file.

**Native-only additions:** *Release Glasgow* in the header's device menu; `--emulator` demo mode (no hardware); per-scan `[perf]` log lines; `--force-reload`.

**Parity evidence:**
- **Golden cases from the web code.** 936 cases generated by running the web frontend's own TypeScript (`displayLevels`, `scanTiming`, `grayScaleSelection`, `vectorScanPath`, `scanRepeat`, `scanSamples`) are replayed against the Python port, and all match. CI regenerates the fixture from the web sources and fails if it drifts, so a web logic change without a native update is caught.
- **UI flow tests.** Scripted runs of the real main window cover raster preview (not recorded), recorded raster (input-setup + output-data), vector on the same session, Infinite + Stop, Run validated, ROI and calibration tabs, ADC simulation, report page, device release and re-open, and theme/locale switching. Every test also fails on any exception raised inside a Qt slot.

---

## 5. Changes outside the new folder (all backward-compatible)

| File | Change | Why |
|---|---|---|
| `glasgow_service/glasgow_service/service.py` | ADC presence monitor vectorised (numpy); claims/releases the shared device lock around USB use | Removes 0.08–1.1 s per scan for **web users too**; prevents the two stacks fighting over USB |
| `glasgow_service/glasgow_service/device_lock.py` (new) | Cross-process device lock | See §3 |
| `glasgow_service/tests/test_adc_presence_vectorized.py` (new) | Vectorised monitor ≡ original per-sample logic | Guards the shared change |
| `GlasgowDataIO/IobeamControl/commands/__init__.py`, `transfer/glasgowStream.py` | Per-chunk `print(flush=True)` → `logger.debug` | Console I/O on the hot path |
| `ionbeam-web/backend/src/ftpUpload.ts`, `server.ts` | `operation/output-data` accepts optional `artifacts: {csv_base64, image_base64}`; the FTP upload uses those bytes instead of fetching `/scan/last/*` from glasgow_service; artifacts are never stored in the operation record | The native app acquires in its own process, so glasgow_service's "last scan" would be stale. Browser requests are unchanged. |
| Removed: `ionbeam-desktop/` (672 files, ~146k lines: an Electron shell plus a `runtime/` copy of GlasgowDataIO, glasgow_service, AutomationPy, LoadFPGAImage and the web frontend), `glasgow_service/desktop_native.py` + its test and the `GLASGOW_DESKTOP_ENABLED` hook in `api.py`, `Scripts/build-desktop.py`, `Scripts/deploy-desktop.py`, the desktop drop-in in `Scripts/manage-local-system.sh`, the `--desktop*` options in `buildCompiledDist.py` and `distributionDeployApp.py`, and `installDesktopScanner_state.py` | Earlier desktop attempt (commit 981c821). It kept the per-scan reconnect, so it could not help, and it duplicated the acquisition stack. `service.py` keeps the `native_samples` flag (the native app consumes raw sample arrays in-process, transport label `in_process`); the web perf instrumentation from f4c694b stays, reporting `websocket` only |
| `.github/workflows/ionbeam-native.yml` (new) | CI: parity-fixture check, Linux install/lint/test/smoke/bundle/benchmark, Windows install/test | Build and install automation |

Verification of the shared changes: glasgow_service suite **288 passed, 2 skipped**; backend `tsc --noEmit` clean and backend tests pass.

---

## 6. Build and install automation

| Piece | What it does |
|---|---|
| `scripts/install_linux.sh` | Idempotent: venv (own, or `--venv` to share the Operations venv), pinned requirements, editable install, import verification, Qt system-library check, `~/.local/bin/ionbeam-native` launcher, menu entry + icon, optional Glasgow udev rule (`--udev`), post-install smoke test, `--uninstall` |
| `scripts/install_windows.ps1` | Same steps for Windows: venv, pins, verify, `%LOCALAPPDATA%\IonBeamNative\ionbeam-native.cmd`, Start-menu shortcut (`pythonw`, no console), user environment, smoke, `-Uninstall` |
| `scripts/build.py` | pyflakes → native tests → glasgow_service tests → smoke → bundle (`ionbeam-native-<version>-<git sha>.tar.gz` / `.zip` + `SHA256SUMS`) containing exactly the Development slice the app needs, plus these docs |
| `scripts/smoke.py` | Launches the real app offscreen against the emulator and the mock backend, then checks start, session open, control plane, clean shutdown and no tracebacks |
| `Makefile` | `install`, `install-dev`, `test`, `lint`, `smoke`, `bench`, `build`, `run`, `run-emulator`, `parity` |
| CI | `.github/workflows/ionbeam-native.yml`; artifacts: bundle + emulator benchmark JSON |
| **Operations build** (`buildCompiledDist.py`) | The app ships inside the normal `dist_app.zip`: its Python is byte-compiled like the rest of Development, and its package data (icons, images, translation tables, docs) is copied by the new `PACKAGE_DATA_TREES` step. The entry point, persistent session, main window, smoke script, installer, requirements and key data files are required members, so a build without them fails and the deploy-side manifest check rejects the archive. |
| **Operations deploy** (`DeployWorkSpace/.../DistributionDeploy`) | `installPipRequirements` also installs `ionbeam-native/requirements.txt` (and verifies `PyQt6.QtCore`). The new `installIonbeamNative` action (after `setupLocalRedis`, before `manageLocalSystem`) installs the Qt runtime libraries, then runs `install_linux.sh --venv .venv --skip-pip`: launcher, menu entry and an emulator smoke test for the deploying user. It is a no-op on production (remote) hosts. The installer detects the sourceless (`.pyc`) tree and runs it from `PYTHONPATH` instead of an editable install. |

Verified here: a real `dist_app.zip` built with `buildCompiledDist.py`, unpacked as a deployment and installed by running the `installIonbeamNative` state itself (the app and glasgow_service run from `.pyc` only, and the smoke test passes); the DistributionDeploy suite (81 tests, including the new action and builder checks); fresh-venv install from `requirements.txt` followed by the full test suite; `install_linux.sh` end to end (launcher, desktop entry, smoke, uninstall); `build.py` end to end; install from the built bundle. **Not verified here:** `install_windows.ps1` and the Windows CI job (no Windows host available); the first CI run will exercise them.

---

## 7. Test inventory

| Suite | Count | Covers |
|---|---:|---|
| `tests/test_persistent_session.py` | 6 | 1 connect / N soft resets over consecutive scans; abort then rescan has no stale data; vector after raster; soft-reset failure → hard close → reconnect; release frees the lock; engine live mode (5 frames, no reconnect) |
| `tests/test_web_parity.py` | 28 (936 cases) | Web TypeScript ≡ Python port |
| `tests/test_ui_flows.py` | 11 | Real main window + controller + engine + emulator + mock backend (see §4) |
| `glasgow_service/tests` | 288 (+2 skipped) | Existing suite + vectorised monitor |
| Backend | tsc + existing tests | output-data artifacts path compiles |
| Smoke | 1 | `python -m ionbeam_native` process start → shutdown |

The emulator (`ionbeam_native/testing/fake_glasgow.py`) parses the real command stream the macros write (Synchronize, Flush, Blank, BeamSelect, RasterRegion/Pixel/Run/Fill, VectorPixel, Array, …). It emits one sample per pixel on the gateware's beam-time schedule, implements `reset()` like the gateware reset, and encodes the cookie in every sample so tests can prove which scan a sample came from.

---

## 8. What still has to be proven on the instrument

The emulator exercises the real host code but **not** real USB timing or the real gateware. Before rolling out, run this on the instrument (commands in the runbook, §6):

1. **Image reuse.** At first start the log shows `desktop launcher: programmed bitstream …`. After a restart of the app with the board still powered it should show `reusing running bitstream …`, with no settle sleeps.
2. **Soft reset holds.** 20 consecutive raster scans: `[perf] … reconnected=False soft_reset=<~1>ms`, and the `[session]` line after each scan shows `'connects': 1` and `'hard_closes': 0`.
3. **Throughput.** Median `wall` vs `beam` in the `[perf]` lines for 512²/d1 and 1024²/d3. Expect duty in the same range as §1.
4. **Data identity.** Same parameters, one scan in the web app and one in the native app, with DumpData on: the CSVs must match within ADC noise (same shape and orientation, same value range).
5. **Abort safety.** Stop a 2048² scan halfway, start a 256² scan: the image must contain no stripes from the previous scan. The cookie guards this and the emulator test covers it, but it must be confirmed on the gateware.
6. **Image switch.** Run the ADC test, then a raster scan: the log shows the scan image being programmed again, and the scan is correct.
7. **Handover.** Release Glasgow in the native app → scan in the web app → scan again in the native app.

If step 2 fails on hardware (e.g. the gateware needs more than the run-gate write after a reset), the app already falls back to the hard close automatically. It then behaves like today's web service while keeping the other gains (no per-sample Python monitor, no synchronous dumps). The fix would be local to `PersistentGlasgowConnection.soft_reset`.

---

## 9. Code map (`ionbeam-native/ionbeam_native/`)

| Package | Contents |
|---|---|
| `__main__.py` | CLI entry (`--config`, `--api-url`, `--emulator`, `--force-reload`, `--log-dir`, `--log-level`, `--smoke-test`) |
| `engine/` | `engine.py` (thread + loop, jobs, live mode, ADC), `service.py` (DesktopDeviceService), `persistent.py`, `frames.py`, `artifacts.py`, `perf.py`, `adc_mock.py` |
| `core/` | Pure ports of the web `lib/` + `scanSlice` state: display levels, scan timing, geometry, bitmap vector, gray-scale helpers, JS number formatting |
| `ui/` | `main_window.py` (App.tsx), `controller.py` (slices, effects, recording), `header.py`, `params.py`, `scan_controls.py`, `image_canvas.py`, `painters.py`, `level_wedge.py`, `roi.py`, `gray.py`, `mag_calibration.py`, `diagnostics.py` (ADC/DAC), `report.py`, `dashboards.py` (vacuum/stage), `theme.py`, `common.py` |
| `backend/` | REST client for the Node control plane |
| `i18n/` | Web locale tables (en, zh-CN, zh-TW) + help topics |
| `testing/` | Glasgow emulator, mock control-plane backend |
