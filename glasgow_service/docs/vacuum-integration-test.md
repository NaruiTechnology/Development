# Vacuum controller integration test

This guide validates the complete software path in simulation:

```text
signed-in browser
  -> ionbeam-web backend :4000
     validates the user's X-Iobeam-Auth session token
  -> elected vacuum executor :8780
     attaches its fencing lease to mutations
  -> SBC vacuum API :8766
     verifies the executor bearer token and fencing term
  -> deterministic simulated GPIO plant
```

The user-session token, executor-to-SBC token, and Redis fencing lease are
separate controls. Do not reuse one credential for another role.

## 1. Preconditions

- Work from `/home/vboxuser/Project/Operations/Development`.
- Keep `GlasgowDataIO/Json/vacuumSystem.json` set to `"Simulate": true`.
- Redis and Sentinel must be reachable by the executor.
- Use at least three Sentinel endpoints when `SBC_REQUIRE_FENCING=true`.
- Do not connect pump loads during software integration testing.

Run the automated baseline first:

```bash
cd glasgow_service
PYTHONPATH=.. pytest -q \
  tests/test_vacuum.py \
  tests/test_vacuum_device.py \
  tests/test_execution_authority.py \
  tests/test_sbc_client.py \
  tests/test_redis_coordination.py \
  tests/test_failover_executor.py \
  tests/test_sbc_service_boundary.py \
  tests/test_vacuum_health.py

cd ../ionbeam-web/backend
npm test

cd ../frontend
npm test
npm run build
```

## 2. Provision integration credentials

Generate the executor-to-SBC secret without pasting it into source control:

```bash
umask 077
openssl rand -hex 32 > /tmp/sbc-vacuum-token
```

Install `/tmp/sbc-vacuum-token` as:

- `SBC_VACUUM_TOKEN` on every executor;
- `SBC_VACUUM_TOKEN` on the SBC vacuum service.

After securely installing the values, remove the temporary files:

```bash
shred -u /tmp/sbc-vacuum-token
```

Do not print the secret in logs, shell history, screenshots, or test reports.

## 3. Start the software path

Start in dependency order:

1. Redis and Sentinel.
2. SBC vacuum service.
3. Vacuum executor or active/standby executors.
4. Ionbeam web backend.
5. Frontend.

For systemd deployments:

```bash
sudo systemctl restart sbc-vacuum.service
sudo systemctl restart vacuum-executor.service
systemctl --user restart ionbeam-backend.service
```

Use the actual installed backend unit name if it differs. Check rather than
guessing:

```bash
systemctl --user list-units --type=service | rg 'ionbeam|vacuum'
sudo systemctl list-units --type=service | rg 'vacuum|redis'
```

## 4. Health and ownership checks

Check the unauthenticated health endpoints:

```bash
curl -fsS http://127.0.0.1:8766/health/live
curl -fsS http://127.0.0.1:8766/health/ready
curl -fsS http://127.0.0.1:8780/health/live
curl -fsS http://127.0.0.1:8780/health/ready
curl -fsS http://127.0.0.1:8780/status
```

Expected results:

- SBC health is HTTP 200, connected, and running.
- Executor state is `active` on exactly one node.
- Other executor nodes are `standby`.
- The active executor has a positive fencing token and `sbc_acquired=true`.
- No executor reports `fenced` or `faulted`.

## 5. User authorization test

Open the application in a private browser window before signing in. A request
to `/api/vacuum` should return HTTP 401. Sign in with an active account and
open the vacuum dashboard; the request should succeed.

In browser developer tools confirm:

- browser requests carry `X-Iobeam-Auth`;
- inactive or expired accounts receive HTTP 403 or 401.

## 6. Functional simulation test

1. Open the vacuum dashboard.
2. Confirm the mechanical pump is powered and cannot be disabled manually.
3. Confirm runtime and readback values update once per second.
4. Enable the mechanical-pump simulated readback.
5. Confirm the turbo stage starts only after the mechanical stage is ready.
6. Enable the turbo simulated readback.
7. Confirm both UH pumps energize as one grouped stage.
8. Enable both UH readbacks and confirm `isVacuumSystemReady=true`.
9. Confirm scan controls are disabled whenever vacuum readiness is false.

Record the status after each step:

```bash
curl -fsS -H 'X-Iobeam-Auth: <temporary-user-session-token>' \
  http://127.0.0.1:4000/api/vacuum
```

Use a temporary integration account/token and do not place it in the guide or
shell scripts committed to the repository.

## 7. Dashboard lifecycle regression

With the vacuum cascade running:

1. Note the executor fencing token and SBC runtime.
2. Minimize and restore the vacuum dashboard.
3. Open, minimize, and restore the sample-stage dashboard.
4. Navigate between Control and Report.
5. Recheck executor and SBC status.

Expected results:

- no `/vacuum/acquire` or `/vacuum/release` request originates from the browser;
- the fencing token does not change;
- SBC runtime does not reset;
- pump outputs and cascade progress are preserved;
- only the elected executor owns acquire/release lifecycle.

## 8. Failover test

Perform this only with two executors and at least three Sentinels.

1. Confirm exactly one executor is active.
2. Stop or isolate the active executor.
3. Confirm its admission closes immediately and its lease expires.
4. Confirm the standby receives a strictly newer fencing token.
5. Confirm the SBC rejects a request carrying the old token.
6. Confirm the new leader reconciles SBC status before accepting commands.
7. Restore the old executor and confirm it returns as standby without
   pre-empting the new leader.

Do not simulate a partition by disabling fencing on either service.

## 9. Pass criteria

The integration iteration passes only when:

- every automated test passes;
- expired/inactive user tokens cannot use `/api/vacuum/*`;
- exactly one executor may mutate the SBC;
- unsafe executor and disconnected SBC states return unready;
- cascade order matches the functional test;
- dashboard navigation never resets the controller;
- no executor-to-SBC secret appears in browser responses or logs.

Keep `Simulate=true` after this test. Real GPIO commissioning is a separate,
hardware-supervised procedure described in `sbc-regression-test.md`.
