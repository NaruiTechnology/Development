# Scan and vacuum service boundaries

## Production services

| Service | Process | Responsibility | Hardware ownership |
|---|---|---|---|
| Scan service | `glasgow_service.api` | Raster/vector scan REST and WebSocket APIs | Primary scan Glasgow only |
| Vacuum executor | `glasgow_service.vacuum_executor_app` | Redis lease election, fencing, command forwarding | None |
| SBC vacuum service | `glasgow_service.sbc_vacuum_app` | Vacuum configuration, simulation, status, and GPIO operations | Raspberry Pi BCM GPIO |
| Web backend | `ionbeam-web/backend` | Browser authentication and API routing | None |

The scan service does not load vacuum configuration by default. Its historical
vacuum routes remain disabled and return 404. `ENABLE_LEGACY_GLASGOW_VACUUM_API=true`
is an explicit compatibility switch only; it must not be set in SBC deployments.

## Configuration ownership

The SBC owns `vacuumSystem.json`. With `Transport=raspberry-pi`, the file does
not require `Glasgow` or `Actions` sections. The required sections are:

- `VacuumPumps`
- `SBC`
- `Transport`, `Simulate`, and `Enable`
- comparator tolerance and optional descriptive messages

The scan service separately owns `streamData.json`. Updating scan configuration
must not restart, release, or reconfigure SBC GPIO.

## Network contracts

The web backend sends `/api/vacuum/*` to `VACUUM_CONTROLLER_URL`. The executor
sends fenced requests to `VACUUM_SBC_URL`. The SBC authenticates mutations with
`SBC_VACUUM_TOKEN` and persists fencing state at `SBC_FENCING_STATE` when
`SBC_REQUIRE_FENCING=true`.

The REST contract is independent of the physical link. It can run over wired
Ethernet or a USB Ethernet link without changing application code.

## Legacy compatibility boundary

`glasgow_client.py` now contains import aliases only; new code imports
`sbc_client.py`. The old Glasgow GPIO adapter remains available solely for
targeted legacy tests and deployments that explicitly select
`Transport=glasgow`. It is lazily imported and is not loaded by the SBC path.
