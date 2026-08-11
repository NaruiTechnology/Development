"""Coordination contracts and a deterministic in-memory lease authority."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Protocol


class Clock(Protocol):
    def now(self) -> float: ...


class SystemMonotonicClock:
    def now(self) -> float:
        return time.monotonic()


class ManualClock:
    """Test clock advanced explicitly; it never sleeps or reads wall time."""

    def __init__(self, initial: float = 0.0) -> None:
        self._now = float(initial)

    def now(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("manual clock cannot move backwards")
        self._now += seconds


@dataclass(frozen=True, slots=True)
class LeadershipLease:
    holder_id: str
    fencing_token: int
    valid_until: float

    def is_valid(self, now: float) -> bool:
        return self.fencing_token > 0 and now < self.valid_until


class CoordinatorUnavailable(ConnectionError):
    pass


class LeaseCoordinator(Protocol):
    async def acquire(self, holder_id: str, ttl: float) -> LeadershipLease | None: ...

    async def renew(
        self, holder_id: str, fencing_token: int, ttl: float
    ) -> LeadershipLease | None: ...

    async def release(self, holder_id: str, fencing_token: int) -> bool: ...


class InMemoryLeaseCoordinator:
    """Single-authority coordination simulator with per-node partitions."""

    def __init__(self, clock: Clock | None = None) -> None:
        self.clock = clock or SystemMonotonicClock()
        self._lock = asyncio.Lock()
        self._lease: LeadershipLease | None = None
        self._last_fencing_token = 0
        self._unreachable: set[str] = set()

    def set_reachable(self, holder_id: str, reachable: bool) -> None:
        if reachable:
            self._unreachable.discard(holder_id)
        else:
            self._unreachable.add(holder_id)

    async def acquire(self, holder_id: str, ttl: float) -> LeadershipLease | None:
        self._validate(holder_id, ttl)
        self._ensure_reachable(holder_id)
        async with self._lock:
            self._expire_if_needed()
            if self._lease is not None:
                return None
            self._last_fencing_token += 1
            self._lease = LeadershipLease(
                holder_id=holder_id,
                fencing_token=self._last_fencing_token,
                valid_until=self.clock.now() + ttl,
            )
            return self._lease

    async def renew(
        self, holder_id: str, fencing_token: int, ttl: float
    ) -> LeadershipLease | None:
        self._validate(holder_id, ttl)
        self._ensure_reachable(holder_id)
        async with self._lock:
            self._expire_if_needed()
            if not self._is_owner(holder_id, fencing_token):
                return None
            self._lease = LeadershipLease(
                holder_id=holder_id,
                fencing_token=fencing_token,
                valid_until=self.clock.now() + ttl,
            )
            return self._lease

    async def release(self, holder_id: str, fencing_token: int) -> bool:
        if not holder_id:
            raise ValueError("holder_id must not be empty")
        self._ensure_reachable(holder_id)
        async with self._lock:
            self._expire_if_needed()
            if not self._is_owner(holder_id, fencing_token):
                return False
            self._lease = None
            return True

    async def current_lease(self) -> LeadershipLease | None:
        async with self._lock:
            self._expire_if_needed()
            return self._lease

    def _ensure_reachable(self, holder_id: str) -> None:
        if holder_id in self._unreachable:
            raise CoordinatorUnavailable(
                f"coordination unavailable to executor {holder_id}"
            )

    def _expire_if_needed(self) -> None:
        if self._lease is not None and not self._lease.is_valid(self.clock.now()):
            self._lease = None

    def _is_owner(self, holder_id: str, fencing_token: int) -> bool:
        return (
            self._lease is not None
            and self._lease.holder_id == holder_id
            and self._lease.fencing_token == fencing_token
        )

    @staticmethod
    def _validate(holder_id: str, ttl: float) -> None:
        if not holder_id:
            raise ValueError("holder_id must not be empty")
        if ttl <= 0:
            raise ValueError("lease ttl must be positive")
