import asyncio

import pytest

from glasgow_service.coordination import InMemoryLeaseCoordinator, ManualClock
from glasgow_service.executor_lifecycle import ExecutorState
from glasgow_service.failover_executor import FailoverExecutor
from glasgow_service.sbc_client import (
    SbcAuthorityRejected,
    SbcVacuumClient,
)
from glasgow_service.vacuum_failover_runtime import VacuumFailoverRuntime


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {"running": True}
        self.text = str(self._payload)

    def json(self):
        return self._payload


class FakeHttpClient:
    def __init__(self):
        self.requests = []
        self.next_response = FakeResponse()

    async def request(self, method, url, **kwargs):
        self.requests.append((method, url, kwargs))
        return self.next_response


def make_executor(clock):
    coordinator = InMemoryLeaseCoordinator(clock)
    executor = FailoverExecutor("node-a", coordinator, clock=clock)
    return coordinator, executor


def test_sbc_client_sends_live_fencing_and_bearer_headers():
    async def scenario():
        clock = ManualClock()
        _coordinator, executor = make_executor(clock)
        await executor.start()
        await executor.step()
        http = FakeHttpClient()
        client = SbcVacuumClient(
            "http://sbc.local:8765/",
            executor,
            bearer_token="secret",
            http_client=http,
            clock=clock,
        )

        await client.set_power("TurboVacuumPump", True)
        method, url, kwargs = http.requests[-1]
        assert method == "POST"
        assert url.endswith("/vacuum/pumps/TurboVacuumPump/power")
        assert kwargs["json"] == {"power": True}
        assert kwargs["headers"] == {
            "X-Executor-ID": "node-a",
            "X-Fencing-Token": "1",
            "X-Lease-Valid-For-Ms": "5000",
            "Authorization": "Bearer secret",
        }

        await client.set_high_voltage_power(True)
        method, url, kwargs = http.requests[-1]
        assert method == "POST"
        assert url.endswith("/vacuum/high-voltage/power")
        assert kwargs["json"] == {"power": True}

        await client.resume()
        assert http.requests[-1][0] == "POST"
        assert http.requests[-1][1].endswith("/vacuum/resume")

    asyncio.run(scenario())


def test_sbc_client_refuses_requests_without_live_lease():
    async def scenario():
        clock = ManualClock()
        _coordinator, executor = make_executor(clock)
        http = FakeHttpClient()
        client = SbcVacuumClient(
            "http://sbc.local:8765", executor, http_client=http, clock=clock
        )

        with pytest.raises(SbcAuthorityRejected, match="no live lease"):
            await client.acquire()
        assert http.requests == []

    asyncio.run(scenario())


def test_runtime_acquires_renews_and_stops_sbc_before_releasing_lease():
    async def scenario():
        clock = ManualClock()
        coordinator, executor = make_executor(clock)
        http = FakeHttpClient()
        client = SbcVacuumClient(
            "http://sbc.local:8765", executor, http_client=http, clock=clock
        )
        runtime = VacuumFailoverRuntime(executor, client, release_on_stop=True)

        await executor.start()
        await runtime.step()
        assert http.requests[-1][1].endswith("/vacuum/acquire")
        clock.advance(1.0)
        await runtime.step()
        assert http.requests[-1][1].endswith("/vacuum/leadership/renew")

        await runtime.stop()
        assert http.requests[-1][1].endswith("/vacuum/release")
        assert executor.lifecycle.state is ExecutorState.STOPPED
        assert await coordinator.current_lease() is None

    asyncio.run(scenario())


def test_runtime_fences_executor_when_sbc_rejects_authority():
    async def scenario():
        clock = ManualClock()
        _coordinator, executor = make_executor(clock)
        http = FakeHttpClient()
        http.next_response = FakeResponse(409, {"detail": "stale fencing token"})
        client = SbcVacuumClient(
            "http://sbc.local:8765", executor, http_client=http, clock=clock
        )
        runtime = VacuumFailoverRuntime(executor, client)

        await executor.start()
        await runtime.step()
        assert executor.lifecycle.state is ExecutorState.FENCED
        assert executor.may_execute is False

    asyncio.run(scenario())


def test_runtime_stop_keeps_the_vacuum_up_by_default():
    """A restart, deploy or hand-over must not power the vacuum system down."""
    async def scenario():
        clock = ManualClock()
        coordinator, executor = make_executor(clock)
        http = FakeHttpClient()
        client = SbcVacuumClient(
            "http://sbc.local:8765", executor, http_client=http, clock=clock
        )
        runtime = VacuumFailoverRuntime(executor, client)

        await executor.start()
        await runtime.step()
        await runtime.stop()
        assert not any(url.endswith("/vacuum/release") for _m, url, _k in http.requests)
        assert executor.lifecycle.state is ExecutorState.STOPPED
        # The Redis lease is still released, so the standby takes over at once.
        assert await coordinator.current_lease() is None

    asyncio.run(scenario())


def test_runtime_reacquires_when_the_sbc_restarted_under_the_same_term():
    """With fencing on, a restarted SBC waits idle until an executor acquires."""
    async def scenario():
        clock = ManualClock()
        _coordinator, executor = make_executor(clock)
        http = FakeHttpClient()
        client = SbcVacuumClient(
            "http://sbc.local:8765", executor, http_client=http, clock=clock
        )
        runtime = VacuumFailoverRuntime(executor, client)

        await executor.start()
        await runtime.step()
        assert http.requests[-1][1].endswith("/vacuum/acquire")

        http.next_response = FakeResponse(200, {"running": False})
        clock.advance(1.0)
        await runtime.step()
        urls = [url for _m, url, _k in http.requests[-2:]]
        assert urls[0].endswith("/vacuum/leadership/renew")
        assert urls[1].endswith("/vacuum/acquire")

        http.next_response = FakeResponse(200, {"running": True})
        clock.advance(1.0)
        await runtime.step()
        assert http.requests[-1][1].endswith("/vacuum/leadership/renew")

    asyncio.run(scenario())
