# Vacuum controller emulator (Raspberry Pi + RPi5VacuumIO + DB235)

`glasgow_service.emulation` lets the vacuum controller be developed and tested without the
hardware. The production code paths stay unchanged: `VacuumController`, the board driver
`glasgow_service/vacuum_io_board.py` and the FastAPI service all run as they will on the Pi. Only
the Linux endpoints they open (`/dev/i2c-1`, the GPIO chip, `/dev/ttyAMA*`) are emulated.

```
 VacuumController ── RPi5VacuumIODevice ──┬─ EmulatedSMBus ─── I2C1 ──┬─ MCP23017 U1 0x20 ─ K1..K8, V1..V8 ─┐
 (production)        (production driver)  │                           ├─ MCP23017 U3 0x21 ─ DI1..DI16 ◄────┤
                                          │                           └─ ADS1115 U9/U10 ─── AI1..AI8 ◄─────┤
                                          ├─ EmulatedGpioHAL ── GPIO22/19/5/6/18/26                        │
                                          └─ EmulatedSerial ─── UART0 ─ MAX3485 ─ RS-485 ◄─► turbo drives  │
                 RaspberryPi (4B or 5)          RPi5VacuumIOBoard (rails, K9, K10 watchdog)               │
                                                                                     DB235Plant ◄─────────┘
```

## Layers

| Module | Models |
|---|---|
| `clock` | Deterministic virtual time (tests); `RealtimeRunner` for interactive use, with optional time compression |
| `raspberry_pi` | Pi 4 Model B (default) and Pi 5: 40-pin header, BCM GPIO with power-on pull defaults, net resolution against board resistors, lgpio-style PWM, `/dev/i2c-1` with real NACK errors, UART muxing by `config.txt` (Pi 4B: `disable-bt`, `uart5`; Pi 5: `uart4-pi5`), EEPROM `BOOT_ORDER`, PSU and USB-current rules |
| `chips` | MCP23017 (both IOCON.BANK maps, sequential mode, IPOL, interrupt-on-change / DEFVAL, INTF/INTCAP, MIRROR/ODR, ~RESET, power-on reset) and ADS1115 (single-shot / continuous, data-rate timing, PGA, MUX, comparator and conversion-ready ALERT/RDY, general-call reset) |
| `board` | RPi5VacuumIO rev A.1 from `tools/design.py`: J1/F1/+24V_AUX, K9 E-stop rail, K10 watchdog rail with the GPIO19 charge pump (C4/D6/C5/R3, ~100 ms dropout, stuck high or low trips), R10 reset hold, JP1-JP8 coil rails, G5LE operate/release times, opto inputs (active low), 68k/22k divider + RC + clamp, rail-status optos, MAX3485 DE/RE gating, LEDs |
| `db235` | Fore-line, chamber and two UH volumes; rotary backing pump with a ready contact; three turbo drives (remote start, at-speed and no-error contacts, 0-10 V speed, run-up/fore-vacuum errors, Pfeiffer RS-485 protocol); Pirani and PKR 251 gauge laws; vent and pneumatic valves with reed switches; door / air / N2 / water |
| `rig` | All of the above wired as in `RPi5VacuumIO/WIRING.md`; `tool_connected=False` reproduces the commissioning set-up (jumper wires only) |

## Command line

```bash
pip install -e '.[sbc,tests]'
python -m glasgow_service.emulation boot          # boot log + header pinout
python -m glasgow_service.emulation i2cdetect     # 20 21 48 49 once GPIO22 is high
python -m glasgow_service.emulation commission    # WIRING.md step 12, row by row, with board LEDs
python -m glasgow_service.emulation pumpdown --minutes 10 --gauge-interlock
python -m glasgow_service.emulation --model 5 commission
```

## The service against the emulator

The normal SBC service uses `Enable` from
`GlasgowDataIO/Json/vacuumSystem.rpi5-io.example.json`. Configuration → General →
**Active vacuum control** updates this entry and restarts the service. `true`
activates the emulator when scanner `IsProduction` is false and real SBC hardware when it is true; `false` leaves the service idle and disables the
vacuum scan-readiness gate. Scanner `IsProduction` selects the execution mode.

For explicit emulator development, inject `load_vacuum_config` instead of the
normal runtime loader. This standalone loader selects the following modes:

| `IsProduction` | `Simulate` | SBC config | What runs |
|---|---|---|---|
| `false` | `false` | `SBC.Board` | Production driver on the **emulated** Pi + board + DB235. Real GPIO/I2C is never opened |
| `false` | any | `SBC.GPIO` | Built-in simulator (there is no emulator for direct GPIO wiring) |
| `false` | `true` | any | Built-in deterministic simulator |
| `true` (default when missing) | any | `SBC.Board` | Real RPi5VacuumIO board; startup fails without SBC hardware |
| `true` (default when missing) | any | `SBC.GPIO` | Real BCM GPIO; startup fails without SBC hardware |

The example config (`GlasgowDataIO/Json/vacuumSystem.rpi5-io.example.json`) ships with
`"IsProduction": false`; the explicit development loader runs it on the emulator:

```bash
export SBC_VACUUM_CONFIG=/path/to/vacuumSystem.rpi5-io.example.json
export SBC_REQUIRE_FENCING=false SBC_VACUUM_TOKEN=local-test-token
export SBC_VACUUM_EMULATOR_SPEED=20     # optional: compress plant time 20x
export SBC_VACUUM_EMULATOR_MODEL=4B     # optional: 4B (default from PiModel) or 5
python -c 'import uvicorn; from glasgow_service.sbc_vacuum_app import create_app; from glasgow_service.vacuum import load_vacuum_config; uvicorn.run(create_app(config_loader=load_vacuum_config), host="127.0.0.1", port=8766)' 
```

Restart the development app after changing its mode settings. Normal service startup selects emulation or hardware from scanner `IsProduction` when `Enable` is true.

Vacuum readiness requires a successful poll within five seconds. Unknown or
stale readings report disconnected/not ready, clear displayed pressure values,
and cannot permit high voltage. The browser also rejects stale timestamps and
unavailable status; its vacuum icon shows
an error while the popup remains collapsible.

`GET /status` reports `"mode": "board-emulator"` and `"is_production": false`. The dashboard works unchanged, and `GET /vacuum`
additionally carries `alarms` and a `board` readback (rails, 16 inputs, relays, solenoids,
analog voltages). Operator actions on the emulated rig, for UI work (bearer token required):

| Route | Body | Effect |
|---|---|---|
| `GET /emulator` | – | Full rig snapshot (Pi, board, plant pressures, turbo speeds) |
| `POST /emulator/estop` | `{"pressed": true}` | Open / close the E-stop loop |
| `POST /emulator/inputs/{n}` | `{"on": true}` | Commissioning jumper +24 V → DIn |
| `POST /emulator/tool` | `{"connected": false}` | Unplug / plug all tool-side connectors |
| `POST /emulator/faults/{name}` | `{"active": true}` | `MechanicalVacuumPump` thermal trip; turbo error (`"code": "Err006"`); `door_closed`, `compressed_air_ok`, `n2_ok`, `cooling_water_ok`; `heartbeat_stuck`; `i2c_nack` (`"address": 33`) |
| `POST /emulator/excursion/{pump}` | `{"mbar": 3e-3}` / `{"release": true, "recovery_s": 120}` / `{"mbar": 0}` | Pressure excursion on that pump's gauge: raise and hold it; release it (the running pump works it back down with that emulated time constant); clear it |

The excursion is added to one gauge's reading only (`MechanicalVacuumPump` → fore-line
Pirani AI1, `TurboVacuumPump` → chamber AI2, `UHVacuumPump_1/2` → AI3/AI4). It does not
load the fore-line. A real chamber leak large enough to lift the turbo's reading past
2e-3 mbar also lifts the fore-line past 0.1 mbar with the emulated 3 L/s backing pump, so a
real leak always becomes the mechanical-pump case. The excursion lets each pump be tested
on its own.

### Excursion test app

`scripts/vacuum_excursion_test.py` drives one excursion through the running service and
checks the controller's response, live on the dashboard:

```bash
cd glasgow_service
python scripts/vacuum_excursion_test.py                    # a random pump from the config
python scripts/vacuum_excursion_test.py TurboVacuumPump    # a specific pump
python scripts/vacuum_excursion_test.py --once             # one run, no next-pump prompt
python scripts/vacuum_excursion_test.py --local            # in-process emulator, no service
```

It raises the pump's reading slowly until it crosses the configured value, checks that its
isolation valve closes (slide switch off) and its card turns red while the other pumps keep
running, releases the excursion, and checks that the reading drops back to the value or
below, the valve opens and the card turns green. For `MechanicalVacuumPump` it also checks the
restart: every other pump stops and every valve closes, then the cascade restarts and the whole
system becomes ready. With no pump name it picks one at random from the configured `VacuumPumps` list and waits until that pump is running and green; a stopped cascade is resumed. Afterwards it asks for the next pump (Enter = random, q = quit). If the service predates the valve patch, it says so and stops. Pass the
service's bearer token with `--token` or `SBC_VACUUM_TOKEN`. The exit code is 0 when every check
passed.

## Log tags: which mode is running

Every log line from the vacuum controller (logger `glasgow_service.vacuum`) starts with a mode tag:

| Tag | Mode | When |
|---|---|---|
| `[VACUUM-HW]` | Real hardware | `IsProduction: true`, `Simulate: false` |
| `[VACUUM-EMU]` | Emulator | `IsProduction: false`, `Simulate: false` with an `SBC.Board` config |
| `[VACUUM-SIM]` | Built-in simulator | `IsProduction: false` with `Simulate: true` or an `SBC.GPIO` config |

At start-up the service logs one banner line with the mode, the flags and the reason. The banner is
a **WARNING** for `[VACUUM-HW]` ("LIVE HARDWARE: outputs drive real equipment"). After that it logs every relay switch, with its
logical channel and relay (for example `TurboVacuumPump (A1/K2) ON (automatic)`). It also logs HV
permissive changes, alarms raised and cleared, forced shutdowns, device errors (once per distinct
error) and operator resumes. `GET /status` reports the same tag as `log_tag`.

```bash
journalctl -u sbc-vacuum -b | grep -m1 'vacuum.*mode='     # the start-up banner
journalctl -u sbc-vacuum -f | grep VACUUM-                  # live: outputs, alarms, errors
SBC_VACUUM_LOG_FORMAT=json ...                              # JSON lines with "event" and "vacuum_mode"
```

## Verifying active hardware control

1. **Before hardware.** `test_is_production_true_runs_the_hardware_path_with_hw_tag` runs the
   production hardware path (`build_board_device` → `LgpioHAL` + `smbus2.SMBus`) with only those two
   Linux endpoints substituted, and checks the `[VACUUM-HW]` banner and that K1 is really driven.
2. **On the controller Pi**, after setting `"Enable": true` and restarting the normal service:
   - the banner reads `[VACUUM-HW] LIVE HARDWARE ... reason=IsProduction=true, Simulate=false`;
   - `curl localhost:8765/status` shows `"mode": "board"`, `"is_production": true`, `"log_tag": "[VACUUM-HW]"`;
   - `GET /emulator` returns 404 (no emulator exists in this mode);
   - `i2cdetect -y 1` shows `20 21 48 49` (the real chips) and `pinctrl get 19` shows the heartbeat;
   - then run WIRING.md step 12. Every row produces a `[VACUUM-HW]` line for each relay that
     switches, so the journal is the record of the commissioning run.

## Controller logic implemented on top of the board

All of it is covered by `tests/test_vacuum_io_board.py`:

- **Cascade** (from each pump's `groupName`): mechanical → turbo → UH group, with downstream shutdown on loss of ready.
- **Ready** = the pump's ready input (B channel → DIn) and its gauge reading at or below its
  configured value (unless the gauge sets `"Interlock": false`).
- **Isolation valves** (`SBC.Valves`, B channel → solenoid): a pump's valve is open exactly while
  the pump is ready. All valves close at start, stop, E-stop, device errors and interlocks.
- **Vacuum excursion**: a running pump whose reading rises above its value after being ready has
  its valve closed and turns red (`excursion: true`, `border: "error"`). The other pumps keep
  running. When the reading is back at or below the value, the valve reopens and the card turns
  green. HV is blocked meanwhile.
- **Backing pump restart**: when `MechanicalVacuumPump` is not ready (excursion or ready input
  lost), every other pump stops and every valve closes at once, as at initialization. The
  mechanical pump keeps running; once it is ready again the cascade restarts from the top.
- **Fault inputs** (`SBC.Faults`, wired "healthy = ON"): an open input marks the pump `fault`,
  switches that pump off (the backing pump is never switched off by software), raises an alarm and
  latches the cascade until `POST /vacuum/resume`. A faulted pump is never started.
- **E-stop** (GPIO5): all outputs are written off, including K1, so that releasing the E-stop
  **restarts nothing**. `POST /vacuum/resume` is the explicit reset; it refuses while the loop is open.
- **Output rail lost** (GPIO6, watchdog): downstream outputs and HV are written off; K1 stays (it
  is on the E-stop rail, JP1).
- **Keep-alive**: if the control loop stops polling for `KeepAliveSeconds`, the driver stops the
  heartbeat; K10 drops in about 100 ms. Resume re-arms it.
- **Expander reset** (supply dip or ESD on U1): detected from IODIR, the board is reconfigured all-off
  and every pump, including the backing pump, is reported off.
- **I2C failure**: the existing read-failure path applies (downstream off, backing pump kept).
- **HV permissive**: granted only when every pump is ready, no pump is faulted and no alarm is active.
- Alarms are reported in `status.alarms`; they are not communication errors, so `connected` and
  `/health/ready` stay true during an E-stop.

Not implemented yet: the vent (V3), bypass (V6) and cylinder (V7) channels are not sequenced,
and turbo speed or errors are not read over RS-485 in the control loop
(`glasgow_service.pfeiffer.PfeifferClient` works against the emulated drives).

## QEMU (operating-system level)

`scripts/qemu/run-raspi4b.sh` boots Raspberry Pi OS on QEMU's `raspi4b` machine (QEMU 9.0 or
later). Use it to check the image, the systemd unit and the Python environment. It has no model of
the I/O board and, upstream, no networking. Details are in
[`rpi-vacuum-shopping-list.md`](rpi-vacuum-shopping-list.md).

## Fidelity notes

- Timing is deterministic in tests: the driver's `sleep` advances emulated time. In real-time mode
  the plant runs compressed (`SBC_VACUUM_EMULATOR_SPEED`) while the driver's keep-alive uses wall
  time, because it supervises the wall-clock poll loop.
- The plant is a behavioural model for controller logic (orders of magnitude, not a vacuum
  simulation). With `gate_valves_affect_flow=False` (default), valves move and report position, but
  gas paths stay open, because the controller does not sequence valves yet.
- The lgpio software PWM keeps running in its own thread if the Python interpreter hangs while
  holding the GIL. The keep-alive covers a stalled event loop, not that case. A process crash
  stops the PWM, and the charge pump then trips K10.
