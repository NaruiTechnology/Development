# Raspberry Pi vacuum controller

## Deployable baseline

```text
Browser UI -> ionbeam-web /api/vacuum/* -> SBC API :8765
                                          -> simulator or BCM GPIO
```

This topology requires no Redis or executor. Point `VACUUM_CONTROLLER_URL`
directly at the SBC. The active/standby executor is an optional later layer;
`SBC_REQUIRE_FENCING=true` switches the same API to that contract.

The SBC process owns the controller lifecycle and starts the configured cascade
at service startup. Clients may stop or resume downstream stages. Scan traffic
continues to use `PROXY_TARGET_HTTP` and does not own vacuum GPIO.

## Control logic and safety boundary

The configured sequence is:

1. Start the mechanical/backing pump.
2. Wait for its isolated comparator input before starting the turbo pump.
3. Wait for the turbo comparator before starting the UH pump group.
4. Report ready only when every configured input is asserted.

The controller continuously reconciles interlocks. Loss of turbo-ready
de-energizes all UH outputs; loss of mechanical-ready de-energizes turbo and UH
outputs. A GPIO read failure clears all software readiness. The backing pump
remains on during a normal stop so pressure can recover. Service shutdown
drives all managed outputs inactive.

Software is not the emergency protection layer. The interface hardware must
provide inactive boot states, galvanic isolation, pump-specific permissives,
and a hardwired emergency chain that removes hazardous energy independently of
Linux, Python, and the Raspberry Pi. Never drive pump loads, contactors, or
solenoids directly from GPIO.

Numeric gauge acquisition uses the same SBC device boundary in both modes.
`VacuumController.poll_once()` calls `VacuumDevice.read_gauge_values()` and
publishes the result as each pump's `value`. The deterministic SBC simulator
owns the simulated pressure progression and drives its comparator inputs from
those values. On hardware, `RaspberryPiGPIODevice` accepts a gauge adapter for
the installed ADC or serial gauge protocol. Until an adapter is supplied,
numeric values are `null` while the independent digital comparator/interlock
path remains active.

## RPi5VacuumIO board mode

The production hardware is a **Raspberry Pi 4 Model B** with the **RPi5VacuumIO rev A.1**
interface board (see [`rpi-vacuum-shopping-list.md`](rpi-vacuum-shopping-list.md) and
`GlasgowDataIO/Hardware/VacuumController/RPi5VacuumIO`). Configure it with an `SBC.Board` section
instead of `SBC.GPIO` (example: `GlasgowDataIO/Json/vacuumSystem.rpi5-io.example.json`). The
service then uses `glasgow_service/vacuum_io_board.py`: relays through the MCP23017 at 0x20,
isolated inputs at 0x21, gauges through the two ADS1115s, the K10 heartbeat watchdog, and the
E-stop and output-rail status. Board mode adds fault inputs, E-stop / rail / keep-alive /
expander-reset interlocks, optional gauge interlocks, and `alarms` and `board` fields in
`GET /vacuum`.

Configuration → General → **Active vacuum control** edits `Enable` in
`vacuumSystem.rpi5-io.example.json`. Enabled control uses the emulator when scanner `IsProduction` is false and real SBC hardware when it is true;
disabled control remains idle and bypasses the vacuum scan gate. Scan
`IsProduction` selects execution mode, while `Enable` controls activation. Explicit development tooling can
run the production driver on an emulated rig; see [`vacuum-emulator.md`](vacuum-emulator.md).

## API

Run `python -m glasgow_service.sbc_vacuum_app`. It exposes:

- `GET /status`, `/health/live`, `/health/ready`, and `/vacuum`
- `POST /vacuum/acquire` with optional `expected_channels`
- `POST /vacuum/pumps/{name}/power`
- `POST /vacuum/high-voltage/power` (vacuum-ready interlocked)
- `POST /vacuum/stop`, `/vacuum/resume`, and `/vacuum/release`
- `POST /vacuum/simulation/{name}/ready` with `{"ready": true|false}`
- `GET /emulator` and `POST /emulator/*` (only when the emulator is active: `IsProduction` false)

All mutations require the bearer token when `SBC_VACUUM_TOKEN` is set.
`Enable: true` activates control in the mode selected by scanner `IsProduction`. `Enable: false` reports an idle,
disabled service, and `/vacuum` returns 404. Simulator endpoints are available
only in an explicitly constructed development app.

## Run the simulation

Keep `"IsProduction": false` and `"Simulate": true` in `vacuumSystem.json`, then run:

```bash
export SBC_VACUUM_CONFIG=/path/to/vacuumSystem.json
export SBC_REQUIRE_FENCING=false
export SBC_VACUUM_TOKEN=local-test-token
python -c 'import uvicorn; from glasgow_service.sbc_vacuum_app import create_app; from glasgow_service.vacuum import load_vacuum_config; uvicorn.run(create_app(config_loader=load_vacuum_config), host="127.0.0.1", port=8766)'
```

Exercise the cascade and interlocks through the production API:

```bash
curl http://127.0.0.1:8765/vacuum
curl -X POST -H 'Authorization: Bearer local-test-token' \
  -H 'Content-Type: application/json' -d '{"ready":true}' \
  http://127.0.0.1:8765/vacuum/simulation/MechanicalVacuumPump/ready
curl -X POST -H 'Authorization: Bearer local-test-token' \
  -H 'Content-Type: application/json' -d '{"ready":true}' \
  http://127.0.0.1:8765/vacuum/simulation/TurboVacuumPump/ready
```

Posting `ready:false` for either upstream stage verifies downstream shutdown.
The simulator also approaches thresholds automatically on each poll.

## Deploy standalone on Raspberry Pi OS

1. Install `python3-venv` and `python3-lgpio`; create a `vacuum` system user in
   the `gpio` group.
2. Install under `/opt/ionbeam`, create `/opt/ionbeam/.venv`, and install with
   `pip install -e '.[sbc]'`.
3. Copy `examples/sbc-vacuum.env.example` to `/etc/sbc-vacuum.env`. Set a long
   random token, keep fencing false, and set the deployed config path.
4. Commission every channel with `Simulate: true`. Verify BCM mapping, relay
   polarity, isolation, inactive boot/power-loss state, and hardwired safety.
5. Change only `Simulate` to false, install `deploy/sbc-vacuum.service`, then
   run `systemctl daemon-reload` and `systemctl enable --now sbc-vacuum`.
6. Check `/health/ready`, `GET /vacuum`, and `journalctl -u sbc-vacuum` before
   connecting equipment control inputs.

The committed BCM assignments are placeholders and must be checked against the
actual Pi model, carrier schematic, and wiring drawing. Bind the API to a
trusted control network or localhost/reverse proxy; bearer authentication does
not provide TLS or network isolation.

## Optional failover and fencing

When an executor exists, enable `SBC_REQUIRE_FENCING`, configure the executor
from `examples/vacuum-executor.env.example`, and route the web backend through
it. Redis Sentinel then elects one executor, which supplies a monotonically
increasing fencing token and lease duration. The SBC persists the highest term
and rejects stale or expired leaders.

For the full UI simulation procedure, see
[`vacuum-integration-test.md`](vacuum-integration-test.md).
