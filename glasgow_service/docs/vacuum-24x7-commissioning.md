# 24/7 vacuum controller: ownership and commissioning

## Who owns what

The SBC vacuum controller (`glasgow_service.sbc_vacuum_app`, unit `sbc-vacuum`)
owns the vacuum system. Once it runs, it sequences the pumps, enforces the
interlocks and recovers from faults on its own. The host stack (scan service,
web backend, UI, optional failover executor) only starts it and reads its
status; operator commands from the UI are forwarded to it and the SBC decides.

| Host action | Effect on the SBC |
|---|---|
| Configuration → Update / Restore (scan settings) | None. The host's reset hook restarts only the scan service; it *starts* `sbc-vacuum` and the optional executor if they are not running, and never restarts them. |
| Configuration → Active vacuum control | None. Host setting only (`vacuumHost.json`): shows/hides the vacuum dashboard and the vacuum scan gate. |
| SBC profile `Enable: false` | The SBC runs idle. The host follows it: no vacuum dashboard and no vacuum scan gate, even with Active vacuum control on (the host shows vacuum only when both are on; an unreachable SBC stays visible as down). The executor waits (checks every 30 s) instead of fencing. Turn control on in the SBC profile, then `restart-vacuum --yes`. |
| `manage-local-system.sh start` / `restart` | Starts `sbc-vacuum` only if it is not running; never restarts it. |
| `manage-local-system.sh stop` | Stops the host stack; `sbc-vacuum` keeps running. |
| Redeploy (distribution deploy) | `sbc-vacuum` keeps running the previous version; `start/restart` prints a note. Load the new version with `restart-vacuum --yes` when a restart is acceptable. |
| Web backend or executor down | The vacuum keeps running; the UI shows the SBC as unreachable until the host is back. |
| `manage-local-system.sh stop-vacuum --yes` / `restart-vacuum --yes` | The only host commands that stop or restart the SBC. |

The SBC never reads host configuration: its own profile (`SBC_VACUUM_CONFIG`)
decides `Enable` and `IsProduction`. The host reads the SBC directly
(`VACUUM_CONTROLLER_URL`, default `http://127.0.0.1:8766`, with
`SBC_VACUUM_TOKEN`); the failover executor is not in that path.

## Configure the SBC

In `/etc/sbc-vacuum.env` (or the local env file):

- `SBC_VACUUM_TOKEN` — long random value; give the same value to the web backend.
- `SBC_VACUUM_ALERT_WEBHOOK` (+ optional `SBC_VACUUM_ALERT_TOKEN`) — where alerts go.
- `SBC_VACUUM_ALERT_REMIND_SECONDS` — reminder interval while stopped (default 1800).
- `SBC_VACUUM_AUTO_RESUME_POLLS` — healthy polls before a device-error stop clears (default 10).

In the SBC profile: `Enable`, `IsProduction`, and for the board
`SBC.KeepBackingPumpOnRestart` (see below; leave `false` until verified).

Point monitoring at `GET http://<sbc>:8766/health/vacuum` and alert on non-200.

## Commissioning checks

Run on the emulator first (`IsProduction: false`), then on the rig. Record the
SBC uptime before each host action with
`curl -s http://127.0.0.1:8766/vacuum | python3 -m json.tool | grep runtime_seconds`.

1. **Host decoupling.** Save the scan configuration, use the UI service reset,
   run `manage-local-system.sh restart` and `stop`, restart the web backend.
   After each: `runtime_seconds` kept increasing, pumps unchanged, no
   `controller_stopped` alert.
2. **Transient glitch.** Emulator: `POST /emulator/faults/i2c_nack` with
   `{"address": 33, "count": 1}`. Expect `cascade_latch: device_error`, a
   `cascade_stopped` alert, then within about 10 s an automatic resume, a
   `cascade_resumed` alert and the cascade restarting stage by stage.
3. **Operator stop and reminders.** `POST /vacuum/stop`: `/health/vacuum`
   returns 503 with `cascade stopped (operator)`; a reminder arrives after
   `SBC_VACUUM_ALERT_REMIND_SECONDS`; `POST /vacuum/resume` clears it.
4. **E-stop.** Open the loop: every relay and valve drops, K1 included, alarm
   and alert. Close it: nothing restarts until `POST /vacuum/resume`.
5. **Watchdog.** `systemctl kill -s STOP sbc-vacuum` (add `--user` for the
   local unit): the output rail drops within about 0.1 s (board keep-alive and
   K10), K1 stays on (process alive, IO_RESET_N held). Within about 20 s
   systemd restarts the service (`WatchdogSec=20`); see the next section for K1
   across that restart.
6. **Board fail-safe table.** Run the WIRING.md commissioning rows 1–10.
7. **Failover** (fenced deployments only): stop the active executor; the SBC
   keeps enforcing interlocks during the lease gap and the standby takes over
   without a pump-down.

## Keeping the backing pump running across an SBC restart

K1 (backing pump) runs from the E-stop rail precisely so it can run while no
software supervises the board. But on every *process exit* the OS releases
GPIO22 (IO_RESET_N), the board's R10 pulls it low, the expanders reset, and
K1 drops: a crash, a watchdog restart, `restart-vacuum` and a reboot all pump
the system down. Only a *hang* keeps K1 (the process still holds the line).

Software support is in place: with `"KeepBackingPumpOnRestart": true` in the
profile's `SBC` section, an orderly stop clears every output except K1 and
leaves IO_RESET_N released, and the next start adopts a still-latched K1
(every other output is cleared before the output rail returns, then the
cascade restarts from the measured state). It takes effect only when
IO_RESET_N stays high while no process holds it. Choose one:

- **Board change (deterministic):** replace R10's pull-down with a pull-up to
  3V3. At power-up the expanders then leave reset in their power-on state —
  all pins inputs, driver inputs pulled down, every relay off — so a cold
  boot stays safe; only a latched K1 survives a process restart.
- **Platform setting:** keep the Pi's GPIO outputs driven after the process
  releases them (kernel GPIO output persistence on the Pi's pin controller).
  Availability depends on the Raspberry Pi OS kernel; verify on the rig.

Verify on the rig with the switch on: `systemctl restart sbc-vacuum` — K1's
LED never goes out, D10 drops for the restart and returns, the turbo and UH
pumps come back through the cascade, and the log shows
"MechanicalVacuumPump was still running from before the restart: adopted".
Then a cold power cycle: everything starts off. Without either change the
switch has no effect (K1 drops as before), which is safe.
