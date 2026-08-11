"""Uvicorn entry point for the always-on active/standby executor."""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, HTTPException

from .executor_config import ExecutorConfig
from .executor_logging import configure_logging
from .failover_executor import FailoverExecutor
from .sbc_client import SbcClientError, SbcVacuumClient
from .redis_coordination import RedisSentinelLeaseCoordinator
from .vacuum_failover_runtime import VacuumFailoverRuntime
from .vacuum_health import executor_state_is_ready


def create_app() -> FastAPI:
    holder: dict[str, object] = {}
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        config = ExecutorConfig.from_environment()
        configure_logging(os.environ.get("VACUUM_LOG_LEVEL", "INFO"))
        coordinator = RedisSentinelLeaseCoordinator.from_sentinel(
            config.redis,
            namespace=config.redis_namespace,
            wait_replicas=config.redis_wait_replicas,
            wait_timeout_ms=config.redis_wait_timeout_ms,
        )
        executor = FailoverExecutor(
            config.instance_id,
            coordinator,
            lease_ttl=config.lease_ttl,
            poll_interval=config.poll_interval,
        )
        client = SbcVacuumClient(
            config.sbc_url, executor, bearer_token=config.sbc_token,
        )
        runtime = VacuumFailoverRuntime(executor, client)
        stop_event = asyncio.Event()
        task = asyncio.create_task(runtime.run(stop_event))
        holder.update(config=config, runtime=runtime, task=task)
        try:
            yield
        finally:
            stop_event.set()
            await task
            holder.clear()

    app = FastAPI(title="Vacuum failover executor", lifespan=lifespan)

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready() -> dict[str, object]:
        runtime = holder.get("runtime")
        if not isinstance(runtime, VacuumFailoverRuntime):
            raise HTTPException(status_code=503, detail="executor is starting")
        status = runtime.status()
        # A fenced executor is alive but cannot safely participate in failover;
        # report it unready so systemd/load monitors surface the dependency fault.
        if not executor_state_is_ready(str(status["state"])):
            raise HTTPException(status_code=503, detail=status)
        return {"status": "ready", **status}

    @app.get("/status")
    async def status() -> dict[str, object]:
        runtime = holder.get("runtime")
        if not isinstance(runtime, VacuumFailoverRuntime):
            return {"status": "starting"}
        config = holder["config"]
        return {"executor_id": config.instance_id, **runtime.status()}

    def active_runtime() -> VacuumFailoverRuntime:
        runtime = holder.get("runtime")
        if not isinstance(runtime, VacuumFailoverRuntime):
            raise HTTPException(status_code=503, detail="executor is starting")
        try:
            runtime.require_active()
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return runtime

    async def forward(operation):
        try:
            return await operation
        except SbcClientError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/vacuum")
    async def vacuum_status() -> dict[str, object]:
        runtime = holder.get("runtime")
        if not isinstance(runtime, VacuumFailoverRuntime):
            raise HTTPException(status_code=503, detail="executor is starting")
        return await forward(runtime.sbc_status())

    @app.post("/vacuum/acquire")
    async def vacuum_acquire(
        payload: dict[str, dict[str, float]] = Body(default_factory=dict),
    ) -> dict[str, object]:
        expected = payload.get("expected_channels", {})
        return await forward(active_runtime().acquire(expected))

    @app.post("/vacuum/pumps/{name}/power")
    async def vacuum_power(name: str, payload: dict[str, bool]) -> dict[str, object]:
        return await forward(active_runtime().set_power(name, bool(payload.get("power"))))

    @app.post("/vacuum/stop")
    async def vacuum_stop() -> dict[str, object]:
        return await forward(active_runtime().stop_vacuum())

    @app.post("/vacuum/resume")
    async def vacuum_resume() -> dict[str, object]:
        return await forward(active_runtime().resume_vacuum())

    @app.post("/vacuum/release")
    async def vacuum_release() -> dict[str, object]:
        return await forward(active_runtime().release_vacuum())

    return app


app = create_app()


def main() -> None:
    import uvicorn
    config = ExecutorConfig.from_environment()
    uvicorn.run(app, host=config.listen_host, port=config.listen_port)


if __name__ == "__main__":
    main()
