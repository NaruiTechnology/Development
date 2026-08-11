import pytest

from glasgow_service.executor_config import ExecutorConfig


def test_executor_config_parses_environment(monkeypatch):
    monkeypatch.setenv("VACUUM_EXECUTOR_ID", "sbc-a")
    monkeypatch.setenv("VACUUM_REDIS_SENTINELS", "a:26379,b:26379,c:26379")
    config = ExecutorConfig.from_environment()
    assert config.instance_id == "sbc-a"
    assert config.redis.sentinels == (("a", 26379), ("b", 26379), ("c", 26379))


def test_executor_config_rejects_poll_longer_than_lease(monkeypatch):
    monkeypatch.setenv("VACUUM_EXECUTOR_ID", "sbc-a")
    monkeypatch.setenv("VACUUM_EXECUTOR_POLL_INTERVAL", "5")
    monkeypatch.setenv("VACUUM_EXECUTOR_LEASE_TTL", "5")
    with pytest.raises(ValueError, match="shorter"):
        ExecutorConfig.from_environment()


def test_executor_config_requires_instance_id(monkeypatch):
    monkeypatch.delenv("VACUUM_EXECUTOR_ID", raising=False)
    with pytest.raises(ValueError, match="EXECUTOR_ID"):
        ExecutorConfig.from_environment()
