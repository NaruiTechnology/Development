"""Standalone Raspberry Pi vacuum-controller HTTP interface.

This process owns BCM GPIO (or the deterministic simulator) and nothing else;
scan/USB traffic remains in glasgow_service. Every mutating route accepts the
same fencing headers used by the active/standby executor.
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException

from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from .execution_authority import AuthorityDenied, remote_authority_from_environment
from .models import (
    VacuumAcquireRequest,
    VacuumPowerRequest,
    VacuumSimulationRequest,
    VacuumSystemStatus,
)
from .vacuum import VacuumController, find_vacuum_config_path, load_vacuum_config
from .vacuum_health import sbc_controller_is_ready


def create_app() -> FastAPI:
    holder: dict[str, VacuumController] = {}
    lock = asyncio.Lock()
    bearer = HTTPBearer(auto_error=False)

    def require_sbc_token(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> None:
        expected = os.environ.get("SBC_VACUUM_TOKEN")
        if expected and (credentials is None or credentials.credentials != expected):
            raise HTTPException(401, "invalid or missing SBC bearer token")

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        config = load_vacuum_config(find_vacuum_config_path())
        if not config.enabled:
            raise RuntimeError("SBC vacuum controller is disabled")
        controller = VacuumController(
            config, authority=remote_authority_from_environment()
        )
        holder["controller"] = controller
        if not controller.requires_remote_authority:
            await controller.start()
        try:
            yield
        finally:
            await controller.close()
            holder.clear()

    app = FastAPI(
        title="Raspberry Pi Vacuum Controller",
        version="1.0.0",
        lifespan=lifespan,
    )

    def controller() -> VacuumController:
        value = holder.get("controller")
        if value is None:
            raise HTTPException(503, "SBC vacuum controller is starting")
        return value

    async def execution_permit(
        x_executor_id: str | None = Header(None, alias="X-Executor-ID"),
        x_fencing_token: int | None = Header(None, alias="X-Fencing-Token"),
        x_lease_valid_for_ms: int | None = Header(None, alias="X-Lease-Valid-For-Ms"),
    ) -> None:
        target = controller()
        if not target.requires_remote_authority:
            return
        if not x_executor_id or x_fencing_token is None or x_lease_valid_for_ms is None:
            raise HTTPException(428, "SBC mutation requires executor fencing headers")
        try:
            target.accept_remote_authority(
                x_executor_id, x_fencing_token, x_lease_valid_for_ms / 1000.0
            )
        except (AuthorityDenied, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc

    mutation_dependencies = [Depends(require_sbc_token), Depends(execution_permit)]

    @app.get("/status")
    async def service_status() -> dict[str, object]:
        target = holder.get("controller")
        status = target.status() if target is not None else None
        return {
            "service": "sbc-vacuum",
            "vacuum_enabled": target is not None,
            "platform": "raspberry-pi",
            "mode": "simulation" if status and status.simulation else "gpio",
            "equipment_count": len(status.pumps) if status else 0,
            "running": status.running if status else False,
        }

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready() -> dict[str, object]:
        target = holder.get("controller")
        if target is None:
            raise HTTPException(503, "SBC vacuum controller is starting")
        status = target.status()
        if not sbc_controller_is_ready(connected=status.connected, running=status.running):
            raise HTTPException(503, "vacuum GPIO controller is disconnected or stopped")
        return {
            "status": "ready",
            "connected": status.connected,
            "equipment_count": len(status.pumps),
        }

    @app.get("/vacuum", response_model=VacuumSystemStatus)
    async def vacuum_status():
        return controller().status()

    @app.post("/vacuum/acquire", response_model=VacuumSystemStatus,
              dependencies=mutation_dependencies)
    async def acquire(req: VacuumAcquireRequest | None = None):
        target = controller()
        async with lock:
            try:
                if req is not None:
                    target.configure_expected_channels(req.expected_channels)
                await target.start()
            except AuthorityDenied as exc:
                raise HTTPException(409, str(exc)) from exc
            except (ValueError, RuntimeError) as exc:
                raise HTTPException(503, str(exc)) from exc
        return target.status()

    @app.post("/vacuum/release", response_model=VacuumSystemStatus,
              dependencies=mutation_dependencies)
    async def release():
        async with lock:
            await controller().close()
        return controller().status()

    @app.post("/vacuum/pumps/{name}/power", response_model=VacuumSystemStatus,
              dependencies=mutation_dependencies)
    async def power(name: str, req: VacuumPowerRequest):
        target = controller()
        try:
            await target.set_power(name, req.power)
        except KeyError as exc:
            raise HTTPException(404, f"unknown vacuum pump: {name}") from exc
        except (AuthorityDenied, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc
        return target.status()

    @app.post("/vacuum/stop", response_model=VacuumSystemStatus,
              dependencies=mutation_dependencies)
    async def stop():
        try:
            await controller().stop_non_mechanical()
        except AuthorityDenied as exc:
            raise HTTPException(409, str(exc)) from exc
        return controller().status()

    @app.post("/vacuum/resume", response_model=VacuumSystemStatus,
              dependencies=mutation_dependencies)
    async def resume():
        try:
            await controller().resume_cascade()
        except AuthorityDenied as exc:
            raise HTTPException(409, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
        return controller().status()

    @app.post("/vacuum/simulation/{name}/ready", response_model=VacuumSystemStatus,
              dependencies=mutation_dependencies)
    async def simulation_ready(name: str, req: VacuumSimulationRequest):
        """Set one simulated comparator; unavailable in GPIO mode."""
        target = controller()
        try:
            await target.set_simulated_read(name, req.ready)
        except KeyError as exc:
            raise HTTPException(404, f"unknown vacuum pump: {name}") from exc
        except (AuthorityDenied, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc
        return target.status()

    @app.post("/vacuum/leadership/renew", response_model=VacuumSystemStatus,
              dependencies=mutation_dependencies)
    async def renew():
        return controller().status()

    return app


app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("SBC_VACUUM_HOST", "0.0.0.0"),
        port=int(os.environ.get("SBC_VACUUM_PORT", "8765")),
    )


if __name__ == "__main__":
    main()
