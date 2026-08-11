"""Continuously running active/standby executor orchestration."""
from __future__ import annotations

import asyncio

from .coordination import (
    Clock,
    CoordinatorUnavailable,
    LeadershipLease,
    LeaseCoordinator,
    SystemMonotonicClock,
)
from .executor_lifecycle import ExecutorLifecycle, ExecutorState


class FailoverExecutor:
    """Lease-driven executor shell independent of Redis and vacuum hardware."""

    def __init__(
        self,
        instance_id: str,
        coordinator: LeaseCoordinator,
        *,
        lease_ttl: float = 5.0,
        poll_interval: float = 1.0,
        clock: Clock | None = None,
    ) -> None:
        if not instance_id:
            raise ValueError("instance_id must not be empty")
        if lease_ttl <= 0:
            raise ValueError("lease_ttl must be positive")
        if poll_interval <= 0 or poll_interval >= lease_ttl:
            raise ValueError("poll_interval must be positive and shorter than lease_ttl")
        self.instance_id = instance_id
        self.coordinator = coordinator
        self.lease_ttl = lease_ttl
        self.poll_interval = poll_interval
        self.clock = clock or SystemMonotonicClock()
        self.lifecycle = ExecutorLifecycle()
        self._lease: LeadershipLease | None = None

    @property
    def lease(self) -> LeadershipLease | None:
        return self._lease

    @property
    def may_execute(self) -> bool:
        return (
            self.lifecycle.may_execute
            and self._lease is not None
            and self._lease.is_valid(self.clock.now())
        )

    async def start(self) -> None:
        if self.lifecycle.state is ExecutorState.STARTING:
            self.lifecycle.transition(ExecutorState.STANDBY)

    async def step(self) -> None:
        if self.lifecycle.state is ExecutorState.STARTING:
            await self.start()
        if self.lifecycle.state in {
            ExecutorState.DRAINING,
            ExecutorState.FAULTED,
            ExecutorState.STOPPED,
        }:
            return
        if self.lifecycle.state is ExecutorState.ACTIVE:
            if self._lease is None or not self._lease.is_valid(self.clock.now()):
                self._fence()
                return
            try:
                renewed = await self.coordinator.renew(
                    self.instance_id,
                    self._lease.fencing_token,
                    self.lease_ttl,
                )
            except CoordinatorUnavailable:
                self._fence()
                return
            if renewed is None:
                self._fence()
                return
            self._lease = renewed
            return
        if self.lifecycle.state is ExecutorState.FENCED:
            try:
                acquired = await self.coordinator.acquire(
                    self.instance_id, self.lease_ttl
                )
            except CoordinatorUnavailable:
                return
            self.lifecycle.transition(ExecutorState.STANDBY)
            if acquired is not None:
                self._activate(acquired)
            return
        try:
            acquired = await self.coordinator.acquire(self.instance_id, self.lease_ttl)
        except CoordinatorUnavailable:
            self.lifecycle.transition(ExecutorState.FENCED)
            return
        if acquired is not None:
            self._activate(acquired)

    async def run(self, stop_event: asyncio.Event) -> None:
        await self.start()
        try:
            while not stop_event.is_set():
                await self.step()
                try:
                    await asyncio.wait_for(
                        stop_event.wait(), timeout=self.poll_interval
                    )
                except asyncio.TimeoutError:
                    pass
        finally:
            await self.stop()

    async def stop(self) -> None:
        state = self.lifecycle.state
        if state is ExecutorState.STOPPED:
            return
        if state is ExecutorState.ACTIVE:
            self.lifecycle.transition(ExecutorState.DRAINING)
            lease = self._lease
            if lease is not None:
                try:
                    await self.coordinator.release(
                        self.instance_id, lease.fencing_token
                    )
                except CoordinatorUnavailable:
                    pass
            self._lease = None
            self.lifecycle.transition(ExecutorState.STOPPED)
            return
        self._lease = None
        self.lifecycle.transition(ExecutorState.STOPPED)

    def fence(self) -> None:
        """Revoke local execution immediately after a downstream safety fault."""
        self._fence()

    def _activate(self, lease: LeadershipLease) -> None:
        self.lifecycle.transition(
            ExecutorState.ACTIVE, fencing_token=lease.fencing_token
        )
        self._lease = lease

    def _fence(self) -> None:
        if self.lifecycle.state is ExecutorState.ACTIVE:
            self.lifecycle.transition(ExecutorState.FENCED)
        self._lease = None
