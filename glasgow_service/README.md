# Glasgow Device Service

A long-lived HTTP/WebSocket interface that keeps one Glasgow device connected
for the lifetime of the process, with Swagger/OpenAPI docs, CSV export,
and chunk-level validation equivalent to the stand-alone pytest wet-run
tests — all integrated with your existing `GlasgowDataIO.IobeamControl`
and `AutomationPy` packages.

## Layout

```
glasgow_service/
├── README.md
├── pyproject.toml
├── requirements.txt
├── glasgow_service/
│   ├── __init__.py
│   ├── models.py     Pydantic schemas (requests + ScanResult + validation)
│   ├── service.py    DeviceService — owns the Glasgow; streaming + blocking APIs
│   ├── auth.py       Bearer-token dependency (opt-in via GLASGOW_TOKEN)
│   └── api.py        FastAPI app
├── tests/
│   └── test_wet_run.py   Pytest replacement for test_scan_wet_run (raster + vector)
├── examples/
│   ├── raster_custom.py  REST client for raster scans, with sweep mode
│   ├── vector_custom.py  REST client for vector scans
│   └── ws_client.py      WebSocket streaming client
└── deploy/
    └── glasgow-svc.service   systemd unit
```

## What the wet-run integration does

`DeviceService` exposes two blocking methods that replicate the behavior of
your `test_scan_wet_run` methods exactly, only as library calls rather than
standalone tests:

- `run_raster(req: RasterRequest) -> ScanResult`
- `run_vector(req: VectorRequest) -> ScanResult`

Each of these:

1. Runs the scan to completion against the live Glasgow.
2. Times the USB transfer (`send_time_s`), and for vector with
   `pre_process=True` also times `_pre_process_chunks` (`process_time_s`).
3. If `save_csv=true`: writes the same CSV your old test wrote (raster →
   `raster_RxR.csv`, one row per raster line; vector →
   `vector_latencyN.csv`, one row per received chunk).
4. If `do_validate=true`: runs the same chunk-count / chunk-size /
   padding-leak checks the old `assertEqual`/`assertNotEqual` blocks ran,
   and returns the results as a structured `ScanValidation` report (not
   exceptions).

The same logic powers the REST endpoints (`/scan/raster/run`,
`/scan/vector/run`) and the pytest suite (`tests/test_wet_run.py`), so
there's one authoritative implementation.

## Install

```powershell
..\.venv\Scripts\python.exe -m pip install -r requirements.txt
# or, from this glasgow_service directory:
..\.venv\Scripts\python.exe -m pip install -e .
```

Your existing `GlasgowDataIO` and `AutomationPy` packages must be importable
in the same environment.

## Run the service on Windows

```powershell
$env:GLASGOW_CONFIG="C:\Project\IobeamTech\Development\GlasgowDataIO\Json\streamData.json"
# Optional: turn on auth
# $env:GLASGOW_TOKEN="replace-me-with-32-bytes-of-hex"

glasgow token: 376e6207faf8425219a652914085bfb394a97582bbd0a8692042d77e8971a9ee
WkgnwuSK0fFCXPmKkQc-ku4BBDpGB9qZeK_2diBgAyk
uuid: f960bbee-8797-4946-aa9b-ed2a70c79203

python -m uvicorn glasgow_service.api:app --host 127.0.0.1 --port 8765 --ws websockets
```

If a stale machine-level `GLASGOW_CONFIG` points to an old checkout, clear it
for the current PowerShell session before starting:

```powershell
Remove-Item Env:\GLASGOW_CONFIG -ErrorAction SilentlyContinue

```

## Run the pytest wet-run suite

The new tests do **not** need the server running — they instantiate
`DeviceService` directly:

```powershell
$env:GLASGOW_CONFIG="C:\Project\IobeamTech\Development\GlasgowDataIO\Json\streamData.json"
python -m pytest tests/test_wet_run.py -s
```

To override specific request fields without editing the test, modify the
`REQUEST_OVERRIDES` dict at the top of each test class. All unspecified
fields fall back to the values in your `streamData.json`.

## Swagger / OpenAPI

Once the server is up:

| URL                                     | What                        |
| --------------------------------------- | --------------------------- |
| http://127.0.0.1:8765/docs              | Swagger UI (Try it out)     |
| http://127.0.0.1:8765/redoc             | ReDoc                       |
| http://127.0.0.1:8765/openapi.json      | Raw OpenAPI 3 schema        |

The `ScanResult` response model is fully documented, so Swagger shows the
validation-report shape, CSV path field, timing fields, etc., with
realistic examples for both scan kinds.

## Endpoints

| Method | Path                      | Returns         | Notes                               |
| ------ | ------------------------- | --------------- | ----------------------------------- |
| GET    | `/status`                 | `ServiceStatus` | Device state, scan counter.         |
| GET    | `/defaults`               | dict            | `rasterScan`/`vectorScan` from JSON.|
| POST   | `/scan/raster/run`        | `ScanResult`    | Wet run + optional CSV + validation.|
| POST   | `/scan/vector/run`        | `ScanResult`    | Wet run + optional CSV + validation.|
| WS     | `/scan/raster/stream`     | binary frames   | Live chunks; ignores save_csv.      |
| WS     | `/scan/vector/stream`     | binary frames   | Live chunks; ignores save_csv.      |
| POST   | `/admin/reconnect`        | `ServiceStatus` | Drop + reopen USB.                  |

## Quick smoke test

```powershell
# Run a raster wet scan with CSV + validation; parse the result
curl.exe -s -X POST http://127.0.0.1:8765/scan/raster/run `
     -H "content-type: application/json" `
     -d '{"resolution":512,"dwell":2,"latency_bytes":16384,
          "save_csv":true,"do_validate":true}'

# Vector wet scan with pre-processing timing
curl.exe -s -X POST http://127.0.0.1:8765/scan/vector/run `
     -H "content-type: application/json" `
     -d '{"pattern":"default","latency_bytes":8196,
          "pre_process":true,"save_csv":true,"do_validate":true}'
```

Both return a `ScanResult` whose `validation.passed` field is `true` on
green, plus per-check breakdown when anything fails.

## Concurrency

One scan at a time. Concurrent REST or WebSocket requests return **HTTP
409** (or an `{"event":"error","code":"busy"}` WebSocket frame).


#-------launch.json for lauanching server debug --------------------

  "version": "0.2.0",
  "configurations": [
    {
      "name": "uvicorn: glasgow_service",
      "type": "debugpy",
      "request": "launch",
      "module": "uvicorn",
      "args": [
        "glasgow_service.api:app",
        "--host", "127.0.0.1",
        "--port", "8765"
      ],
      "env": {
        "GLASGOW_TOKEN": "376e6207faf8425219a652914085bfb394a97582bbd0a8692042d77e8971a9ee",
        "GLASGOW_CONFIG": "C:\\Project\\IobeamTech\\Development\\GlasgowDataIO\\Json\\streamData.json",

        "PYTHONPATH": "${workspaceFolder}:${workspaceFolder}/Development:${env:PYTHONPATH}"
      },
      "justMyCode": false,
      "console": "integratedTerminal"
    }
  ]
}
#------------------------------------------
### Active/standby executor

The optional `vacuum_executor_app` is an always-running active/standby process,
not a scheduler. Run it with `python -m glasgow_service.vacuum_executor_app`.
Production deployment assets are in `deploy/vacuum-executor.service` and
`examples/vacuum-executor.env.example`; use at least three Redis Sentinel
endpoints. Configure the separate Raspberry Pi service with
`examples/sbc-vacuum.env.example` and enable `SBC_REQUIRE_FENCING` there.

The bundled deploy/setup-redis-sentinel.sh helper is for Linux SBC hosts only.
For a Windows POC, run Redis/Sentinel in WSL or a container and set
VACUUM_REDIS_SENTINELS to those reachable endpoints. A single Sentinel with
quorum 1 is suitable only for a smoke test; production needs replicated Redis
plus three or more Sentinel processes on independent nodes.
