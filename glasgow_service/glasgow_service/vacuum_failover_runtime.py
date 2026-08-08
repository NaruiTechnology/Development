"""Bind leader-election progress to Glasgow fencing-window heartbeats."""
from __future__ import annotations

import asyncio
import logging

from .executor_lifecycle import ExecutorState
from .failover_executor import FailoverExecutor
from .glasgow_client import GlasgowClientError, GlasgowVacuumClient


class VacuumFailoverRuntime:
    def __init__(
        self,
        executor: FailoverExecutor,
        glasgow: GlasgowVacuumClient,
    ) -> None:
        if glasgow.executor is not executor:
            raise ValueError("Glasgow client and runtime must use the same executor")
        self.executor = executor
        self.glasgow = glasgow
        self._acquired_token: int | None = None
        self.last_error: str | None = None
        self.logger = logging.getLogger(__name__)

    def status(self) -> dict[str, object]:
        lease = self.executor.lease
        return {
            "state": self.executor.lifecycle.state.value,
            "active": self.executor.may_execute,
            "fencing_token": lease.fencing_token if lease else None,
            "glasgow_acquired": self._acquired_token is not None,
            "last_error": self.last_error,
        }

    async def step(self) -> None:
        await self.executor.step()
        if not self.executor.may_execute or self.executor.lease is None:
            self._acquired_token = None
            return
        try:
            token = self.executor.lease.fencing_token
            if token != self._acquired_token:
                await self.glasgow.acquire()
                self._acquired_token = token
            else:
                await self.glasgow.renew_leadership()
        except GlasgowClientError:
            self.last_error = "Glasgow lease or hardware request failed"
            self.logger.exception("Glasgow downstream safety fault", extra={"event": "fence"})
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
                await self.glasgow.release()
            except GlasgowClientError:
                pass
        await self.executor.stop()
        await self.glasgow.close()
        self._acquired_token = None
