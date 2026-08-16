"""Bind leader-election progress to SBC fencing-window heartbeats."""
from __future__ import annotations

import asyncio
import logging

from .executor_lifecycle import ExecutorState
from .failover_executor import FailoverExecutor
from .sbc_client import SbcClientError, SbcVacuumClient


class VacuumFailoverRuntime:
    def __init__(
        self,
        executor: FailoverExecutor,
        sbc: SbcVacuumClient,
    ) -> None:
        if sbc.executor is not executor:
            raise ValueError("SBC client and runtime must use the same executor")
        self.executor = executor
        self.sbc = sbc
        self._acquired_token: int | None = None
        self.last_error: str | None = None
        self.logger = logging.getLogger(__name__)

    def status(self) -> dict[str, object]:
        lease = self.executor.lease
        return {
            "state": self.executor.lifecycle.state.value,
            "active": self.executor.may_execute,
            "fencing_token": lease.fencing_token if lease else None,
            "sbc_acquired": self._acquired_token is not None,
            "last_error": self.last_error,
        }

    def require_active(self) -> None:
        if not self.executor.may_execute or self._acquired_token is None:
            raise RuntimeError("this executor is not the active SBC controller")

    async def sbc_status(self) -> dict[str, object]:
        return await self.sbc.status()

    async def acquire(
        self, expected_channels: dict[str, float] | None = None
    ) -> dict[str, object]:
        self.require_active()
        return await self.sbc.acquire(expected_channels)

    async def set_power(self, pump_name: str, power: bool) -> dict[str, object]:
        self.require_active()
        return await self.sbc.set_power(pump_name, power)

    async def set_high_voltage_power(self, power: bool) -> dict[str, object]:
        self.require_active()
        return await self.sbc.set_high_voltage_power(power)

    async def stop_vacuum(self) -> dict[str, object]:
        self.require_active()
        return await self.sbc.stop()

    async def resume_vacuum(self) -> dict[str, object]:
        self.require_active()
        return await self.sbc.resume()

    async def release_vacuum(self) -> dict[str, object]:
        self.require_active()
        result = await self.sbc.release()
        self._acquired_token = None
        return result

    async def step(self) -> None:
        await self.executor.step()
        if not self.executor.may_execute or self.executor.lease is None:
            self._acquired_token = None
            return
        try:
            token = self.executor.lease.fencing_token
            if token != self._acquired_token:
                await self.sbc.acquire()
                self._acquired_token = token
            else:
                await self.sbc.renew_leadership()
        except SbcClientError:
            self.last_error = "SBC lease or hardware request failed"
            self.logger.exception("SBC downstream safety fault", extra={"event": "fence"})
            self.executor.fence()
            self._acquired_token = None

    async def run(self, stop_event: asyncio.Event) -> None:
        await self.executor.start()
        try:
            while not stop_event.is_set():
                await self.step()
                try:
                    await asyncio.wait_for(
                        stop_event.wait(), timeout=self.executor.poll_interval
                    )
                except asyncio.TimeoutError:
                    pass
        finally:
            await self.stop()

    async def stop(self) -> None:
        if (
            self.executor.lifecycle.state is ExecutorState.ACTIVE
            and self.executor.may_execute
            and self._acquired_token is not None
        ):
            try:
                await self.sbc.release()
            except SbcClientError:
                pass
        await self.executor.stop()
        await self.sbc.close()
        self._acquired_token = None
