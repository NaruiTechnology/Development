import asyncio

import pytest

from glasgow_service.coordination import CoordinatorUnavailable, ManualClock
from glasgow_service.redis_coordination import (
    ACQUIRE_SCRIPT,
    RELEASE_SCRIPT,
    RENEW_SCRIPT,
    RedisSentinelLeaseCoordinator,
    RedisSentinelSettings,
)


class FakeRedis:
    def __init__(self):
        self.holder = None
        self.token = None
        self.counter = 0
        self.wait_result = 1

    def pipeline(self, transaction=False):
        assert transaction is False
        return FakePipeline(self)

    async def eval(self, script, _numkeys, _lease_key, _token_key, *args):
        if script == ACQUIRE_SCRIPT:
            holder, ttl_ms = args
            if self.holder is not None:
                return None
            self.counter += 1
            self.holder = holder
            self.token = self.counter
            return [self.token, int(ttl_ms)]
        if script == RENEW_SCRIPT:
            holder, token, ttl_ms = args
            if self.holder != holder or self.token != int(token):
                return None
            return [self.token, int(ttl_ms)]
        if script == RELEASE_SCRIPT:
            holder, token = args
            if self.holder != holder or self.token != int(token):
                return 0
            self.holder = None
            self.token = None
            return 1
        raise AssertionError("unexpected Lua script")



class FakePipeline:
    def __init__(self, redis):
        self.redis = redis
        self.commands = []

    def eval(self, *args):
        self.commands.append(("eval", args))
        return self

    def execute_command(self, *args):
        self.commands.append(("command", args))
        return self

    async def execute(self):
        results = []
        for kind, args in self.commands:
            if kind == "eval":
                results.append(await self.redis.eval(*args))
            else:
                command, replicas, _timeout_ms = args
                assert command == "WAIT"
                assert replicas == 1
                results.append(self.redis.wait_result)
        return results


def test_redis_coordinator_acquires_renews_and_increments_terms():
    async def scenario():
        clock = ManualClock(10.0)
        redis = FakeRedis()
        coordinator = RedisSentinelLeaseCoordinator(redis, clock=clock)

        first = await coordinator.acquire("node-a", 5.0)
        assert first.holder_id == "node-a"
        assert first.fencing_token == 1
        assert first.valid_until == pytest.approx(15.0)
        assert await coordinator.acquire("node-b", 5.0) is None

        clock.advance(1.0)
        renewed = await coordinator.renew("node-a", 1, 5.0)
        assert renewed.valid_until == pytest.approx(16.0)
        assert await coordinator.renew("node-b", 1, 5.0) is None
        assert await coordinator.release("node-b", 1) is False
        assert await coordinator.release("node-a", 1) is True

        second = await coordinator.acquire("node-b", 5.0)
        assert second.fencing_token == 2

    asyncio.run(scenario())


def test_redis_coordinator_rejects_unreplicated_acquisition():
    async def scenario():
        redis = FakeRedis()
        redis.wait_result = 0
        coordinator = RedisSentinelLeaseCoordinator(redis)

        with pytest.raises(CoordinatorUnavailable, match="not acknowledged"):
            await coordinator.acquire("node-a", 5.0)
        assert redis.holder is None

    asyncio.run(scenario())


def test_redis_sentinel_settings_parse_environment(monkeypatch):
    monkeypatch.setenv("VACUUM_REDIS_SENTINELS", "node-a:26379,node-b:26380")
    monkeypatch.setenv("VACUUM_REDIS_MASTER", "vacuum")
    monkeypatch.setenv("VACUUM_REDIS_TIMEOUT", "2.5")

    settings = RedisSentinelSettings.from_environment()

    assert settings.sentinels == (("node-a", 26379), ("node-b", 26380))
    assert settings.master_name == "vacuum"
    assert settings.socket_timeout == pytest.approx(2.5)
