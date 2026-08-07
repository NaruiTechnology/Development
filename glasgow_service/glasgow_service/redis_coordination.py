"""Redis Sentinel implementation of the lease-coordinator contract."""
from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Any, Iterable

from .coordination import (
    Clock,
    CoordinatorUnavailable,
    LeadershipLease,
    SystemMonotonicClock,
)


ACQUIRE_SCRIPT = """
if redis.call('exists', KEYS[1]) == 1 then
    return nil
end
local token = redis.call('incr', KEYS[2])
redis.call('hset', KEYS[1], 'holder', ARGV[1], 'token', token)
redis.call('pexpire', KEYS[1], ARGV[2])
return {token, redis.call('pttl', KEYS[1])}
"""

RENEW_SCRIPT = """
if redis.call('hget', KEYS[1], 'holder') ~= ARGV[1] then
    return nil
end
if redis.call('hget', KEYS[1], 'token') ~= ARGV[2] then
    return nil
end
redis.call('pexpire', KEYS[1], ARGV[3])
return {tonumber(ARGV[2]), redis.call('pttl', KEYS[1])}
"""

RELEASE_SCRIPT = """
if redis.call('hget', KEYS[1], 'holder') ~= ARGV[1] then
    return 0
end
if redis.call('hget', KEYS[1], 'token') ~= ARGV[2] then
    return 0
end
return redis.call('del', KEYS[1])
"""


@dataclass(frozen=True, slots=True)
class RedisSentinelSettings:
    sentinels: tuple[tuple[str, int], ...]
    master_name: str
    password: str | None = None
    sentinel_password: str | None = None
    socket_timeout: float = 1.0

    @classmethod
    def from_environment(cls) -> "RedisSentinelSettings":
        raw_sentinels = os.environ.get(
            "VACUUM_REDIS_SENTINELS", "127.0.0.1:26379"
        )
        sentinels: list[tuple[str, int]] = []
        for item in raw_sentinels.split(","):
            host, separator, raw_port = item.strip().rpartition(":")
            if not separator or not host:
                raise ValueError(
                    "VACUUM_REDIS_SENTINELS must contain host:port entries"
                )
            sentinels.append((host, int(raw_port)))
        return cls(
            sentinels=tuple(sentinels),
            master_name=os.environ.get("VACUUM_REDIS_MASTER", "vacuum-primary"),
            password=os.environ.get("VACUUM_REDIS_PASSWORD"),
            sentinel_password=os.environ.get("VACUUM_SENTINEL_PASSWORD"),
            socket_timeout=float(os.environ.get("VACUUM_REDIS_TIMEOUT", "1.0")),
        )


class RedisSentinelLeaseCoordinator:
    """Atomic Redis lease with replica acknowledgement and fencing terms.

    The persistent Glasgow-side token store remains the final safety boundary.
    Redis replication is asynchronous, so replica acknowledgement improves
    durability but does not replace hardware-owner stale-token rejection.
    """

    def __init__(
        self,
        redis_client: Any,
        *,
        namespace: str = "vacuum",
        clock: Clock | None = None,
        wait_replicas: int = 1,
        wait_timeout_ms: int = 1000,
    ) -> None:
        if not namespace:
            raise ValueError("Redis lease namespace must not be empty")
        if wait_replicas < 0 or wait_timeout_ms < 0:
            raise ValueError("Redis WAIT settings must not be negative")
        self.redis = redis_client
        self.clock = clock or SystemMonotonicClock()
        self.wait_replicas = wait_replicas
        self.wait_timeout_ms = wait_timeout_ms
        key_tag = "{" + namespace + "}"
        self.lease_key = f"{key_tag}:leader"
        self.token_key = f"{key_tag}:fencing-token"

    @classmethod
    def from_sentinel(
        cls,
        settings: RedisSentinelSettings,
        **kwargs,
    ) -> "RedisSentinelLeaseCoordinator":
        try:
            from redis.asyncio import Redis
            from redis.asyncio.sentinel import Sentinel
        except ImportError as exc:
            raise RuntimeError(
                "Redis coordination requires the 'redis' package"
            ) from exc
        sentinel_kwargs = {
            "socket_timeout": settings.socket_timeout,
        }
        if settings.sentinel_password:
            sentinel_kwargs["password"] = settings.sentinel_password
        sentinel = Sentinel(list(settings.sentinels), **sentinel_kwargs)
        client = sentinel.master_for(
            settings.master_name,
            redis_class=Redis,
            password=settings.password,
            socket_timeout=settings.socket_timeout,
            decode_responses=True,
        )
        return cls(client, **kwargs)

    async def acquire(self, holder_id: str, ttl: float) -> LeadershipLease | None:
        self._validate(holder_id, ttl)
        ttl_ms = self._ttl_ms(ttl)
        started_at = self.clock.now()
        try:
            if self.wait_replicas:
                # Redis WAIT applies to writes on the current connection. A
                # pipeline pins EVAL and WAIT to one pooled connection so the
                # acknowledgement actually covers this lease acquisition.
                pipeline = self.redis.pipeline(transaction=False)
                pipeline.eval(
                    ACQUIRE_SCRIPT,
                    2,
                    self.lease_key,
                    self.token_key,
                    holder_id,
                    ttl_ms,
                )
                pipeline.execute_command(
                    "WAIT", self.wait_replicas, self.wait_timeout_ms
                )
                result, replicas = await pipeline.execute()
            else:
                result = await self.redis.eval(
                    ACQUIRE_SCRIPT,
                    2,
                    self.lease_key,
                    self.token_key,
                    holder_id,
                    ttl_ms,
                )
                replicas = 0
            if result is None:
                return None
            token, remaining_ms = self._parse_lease_result(result)
            if self.wait_replicas and int(replicas) < self.wait_replicas:
                await self.release(holder_id, token)
                raise CoordinatorUnavailable(
                    "Redis lease was not acknowledged by the required replica"
                )
            return LeadershipLease(
                holder_id,
                token,
                started_at + remaining_ms / 1000.0,
            )
        except CoordinatorUnavailable:
            raise
        except Exception as exc:
            raise CoordinatorUnavailable(f"Redis lease acquisition failed: {exc}") from exc

    async def renew(
        self, holder_id: str, fencing_token: int, ttl: float
    ) -> LeadershipLease | None:
        self._validate(holder_id, ttl)
        started_at = self.clock.now()
        try:
            result = await self.redis.eval(
                RENEW_SCRIPT,
                2,
                self.lease_key,
                self.token_key,
                holder_id,
                fencing_token,
                self._ttl_ms(ttl),
            )
            if result is None:
                return None
            token, remaining_ms = self._parse_lease_result(result)
            return LeadershipLease(
                holder_id,
                token,
                started_at + remaining_ms / 1000.0,
            )
        except Exception as exc:
            raise CoordinatorUnavailable(f"Redis lease renewal failed: {exc}") from exc

    async def release(self, holder_id: str, fencing_token: int) -> bool:
        if not holder_id:
            raise ValueError("holder_id must not be empty")
        try:
            result = await self.redis.eval(
                RELEASE_SCRIPT,
                2,
                self.lease_key,
                self.token_key,
                holder_id,
                fencing_token,
            )
            return bool(result)
        except Exception as exc:
            raise CoordinatorUnavailable(f"Redis lease release failed: {exc}") from exc

    @staticmethod
    def _parse_lease_result(result: Iterable[Any]) -> tuple[int, int]:
        values = list(result)
        if len(values) != 2:
            raise ValueError("Redis lease script returned an invalid result")
        token, remaining_ms = int(values[0]), int(values[1])
        if token <= 0 or remaining_ms <= 0:
            raise ValueError("Redis lease script returned an invalid lease")
        return token, remaining_ms

    @staticmethod
    def _ttl_ms(ttl: float) -> int:
        return max(1, math.ceil(ttl * 1000.0))

    @staticmethod
    def _validate(holder_id: str, ttl: float) -> None:
        if not holder_id:
            raise ValueError("holder_id must not be empty")
        if ttl <= 0:
            raise ValueError("lease ttl must be positive")
