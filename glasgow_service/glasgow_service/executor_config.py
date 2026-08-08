"""Validated environment configuration for the continuously running executor."""
from __future__ import annotations

import os
from dataclasses import dataclass

from .redis_coordination import RedisSentinelSettings


def _float(name: str, default: str) -> float:
    try:
        value = float(os.environ.get(name, default))
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, str(default)).strip().lower()
    if raw not in {"1", "true", "yes", "on", "0", "false", "no", "off"}:
        raise ValueError(f"{name} must be a boolean")
    return raw in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class ExecutorConfig:
    instance_id: str
    listen_host: str
    listen_port: int
    glasgow_url: str
    glasgow_token: str | None
    lease_ttl: float
    poll_interval: float
    redis_namespace: str
    redis_wait_replicas: int
    redis_wait_timeout_ms: int
    require_fencing: bool
    redis: RedisSentinelSettings

    @classmethod
    def from_environment(cls) -> "ExecutorConfig":
        instance_id = os.environ.get("VACUUM_EXECUTOR_ID", "").strip()
        if not instance_id:
            raise ValueError("VACUUM_EXECUTOR_ID is required")
        ttl = _float("VACUUM_EXECUTOR_LEASE_TTL", "5")
        poll = _float("VACUUM_EXECUTOR_POLL_INTERVAL", "1")
        if poll >= ttl:
            raise ValueError("VACUUM_EXECUTOR_POLL_INTERVAL must be shorter than lease TTL")
        try:
            port = int(os.environ.get("VACUUM_EXECUTOR_PORT", "8780"))
            replicas = int(os.environ.get("VACUUM_REDIS_WAIT_REPLICAS", "1"))
            wait_timeout = int(os.environ.get("VACUUM_REDIS_WAIT_TIMEOUT_MS", "1000"))
        except ValueError as exc:
            raise ValueError("executor port and Redis WAIT settings must be integers") from exc
        if not 1 <= port <= 65535 or replicas < 0 or wait_timeout < 0:
            raise ValueError("executor port/Redis WAIT settings are out of range")
        redis = RedisSentinelSettings.from_environment()
        require_fencing = _bool("GLASGOW_REQUIRE_FENCING", False)
        if require_fencing and len(redis.sentinels) < 3:
            raise ValueError("production fencing requires at least three Redis Sentinel endpoints")
        namespace = os.environ.get("VACUUM_REDIS_NAMESPACE", "vacuum").strip()
        if not namespace:
            raise ValueError("VACUUM_REDIS_NAMESPACE must not be empty")
        return cls(
            instance_id=instance_id,
            listen_host=os.environ.get("VACUUM_EXECUTOR_HOST", "127.0.0.1"),
            listen_port=port,
            glasgow_url=os.environ.get("VACUUM_GLASGOW_URL", "http://127.0.0.1:8765").rstrip("/"),
            glasgow_token=os.environ.get("GLASGOW_TOKEN") or None,
            lease_ttl=ttl,
            poll_interval=poll,
            redis_namespace=namespace,
            redis_wait_replicas=replicas,
            redis_wait_timeout_ms=wait_timeout,
            require_fencing=require_fencing,
            redis=redis,
        )
