# Vacuum emulator verification — 2026-10-07

## Reproduced failures

A 180-second emulator run with continuous synchronous inspection reproduced a control-loop keep-alive fault at approximately 65 seconds. The largest measured interval between poll starts was 3.923 seconds, exceeding the configured three-second watchdog interval. Emulator inspection and operator handlers acquired the rig's thread lock directly on the asynchronous controller event loop.

A regression test holds an inspection open and verifies that an independent health request still completes before inspection is released. Restoring the old blocking endpoint in memory made that test fail. The final implementation passes this check for all five emulator read/operator endpoints.

Executor release followed by service shutdown also reproduced `[Errno 121] Remote I/O error`: the second close wrote to the I2C expanders while they were already held in reset. Restoring the old close condition in memory reproduced that exact error. The new regression verifies repeated close, safe outputs, and subsequent restart.

## Final changes

- Run emulator inspection and operator handlers in FastAPI's worker pool so rig-lock waits do not block controller polling or lease renewals.
- Write shutdown output latches only while the board is open; repeated close remains safe.
- Clean up the emulator and controller holder even when startup or shutdown raises an exception.
- Enable Configuration Update when settings are unchanged, and reset services after a valid unchanged save. Persisted production-mode changes continue to reset services when saved.

The earlier candidate that refreshed the watchdog during ADC sweeps was removed. Watchdog timeout and trip behavior remain unchanged.

## Final verification

All 141 related Python tests, 39 backend tests, and 113 frontend tests passed. Both TypeScript checks passed.

The backend HTTP integration test uses temporary configuration and a harmless restart counter. It verifies six consecutive saves across production-mode changes, unchanged configurations, and vacuum activation changes. Invalid saves neither persist changes nor request a restart. Separate reset-script tests verify that Glasgow, the SBC controller, and the vacuum executor are all attempted, including when SBC startup fails.

The final source also passed three 200-second lifecycles through the actual SBC HTTP application at configured emulator speed 20. Each cycle continuously requested `/emulator` and `/vacuum`, completed pump-down, stayed ready, and released control before lifespan shutdown. The first cycle overlapped the regression suites. No watchdog faults, stale-reading errors, cascade trips, or shutdown errors occurred.

| Cycle | Wall seconds | Poll updates observed | Ready after seconds | Largest observed poll-update gap, seconds | Faults |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 200.100 | 193 | 18.519 | 2.587 | 0 |
| 2 | 200.039 | 196 | 17.472 | 1.278 | 0 |
| 3 | 200.138 | 196 | 17.381 | 1.635 | 0 |

These poll-update gaps are measured by the HTTP observer; they are not hard timing guarantees. This verifies the emulator in the test environment. Physical SBC operation and the running deployment were not exercised or changed.

## Repeat the sustained check

From the Operations workspace:

```bash
cd Development/glasgow_service
PYTHONPATH=. ../../.venv/bin/python scripts/verify-vacuum-emulator.py   --seconds 200 --cycles 3 --output /tmp/vacuum-http-soak-results.json
```

The script creates a temporary profile, forces `IsProduction=false`, and uses the local in-process HTTP application. It does not reset deployed services or change saved application configuration.
