"""Bind leader-election progress to SBC fencing-window heartbeats."""
from __future__ import annotations

import asyncio
import logging

from .executor_lifecycle import ExecutorState
from .failover_executor import FailoverExecutor
from .sbc_client import SbcClientError, SbcControllerDisabled, SbcVacuumClient


class VacuumFailoverRuntime:
    def __init__(
        self,
        executor: FailoverExecutor,
        sbc: SbcVacuumClient,
        *,
        release_on_stop: bool = False,
    ) -> None:
        if sbc.executor is not executor:
            raise ValueError("SBC client and runtime must use the same executor")
        self.executor = executor
        self.sbc = sbc
        #: ``POST /vacuum/release`` powers the whole system down (every
        #: output off, expanders held in reset).  By default a stopping
        #: executor only lets its lease lapse, so a restart, deploy or
        #: hand-over to the standby keeps the vacuum up; the SBC interlocks
        #: keep acting on their own while no executor holds a lease.
        self.release_on_stop = release_on_stop
        self._acquired_token: int | None = None
        self.last_error: str | None = None
        #: Monotonic time before which a disabled SBC is not asked again.
        self._disabled_until: float | None = None
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

    #: How often to look again at an SBC whose vacuum control is disabled.
    DISABLED_RETRY_SECONDS = 30.0

    async def step(self) -> None:
        await self.executor.step()
        if not self.executor.may_execute or self.executor.lease is None:
            self._acquired_token = None
            return
        now = self.sbc.clock.now()
        if self._disabled_until is not None and now < self._disabled_until:
            return
        try:
            token = self.executor.lease.fencing_token
            if token != self._acquired_token:
                await self.sbc.acquire()
                self._acquired_token = token
            else:
                status = await self.sbc.renew_leadership()
                if isinstance(status, dict) and status.get("running") is False:
                    # The SBC process restarted (or was released) under the
                    # same term: with fencing on it waits for an executor to
                    # start the controller, so start it again.
                    self.logger.warning(
                        "SBC controller is not running; re-acquiring",
                        extra={"event": "reacquire"})
                    await self.sbc.acquire()
            if self._disabled_until is not None:
                self.logger.info("SBC vacuum control is enabled again; acquired",
                                 extra={"event": "sbc_enabled"})
                self._disabled_until = None
                self.last_error = None
        except SbcControllerDisabled:
            # The SBC owns this decision: wait quietly, do not fence.
            if self._disabled_until is None:
                self.logger.warning(
                    "SBC vacuum control is disabled (Enable: false in the SBC profile); "
                    "the executor stays idle and checks again every %.0f s",
                    self.DISABLED_RETRY_SECONDS, extra={"event": "sbc_disabled"})
            self.last_error = "SBC vacuum control is disabled"
            self._acquired_token = None
            self._disabled_until = now + self.DISABLED_RETRY_SECONDS
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
            self.release_on_stop
            and self.executor.lifecycle.state is ExecutorState.ACTIVE
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
