# SBC vacuum regression test

Run these steps from the Operations repository root unless noted otherwise.

## 1. Static and automated regression

```bash
cd Development/glasgow_service
pytest -q --ignore=tests/test_wet_run.py
cd ../ionbeam-web/backend && npm run build
cd ../frontend && npm run build
cd ../../..
python3 Development/buidCompiledDist.py --raw
```

Expected results: all Python tests pass, both TypeScript builds complete, and
the distribution builder reports validated `gpiozero`, `httpx`, and `redis`
dependencies before creating `dist_app_raw.zip`.

## 2. SBC simulation contract

Keep `Simulate: true` in `vacuumSystem.json`, then start the SBC API without
remote fencing:

```bash
cd Development/glasgow_service
export PYTHONPATH="$PWD/..:$PWD"
export SBC_VACUUM_CONFIG="$PWD/../GlasgowDataIO/Json/vacuumSystem.json"
export SBC_REQUIRE_FENCING=false
python3 -m uvicorn glasgow_service.sbc_vacuum_app:app --host 127.0.0.1 --port 8765
```

In another terminal:

```bash
curl -fsS http://127.0.0.1:8765/status
status="$(curl -fsS http://127.0.0.1:8765/vacuum)"
printf '%s\n' "$status"
curl -fsS -X POST http://127.0.0.1:8765/vacuum/acquire \
  -H 'Content-Type: application/json' \
  -d "$(printf '%s' "$status" | jq '{expected_channels: (.pumps | map({key: .name, value: .threshold}) | from_entries)}')"
curl -fsS -X POST http://127.0.0.1:8765/vacuum/pumps/MechanicalVacuumPump/read \
  -H 'Content-Type: application/json' -d '{"checked":true}'
```

Confirm that `control_transport` is `sbc-simulation`, `simulation` is true,
`runtime_seconds` increases, the expected values round-trip as `threshold`,
and the simulated mechanical read advances the cascade.

## 3. Failover regression

1. Start the Redis primary, replica, and at least three Sentinels using
   `deploy/setup-redis-sentinel.sh` on the intended hosts.
2. Start the SBC API with `SBC_REQUIRE_FENCING=true`.
3. Start two executor instances with distinct `VACUUM_EXECUTOR_ID` values and
   the same Sentinel settings. Point both `VACUUM_SBC_URL` values at the SBC.
4. Query both `/status` endpoints. Exactly one must report `active: true`.
5. Send acquisition and pump commands to the active executor's `/vacuum/*`
   interface. Confirm the SBC accepts them.
6. Send the same command to the standby. It must return HTTP 409.
7. Stop or network-isolate the active executor. After the configured lease
   TTL, confirm the standby becomes active with a larger fencing token.
8. Restore the old executor and confirm it remains standby and its old token
   cannot mutate the SBC.
9. Stop Redis connectivity to the active executor. Confirm it fences locally
   and no further GPIO writes are accepted after its SBC validity window.

## 4. Web end-to-end regression

Configure the Node backend:

```dotenv
PROXY_TARGET_HTTP=http://glasgow-host:8765
VACUUM_CONTROLLER_URL=http://active-executor:8780
```

Test once with `MOCK=0` and once with `MOCK=1`. In both cases:

1. Open the vacuum dashboard.
2. Confirm the UI sends one expected value for every configured equipment item during acquisition.
3. Confirm the displayed runtime increments once per second.
4. Toggle each permitted pump and verify UI state follows the SBC response.
5. In simulation, operate each readback control and verify cascade behavior.
6. Close/reopen the dashboard and confirm status is re-read from the SBC.
7. Stop the executor and confirm the UI reports an upstream error instead of
   falling back to Node's old in-process vacuum mock.

## 5. Real GPIO commissioning

Do not connect pump power loads directly to GPIO. Use isolated, fail-safe
relay or interface circuitry and commission initially with pumps disconnected.

1. Install the distribution on Raspberry Pi OS and verify:

   ```bash
   . /opt/ionbeam/.venv/bin/activate
   python -c 'import gpiozero, lgpio; print(gpiozero.__version__)'
   id vacuum
   systemctl status sbc-vacuum.service
   ```

2. Verify the configured BCM pins against the wiring drawing. Confirm no pin
   is claimed by I2C, SPI, UART, a HAT overlay, or another process.
3. With relay inputs disconnected, set `Simulate: false`, start the service,
   and verify every output initializes low.
4. Attach a logic analyzer or isolated test LEDs. Exercise one output at a
   time and verify the physical BCM line matches `port_a_value`.
5. Drive each comparator input low/high with a current-limited 3.3 V test
   source and verify `port_b_value` changes between 0 and 3.3 V.
6. Verify active-high/active-low behavior before connecting relay controls.
7. Connect one pump interface at a time and repeat acquisition, power,
   comparator, stop, release, service-restart, and failover tests.
8. Remove network and power unexpectedly. Confirm hardware returns to the
   documented safe state and recovery does not energize downstream pumps
   before upstream readiness is present.

Record timestamps, executor IDs, fencing tokens, GPIO measurements, and pump
responses for every real-hardware test run.
