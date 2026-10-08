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
from .vacuum import (
    MECHANICAL_PUMP,
    VacuumController,
    find_vacuum_config_path,
    load_runtime_vacuum_config,
)
from .vacuum_health import sbc_controller_is_ready


def create_app(*, config_loader=load_runtime_vacuum_config) -> FastAPI:
    holder: dict[str, VacuumController] = {}
    activation = {"enabled": False}
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
        config = config_loader(find_vacuum_config_path())
        activation["enabled"] = config.enabled
        if not config.enabled:
            yield
            return
        # Enable controls activation; IsProduction selects hardware or emulation.
        controller = VacuumController(
            config, authority=remote_authority_from_environment()
        )
        emulator = controller.emulator
        holder["controller"] = controller
        try:
            if not controller.requires_remote_authority:
                await controller.start()
            yield
        finally:
            try:
                await controller.close()
            finally:
                try:
                    if emulator is not None:
                        emulator.close()
                finally:
                    holder.clear()

    app = FastAPI(
        title="Raspberry Pi Vacuum Controller",
        version="1.0.0",
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def no_cached_controller_state(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    def controller() -> VacuumController:
        value = holder.get("controller")
        if value is None:
            if not activation["enabled"]:
                raise HTTPException(404, "vacuum controller is disabled")
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
        if status is None:
            mode = "disabled" if not activation["enabled"] else "gpio"
        elif status.simulation:
            mode = "simulation"
        elif status.control_transport == "rpi5-vacuum-io-emulator":
            mode = "board-emulator"
        elif status.control_transport == "rpi5-vacuum-io":
            mode = "board"
        else:
            mode = "gpio"
        return {
            "service": "sbc-vacuum",
            "vacuum_enabled": target is not None,
            "platform": "raspberry-pi",
            "mode": mode,
            "is_production": status.is_production if status else None,
            "log_tag": target.log_tag if target is not None else None,
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
            if not activation["enabled"]:
                return {"status": "ready", "vacuum_enabled": False}
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

    @app.post("/vacuum/pumps/{name}/restart", response_model=VacuumSystemStatus,
              dependencies=mutation_dependencies)
    async def restart_pump(name: str, req: dict | None = None):
        """Restart (power-cycle) the backing pump like controller initialization.

        Every other pump stops and every valve closes before this returns;
        the pump comes back ON after ``off_seconds`` (default 3) and the
        cascade restarts.  Only the backing pump can be restarted.
        """
        target = controller()
        names = [p.name for p in target.status().pumps]
        if name not in names:
            raise HTTPException(404, f"unknown vacuum pump: {name}")
        if name != MECHANICAL_PUMP:
            raise HTTPException(409, f"only {MECHANICAL_PUMP} can be restarted")
        try:
            await target.restart_backing_pump((req or {}).get("off_seconds"))
        except (AuthorityDenied, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
        return target.status()

    @app.post("/vacuum/high-voltage/power", response_model=VacuumSystemStatus,
              dependencies=mutation_dependencies)
    async def high_voltage_power(req: VacuumPowerRequest):
        target = controller()
        try:
            await target.set_high_voltage_power(req.power)
        except AuthorityDenied as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
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

    # ---------------------------------------------------------------- emulator
    # Present only in non-production board mode: operator actions on the
    # emulated rig (E-stop, jumpers, faults, utilities) for UI development.

    def rig():
        target = controller()
        if target.emulator is None:
            raise HTTPException(404, "the board emulator is not enabled")
        return target.emulator

    # These handlers take the rig lock. Synchronous FastAPI handlers run in
    # its worker pool, leaving the controller poll/lease loop responsive.
    @app.get("/emulator")
    def emulator_state():
        return rig().snapshot()

    @app.post("/emulator/estop", dependencies=[Depends(require_sbc_token)])
    def emulator_estop(req: dict):
        r = rig()
        r.set_estop(bool(req.get("pressed", True)))
        return r.snapshot()

    @app.post("/emulator/inputs/{di}", dependencies=[Depends(require_sbc_token)])
    def emulator_jumper(di: int, req: dict):
        if not 1 <= di <= 16:
            raise HTTPException(404, "inputs are DI1..DI16")
        r = rig()
        r.jumper(di, bool(req.get("on", True)))
        return r.snapshot()

    @app.post("/emulator/tool", dependencies=[Depends(require_sbc_token)])
    def emulator_tool(req: dict):
        r = rig()
        r.connect_tool(bool(req.get("connected", True)))
        return r.snapshot()

    @app.post("/emulator/excursion/{name}", dependencies=[Depends(require_sbc_token)])
    def emulator_excursion(name: str, req: dict):
        """Pressure excursion on one pump's gauge (test tooling).

        ``{"mbar": 2.5e-3}`` raises and holds it; ``{"release": true}`` lets
        the running pump work it back down (``recovery_s``: emulated time
        constant, default 120 s); ``{"mbar": 0}`` clears it.
        """
        r = rig()
        mbar = req.get("mbar")
        try:
            r.set_excursion(name, None if mbar is None else float(mbar),
                            release=bool(req.get("release", False)),
                            recovery_s=req.get("recovery_s"))
        except KeyError:
            raise HTTPException(404, f"unknown vacuum pump: {name}") from None
        return r.snapshot()

    @app.post("/emulator/faults/{name}", dependencies=[Depends(require_sbc_token)])
    def emulator_fault(name: str, req: dict):
        r = rig()
        active = bool(req.get("active", True))
        with r.clock.lock:
            plant = r.plant
            if name == "MechanicalVacuumPump":
                plant.mechanical.thermal_trip = active
            elif name in {t.name for t in plant.all_turbos}:
                turbo = next(t for t in plant.all_turbos if t.name == name)
                if active:
                    turbo.error = str(req.get("code", "Err001"))
                else:
                    turbo.reset_error()
            elif name in plant.utilities.__dict__:
                setattr(plant.utilities, name, not active)
            elif name == "heartbeat_stuck":
                r.board.faults.stuck_heartbeat = active
            elif name == "i2c_nack":
                r.pi.i2c1.inject_nack(int(req.get("address", 0x21)), int(req.get("count", 1)))
            else:
                raise HTTPException(404, f"unknown emulator fault: {name}")
        return r.snapshot()

    return app


app = create_app()


def configure_service_logging() -> None:
    """Plain text (default) or JSON (``SBC_VACUUM_LOG_FORMAT=json``) logs.

    Every vacuum line carries a mode tag: [VACUUM-HW], [VACUUM-EMU] or
    [VACUUM-SIM].
    """
    import logging

    level = os.environ.get("SBC_VACUUM_LOG_LEVEL", "INFO").upper()
    if os.environ.get("SBC_VACUUM_LOG_FORMAT", "text").lower() == "json":
        from .executor_logging import configure_logging

        configure_logging(level)
    else:
        logging.basicConfig(
            level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def main() -> None:
    import uvicorn

    configure_service_logging()

    uvicorn.run(
        app,
        host=os.environ.get("SBC_VACUUM_HOST", "0.0.0.0"),
        port=int(os.environ.get("SBC_VACUUM_PORT", "8765")),
    )


if __name__ == "__main__":
    main()
