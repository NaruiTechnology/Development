# Scan and vacuum service boundaries

## Production services

| Service | Process | Responsibility | Hardware ownership |
|---|---|---|---|
| Scan service | `glasgow_service.api` | Raster/vector scan REST and WebSocket APIs | Primary scan Glasgow only |
| Vacuum executor | `glasgow_service.vacuum_executor_app` | Redis lease election, fencing, command forwarding | None |
| SBC vacuum service | `glasgow_service.sbc_vacuum_app` | Vacuum configuration, simulation, status, and GPIO operations | Raspberry Pi BCM GPIO |
| Web backend | `ionbeam-web/backend` | Browser authentication and API routing | None |

The scan service has no vacuum routes, vacuum lifecycle hooks, GPIO adapter, or
vacuum USB reservation mechanism. Restarting it cannot reset or otherwise alter
the vacuum process.

## Configuration ownership

The SBC owns `vacuumSystem.json`. The required sections are:

- `VacuumPumps`
- `SBC`
- `Simulate` and `Enable`
- comparator tolerance and optional descriptive messages

The scan service separately owns `streamData.json`. Updating scan configuration
must not restart, release, or reconfigure SBC GPIO.

## Network contracts

The standalone baseline sends `/api/vacuum/*` directly to the SBC through
`VACUUM_CONTROLLER_URL`; it does not require an executor. In an optional
failover deployment, the executor sends fenced requests to `VACUUM_SBC_URL`.
The SBC authenticates mutations with
`SBC_VACUUM_TOKEN` and persists fencing state at `SBC_FENCING_STATE` when
`SBC_REQUIRE_FENCING=true`.

The REST contract is independent of the physical link. It can run over wired
Ethernet or a USB Ethernet link without changing application code.

## Removed vacuum hardware path

Vacuum applet/subtarget sources and the scan-service vacuum adapter have been
removed. Vacuum hardware commands can reach only the SBC API and Raspberry Pi
GPIO implementation. The scan Glasgow remains dedicated to raster/vector scan
operations; the separately configured stage Glasgow remains dedicated to stage
motion.
