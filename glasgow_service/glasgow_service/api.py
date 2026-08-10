"""FastAPI app exposing the Glasgow service over REST + WebSocket.

Run:
    uvicorn glasgow_service.api:app --host 127.0.0.1 --port 8765

Swagger UI:   http://127.0.0.1:8765/docs
ReDoc:        http://127.0.0.1:8765/redoc
OpenAPI JSON: http://127.0.0.1:8765/openapi.json
"""
import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, Header, Query, WebSocket, WebSocketDisconnect
from typing import Literal

from .service import DeviceService, DeviceBusy, DeviceNotReady
from .models  import (
    RasterRequest, VectorRequest, ScanResult, ServiceStatus,
    VacuumAcquireRequest, VacuumPowerRequest, VacuumSimulationReadRequest, VacuumSystemStatus,
)
from .auth    import require_token
from .config  import find_config_path
from .service import LOG_NAME
from .execution_authority import AuthorityDenied, remote_authority_from_environment
from AutomationPy.buildingblocks.automation_log import AutomationLog
from .vacuum import (
    VacuumController,
    find_vacuum_config_path,
    load_vacuum_config,
    vacuum_config_enabled,
)

svc: "DeviceService | None" = None
vacuum: "VacuumController | None" = None
vacuum_lifecycle_lock = asyncio.Lock()

logger      = AutomationLog.GetLogger(LOG_NAME)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global svc, vacuum
    config_path = find_config_path()
    logger.info("Glasgow config: %s", config_path)
    svc = DeviceService(str(config_path))
    await svc.start()
    legacy_vacuum_enabled = os.environ.get(
        "ENABLE_LEGACY_GLASGOW_VACUUM_API", "false"
    ).strip().lower() in {"1", "true", "yes", "on"}
    vacuum_config = None
    if legacy_vacuum_enabled:
        vacuum_path = find_vacuum_config_path()
        logger.warning("Legacy Glasgow vacuum API enabled with config: %s", vacuum_path)
        vacuum_config = (
            load_vacuum_config(vacuum_path)
            if vacuum_config_enabled(vacuum_path) else None
        )
    if vacuum_config is not None and vacuum_config.enabled:
        vacuum = VacuumController(
            vacuum_config,
            authority=remote_authority_from_environment(),
        )
        # Enablement is an operational request to run the controller, not
        # merely to expose its REST endpoints. Start it during service
        # startup when it is not already ready; ``start()`` is idempotent,
        # so later dashboard acquire requests remain safe.
        if not vacuum.requires_remote_authority and not vacuum.status().isVacuumSystemReady:
            try:
                if vacuum.requires_device:
                    await svc.acquire_exclusive("vacuum")
                await vacuum.start()
                logger.info("Vacuum controller started automatically at service startup")
            except Exception as exc:
                logger.exception("Vacuum controller automatic startup failed: %s", exc)
                await vacuum.close()
                if vacuum.requires_device:
                    try:
                        await svc.release_exclusive("vacuum")
                    except Exception:
                        logger.exception("Failed to release Glasgow after vacuum startup failure")
    else:
        vacuum = None
        logger.info(
            "Vacuum control is delegated to sbc_vacuum_app; legacy API enabled=%s",
            legacy_vacuum_enabled,
        )
    try:
        yield
    finally:
        if vacuum is not None:
            await vacuum.close()
            if vacuum.requires_device:
                await svc.release_exclusive("vacuum")
        await svc.stop()


app = FastAPI(
    title="Glasgow Device Service",
    version="0.3.0",
    description=(
        "Long-lived HTTP/WebSocket interface to a single Glasgow device.\n\n"
        "**Concurrency:** one scan at a time. Concurrent requests return 409.\n\n"
        "**Blocking REST endpoints** (`/scan/raster/run`, `/scan/vector/run`) buffer all "
        "chunks and run the same validation checks as the stand-alone pytest wet-run tests. "
        "Use these when you care about the validation report.\n\n"
        "**WebSocket endpoints** (`/scan/raster/stream`, `/scan/vector/stream`) stream chunks "
        "live; validate flag is ignored there.\n\n"
        "**Last-scan downloads** (`/scan/last/csv`, `/scan/last/figure`) serve the most "
        "recently completed scan as a CSV or matplotlib PNG. Both blocking and streaming "
        "scans populate the cache."
    ),
    lifespan=lifespan,
    openapi_tags=[
        {"name": "status", "description": "Service health, configuration defaults."},
        {"name": "scan",   "description": "Raster and vector scan execution, last-scan downloads."},
        {"name": "admin",  "description": "Lifecycle: reconnect the device."},
        {"name": "vacuum", "description": "Vacuum pump GPIO status and control."},
    ],
)


# ---------- status ---------------------------------------------------------

@app.get("/status", response_model=ServiceStatus, tags=["status"],
         summary="Current device state")
async def get_status():
    return svc.status().model_copy(update={"vacuum_enabled": vacuum is not None})


@app.get("/defaults", tags=["status"],
         summary="Default scan parameters from streamData.json")
async def get_defaults():
    return svc.defaults()


# ---------- vacuum --------------------------------------------------------

def require_vacuum_controller() -> VacuumController:
    if vacuum is None:
        raise HTTPException(404, "vacuum controller is disabled")
    return vacuum


async def require_vacuum_execution_permit(
    x_executor_id: str | None = Header(None, alias="X-Executor-ID"),
    x_fencing_token: int | None = Header(None, alias="X-Fencing-Token"),
    x_lease_valid_for_ms: int | None = Header(None, alias="X-Lease-Valid-For-Ms"),
) -> None:
    controller = require_vacuum_controller()
    if not controller.requires_remote_authority:
        return
    if (
        not x_executor_id
        or x_fencing_token is None
        or x_lease_valid_for_ms is None
    ):
        raise HTTPException(
            428,
            "fenced vacuum mutation requires X-Executor-ID, X-Fencing-Token, "
            "and X-Lease-Valid-For-Ms",
        )
    try:
        controller.accept_remote_authority(
            x_executor_id,
            x_fencing_token,
            x_lease_valid_for_ms / 1000.0,
        )
    except (AuthorityDenied, ValueError) as exc:
        raise HTTPException(409, str(exc))

@app.get("/vacuum", response_model=VacuumSystemStatus, tags=["vacuum"],
         summary="Current vacuum GPIO state")
async def get_vacuum():
    return require_vacuum_controller().status()


@app.post("/vacuum/acquire", response_model=VacuumSystemStatus, tags=["vacuum"],
          summary="Acquire vacuum control and apply expected channel values",
          dependencies=[Depends(require_token), Depends(require_vacuum_execution_permit)])
async def acquire_vacuum(req: VacuumAcquireRequest | None = None):
    controller = require_vacuum_controller()
    async with vacuum_lifecycle_lock:
        try:
            if req is not None:
                controller.configure_expected_channels(req.expected_channels)
            if controller.requires_device:
                await svc.acquire_exclusive("vacuum")
            await controller.start()
        except DeviceBusy as exc:
            raise HTTPException(409, str(exc))
        except AuthorityDenied as exc:
            raise HTTPException(409, str(exc))
        except Exception as exc:
            await controller.close()
            if controller.requires_device:
                await svc.release_exclusive("vacuum")
            raise HTTPException(503, str(exc))
        return controller.status()


@app.post("/vacuum/release", response_model=VacuumSystemStatus, tags=["vacuum"],
          summary="Release the Glasgow device back to the scan service",
          dependencies=[Depends(require_token), Depends(require_vacuum_execution_permit)])
async def release_vacuum():
    controller = require_vacuum_controller()
    async with vacuum_lifecycle_lock:
        await controller.close()
        if controller.requires_device:
            try:
                await svc.release_exclusive("vacuum")
            except DeviceBusy as exc:
                raise HTTPException(409, str(exc))
        return controller.status()


@app.post("/vacuum/pumps/{name}/power", response_model=VacuumSystemStatus,
          tags=["vacuum"], summary="Set one vacuum pump power output",
          dependencies=[Depends(require_token), Depends(require_vacuum_execution_permit)])
async def set_vacuum_power(name: str, req: VacuumPowerRequest):
    controller = require_vacuum_controller()
    if not controller.status().running:
        raise HTTPException(409, "vacuum dashboard has not acquired the Glasgow device")
    try:
        await controller.set_power(name, req.power)
    except KeyError:
        raise HTTPException(404, f"unknown vacuum pump: {name}")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    except AuthorityDenied as exc:
        raise HTTPException(409, str(exc))
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))
    return controller.status()


@app.post("/vacuum/pumps/{name}/read", response_model=VacuumSystemStatus,
          tags=["vacuum"], summary="Set a simulated vacuum threshold readback",
          dependencies=[Depends(require_token), Depends(require_vacuum_execution_permit)])
async def set_vacuum_simulation_read(name: str, req: VacuumSimulationReadRequest):
    controller = require_vacuum_controller()
    if not controller.status().running:
        raise HTTPException(409, "vacuum dashboard has not acquired the Glasgow device")
    try:
        await controller.set_simulated_read(name, req.checked)
    except KeyError:
        raise HTTPException(404, f"unknown vacuum pump: {name}")
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    except AuthorityDenied as exc:
        raise HTTPException(409, str(exc))
    return controller.status()


@app.post("/vacuum/stop", response_model=VacuumSystemStatus, tags=["vacuum"],
          summary="Stop all vacuum pumps except MechanicalVacuumPump",
          dependencies=[Depends(require_token), Depends(require_vacuum_execution_permit)])
async def stop_vacuum():
    controller = require_vacuum_controller()
    if not controller.status().running:
        raise HTTPException(409, "vacuum dashboard has not acquired the Glasgow device")
    try:
        await controller.stop_non_mechanical()
    except AuthorityDenied as exc:
        raise HTTPException(409, str(exc))
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))
    return controller.status()


@app.post("/vacuum/leadership/renew", response_model=VacuumSystemStatus,
          tags=["vacuum"], summary="Renew the active executor fencing window",
          dependencies=[Depends(require_token), Depends(require_vacuum_execution_permit)])
async def renew_vacuum_leadership():
    return require_vacuum_controller().status()


# ---------- raster ---------------------------------------------------------

@app.post(
    "/scan/raster/run",
    response_model=ScanResult,
    tags=["scan"],
    summary="Run one raster scan (blocking); returns timing and validation report",
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
    The validate flag in the request is ignored here; the live stream is
    cached for /scan/last/* downloads."""
    await _stream_scan(ws, lambda p: svc.raster_scan(RasterRequest(**p)))


# ---------- vector ---------------------------------------------------------

@app.post(
    "/scan/vector/run",
    response_model=ScanResult,
    tags=["scan"],
    summary="Run one vector scan (blocking); returns timing and validation report",
    description=(
        "`pattern=default` generates the selected production `scan_path` at `vector_resolution` with the requested `dwell`.\n\n"
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


# ---------- last-scan downloads -------------------------------------------

from fastapi import Response


@app.get("/scan/last/meta", tags=["scan"],
         summary="Metadata for the last completed scan (chunks, kind, source)")
async def get_last_meta():
    """Returns null if nothing has been scanned yet. The browser uses
    this to decide whether to enable the download buttons."""
    return svc.last_meta()


@app.get("/scan/last/csv", tags=["scan"],
        summary="Download the last scan as CSV (space-delimited uint16)",
        responses={
            404: {"description": "No scan data cached"},
        })
async def get_last_csv():
    if not svc.has_last():
        raise HTTPException(404, "no scan data cached")
    body = svc.last_csv_bytes()
    fname = svc.last_csv_filename()
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@app.get("/scan/last/figure", tags=["scan"],
        summary="Download the last scan as a publication-quality PNG figure",
        responses={
            404: {"description": "No scan data cached"},
            500: {"description": "matplotlib not installed or render failed"},
        })
async def get_last_figure(
    render: Literal["native", "decimated"] = Query(
        "decimated",
        description=(
            "Vector-scan render mode. 'decimated' draws an edge x edge image "
            "(dense, fills the canvas). 'native' draws a 2048x2048 image "
            "with stride block-fill so pixel coordinates equal DAC codes. "
            "Raster scans ignore this parameter."
        ),
    ),
    view: Literal["figure", "texture"] = Query(
        "figure",
        description=(
            "'figure' includes matplotlib title/axes/colorbar. 'texture' "
            "returns only the scan image pixels, intended for the live UI panel."
        ),
    ),
):
    if not svc.has_last():
        raise HTTPException(404, "no scan data cached")
    try:
        body = svc.last_figure_png(render_mode=render, view=view)
    except ModuleNotFoundError as e:
        raise HTTPException(500, f"figure rendering needs matplotlib + numpy: {e}")
    fname = svc.last_figure_filename()
    return Response(
        content=body,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


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
