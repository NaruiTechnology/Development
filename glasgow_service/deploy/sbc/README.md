# SBC vacuum controller: install / deploy package

Installs `glasgow_service.sbc_vacuum_app` on a **Raspberry Pi 4 Model B or Raspberry Pi 5**
wired to the **RPi5VacuumIO rev A.1** board, together with the wired connection map that the
installer and the service check the vacuum profile against.

| File | Runs on | Purpose |
|---|---|---|
| `build_sbc_bundle.py` | dev host | Builds `dist/sbc-vacuum-<version>.tar.gz`: package source (no tests), installer, unit, env and profile templates, wiring map, `VERSION`, `SHA256SUMS`. `--wheels` adds an offline aarch64 wheelhouse |
| `deploy-sbc.sh` | dev host | Builds (or takes `-b`) a bundle, copies it over SSH, verifies the checksums and runs the installer with `sudo` |
| `install_sbc.py` | the Pi | Installs / upgrades / rolls back. Python standard library only |
| `wiring-map.json` | both | Machine-readable wired connection map (header → J3, I2C chips, UARTs, `config.txt`, every terminal, every dashboard device) |
| `sbc-vacuum.service.in`, `sbc-vacuum.env.in` | the Pi | systemd unit and environment templates |

The checks live in the package as `glasgow_service.sbc_wiring` (installed on the Pi as
`sbc-vacuum-preflight`).

## Quick start

```bash
# On the dev host, from Development/
glasgow_service/deploy/sbc/deploy-sbc.sh pi@vacuum-pi --dry-run     # see what it would do
glasgow_service/deploy/sbc/deploy-sbc.sh pi@vacuum-pi               # install
ssh pi@vacuum-pi sudo reboot                                         # first install only
ssh pi@vacuum-pi sudo sbc-vacuum-preflight preflight                 # Pi, config.txt, profile vs map
```

Without network access to the Pi: `python3 glasgow_service/deploy/sbc/build_sbc_bundle.py --wheels`,
copy the tarball on a USB stick, then on the Pi `tar xzf sbc-vacuum-*.tar.gz && cd sbc-vacuum-*/ &&
sha256sum -c SHA256SUMS && sudo python3 install_sbc.py`. Use `--python 3.13` for a trixie image
(bookworm is 3.11).

## What the installer does

1. **Detects the model** from `/proc/device-tree/model` (`--model 4B|5` only to confirm, or for
   image builds on another machine).
2. **OS packages:** `python3-venv`, `python3-pip`, `python3-lgpio`, `i2c-tools` (`--no-apt` to skip).
3. **Service user** `vacuum` (system user, no login) in `gpio`, `i2c` and `dialout`.
4. **Boot settings**, in a managed block at the end of `config.txt` (the original is backed up as
   `config.txt.sbc-vacuum.bak-<time>`):

   | Pi 4 Model B | Pi 5 |
   |---|---|
   | `dtparam=i2c_arm=on`, `enable_uart=1`, `dtoverlay=disable-bt`, `dtoverlay=uart5` | `dtparam=i2c_arm=on`, `enable_uart=1`, `dtoverlay=uart4-pi5` |

   It also removes `console=serial0,…` from `cmdline.txt` and masks `serial-getty` on the UART:
   a login console on GPIO14/15 would talk on the turbo pumps' RS-485 bus. On the Pi 4B it disables
   `hciuart`. Any of these changes sets **reboot required**.
5. **Release** into `/opt/ionbeam/sbc-vacuum/releases/<version>/` with its own virtualenv
   (`--system-site-packages`, so the OS `lgpio` is used). The last three releases are kept.
6. **Site files**, never overwritten once they exist (a new copy lands next to them as `.dist`):
   - `/etc/sbc-vacuum/wiring-map.json`: the as-wired record. Edit it if the cabinet differs.
   - `/etc/sbc-vacuum/vacuumSystem.json`: generated from the board profile for this model
     (`PiModel`, `Serial` nodes), with **`Enable: false`** and **`Simulate: false`**, so nothing
     switches until commissioning, and the service never falls back to the emulator.
   - `/etc/sbc-vacuum.env`: port **8766**, the profile path and a random `SBC_VACUUM_TOKEN`.
   - `/etc/sbc-vacuum/WIRING-MAP.md`: the map as tables.
7. **Wiring check:** the profile must agree with the map (every relay, ready/fault input, valve
   and gauge of every pump, the HV permissive, the Pi model and the serial nodes). A direct-GPIO
   profile (`SBC.GPIO`) is refused, because on this board it would drive IO_RESET_N, the heartbeat
   and the rail-status lines. If the check fails, `current` is not switched (`--force` overrides).
8. **Activate:** `/opt/ionbeam/sbc-vacuum/current` is switched atomically to the new release, and
   the unit is installed and enabled. The unit runs the same wiring check as `ExecStartPre`.

**The installer never restarts a running controller**: a restart pumps the system down unless
`KeepBackingPumpOnRestart` works on this board. It installs the release and tells you to run
`sudo systemctl restart sbc-vacuum` when that is acceptable (or pass `--restart`). It does not
start the service before a required reboot either.

```bash
sudo python3 install_sbc.py --rollback            # current <-> previous release (no restart)
sudo python3 install_sbc.py --uninstall --yes     # stops the controller; keeps /etc and /opt
```

## Preflight

```bash
sudo sbc-vacuum-preflight show                    # the connection map
sudo sbc-vacuum-preflight check                   # profile vs map, no hardware
sudo sbc-vacuum-preflight preflight               # + model, config.txt, console, /dev nodes, groups
sudo systemctl stop sbc-vacuum                    # (pumps go off)
sudo sbc-vacuum-preflight preflight --probe       # + reads the board: 0x20 0x21 0x48 0x49, rails
```

The probe only reads registers. It releases the expanders' reset (GPIO22) just long enough to read
them, and puts it back. If the expanders already answer (IO_RESET_N held high by a latched backing
pump), it reads them without touching GPIO22. It refuses to run while `sbc-vacuum` is active.
Rehearse it without hardware: `python -m glasgow_service.sbc_wiring preflight --emulator`.

## After the install

1. Reboot if told to, then `sudo sbc-vacuum-preflight preflight` and, with the service stopped,
   `--probe`.
2. Commission with **WIRING.md step 12** (jumper test, `Interlock: false` on the gauges only for that
   test). Set `"Enable": true` in `/etc/sbc-vacuum/vacuumSystem.json` and restart `sbc-vacuum`.
3. Point the host at the Pi: in the host backend's environment set
   `VACUUM_CONTROLLER_URL=http://<pi>:8766` and the same `SBC_VACUUM_TOKEN`.
4. Monitoring: alert on non-200 from `http://<pi>:8766/health/vacuum`
   (see `docs/vacuum-24x7-commissioning.md`).
