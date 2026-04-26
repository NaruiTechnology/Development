"""FastAPI app exposing the Glasgow service over REST + WebSocket.

Run:
    uvicorn glasgow_service.api:app --host 127.0.0.1 --port 8765

Swagger UI:   http://127.0.0.1:8765/docs
ReDoc:        http://127.0.0.1:8765/redoc
OpenAPI JSON: http://127.0.0.1:8765/openapi.json
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, WebSocket, WebSocketDisconnect

from .service import DeviceService, DeviceBusy, DeviceNotReady
from .models  import (
    RasterRequest, VectorRequest, ScanResult, ServiceStatus,
)
from .auth    import require_token
from .config  import find_config_path
from .service import LOG_NAME
from AutomationPy.buildingblocks.automation_log import AutomationLog

svc: "DeviceService | None" = None

logger      = AutomationLog.GetLogger(LOG_NAME)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global svc
    config_path = find_config_path()
    logger.info("Glasgow config: %s", config_path)
    svc = DeviceService(str(config_path))
    await svc.start()
    try:
        yield
    finally:
        await svc.stop()


app = FastAPI(
    title="Glasgow Device Service",
    version="0.2.0",
    description=(
        "Long-lived HTTP/WebSocket interface to a single Glasgow device.\n\n"
        "**Concurrency:** one scan at a time. Concurrent requests return 409.\n\n"
        "**Blocking REST endpoints** (`/scan/raster/run`, `/scan/vector/run`) buffer all "
        "chunks, optionally save CSV, and run the same validation checks as the stand-alone "
        "pytest wet-run tests. Use these when you care about the validation report.\n\n"
        "**WebSocket endpoints** (`/scan/raster/stream`, `/scan/vector/stream`) stream chunks "
        "live; CSV/validation flags are ignored there."
    ),
    lifespan=lifespan,
    openapi_tags=[
        {"name": "status", "description": "Service health, configuration defaults."},
        {"name": "scan",   "description": "Raster and vector scan execution."},
        {"name": "admin",  "description": "Lifecycle: reconnect the device."},
    ],
)


# ---------- status ---------------------------------------------------------

@app.get("/status", response_model=ServiceStatus, tags=["status"],
         summary="Current device state")
async def get_status():
    return svc.status()


@app.get("/defaults", tags=["status"],
         summary="Default scan parameters from streamData.json")
async def get_defaults():
    return svc.defaults()


# ---------- raster ---------------------------------------------------------

@app.post(
    "/scan/raster/run",
    response_model=ScanResult,
    tags=["scan"],
    summary="Run one raster scan (blocking); returns timing, CSV path, validation report",
    responses={
        409: {"description": "Device busy — another scan is running"},
        503: {"description": "Device not ready (disconnected or error state)"},
    },
    dependencies=[Depends(require_token)],
)
async def run_raster(req: RasterRequest):
    try:
        return await svc.run_raster(req)
    except DeviceBusy:
        raise HTTPException(409, "device busy")
    except DeviceNotReady as e:
        raise HTTPException(503, str(e))


@app.websocket("/scan/raster/stream")
async def stream_raster(ws: WebSocket):
    """Client sends RasterRequest as JSON, then receives binary chunk frames,
    terminated by `{"event":"done","chunks":N}` or an error event.
    CSV/validate flags in the request are ignored here."""
    await _stream_scan(ws, lambda p: svc.raster_scan(RasterRequest(**p)))


# ---------- vector ---------------------------------------------------------

@app.post(
    "/scan/vector/run",
    response_model=ScanResult,
    tags=["scan"],
    summary="Run one vector scan (blocking); returns timing, CSV path, validation report",
    description=(
        "`pattern=default` generates the built-in 2048x2048 sweep with dwell=1.\n\n"
        "`pattern=custom` consumes the `points` array (capped at 1M points per request).\n\n"
        "`pre_process=true` calls `_pre_process_chunks` before transfer and times it "
        "separately — matches the timing breakdown in your wet-run test."
    ),
    responses={
        400: {"description": "Invalid request (e.g. pattern=custom with no points)"},
        409: {"description": "Device busy"},
        503: {"description": "Device not ready"},
    },
    dependencies=[Depends(require_token)],
)
async def run_vector(req: VectorRequest):
    try:
        return await svc.run_vector(req)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except DeviceBusy:
        raise HTTPException(409, "device busy")
    except DeviceNotReady as e:
        raise HTTPException(503, str(e))


@app.websocket("/scan/vector/stream")
async def stream_vector(ws: WebSocket):
    await _stream_scan(ws, lambda p: svc.vector_scan(VectorRequest(**p)))


# ---------- admin ----------------------------------------------------------

@app.post("/admin/reconnect", tags=["admin"],
          summary="Drop and re-establish the USB connection",
          dependencies=[Depends(require_token)])
async def reconnect():
    await svc.reconnect()
    return svc.status()


# ---------- shared WS plumbing --------------------------------------------

async def _stream_scan(ws: WebSocket, make_gen):
    await ws.accept()
    gen = None
    chunks = 0
    try:
        payload = await ws.receive_json()
        gen = make_gen(payload)
        async for chunk in gen:
            await ws.send_bytes(chunk)
            chunks += 1
        await ws.send_json({"event": "done", "chunks": chunks})
    except DeviceBusy:
        await ws.send_json({"event": "error", "code": "busy"})
    except DeviceNotReady as e:
        await ws.send_json({"event": "error", "code": "not_ready", "detail": str(e)})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception("stream error")
        try: await ws.send_json({"event": "error", "message": repr(e)})
        except Exception: pass
    finally:
        if gen is not None:
            await gen.aclose()
        try: await ws.close()
        except Exception: pass
