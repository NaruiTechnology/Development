"""Driver waits follow virtual progress even when the runner is delayed."""
import pytest

from glasgow_service.emulation.clock import RealtimeRunner, VirtualClock


def test_realtime_sleep_waits_for_virtual_progress(monkeypatch):
    clock = VirtualClock()
    runner = RealtimeRunner(clock, speed=20)
    waits = []

    def wait(timeout):
        waits.append(timeout)
        # Model a runner that misses its first two scheduling opportunities.
        if len(waits) >= 3:
            clock.advance(0.005)
        return False

    monkeypatch.setattr(runner._stop, "wait", wait)
    monkeypatch.setattr("glasgow_service.emulation.clock.time.sleep", lambda _: None)
    runner.sleep(0.008)
    assert clock.now() >= 0.008
    assert len(waits) == 4


def test_realtime_sleep_exits_when_runner_stops():
    runner = RealtimeRunner(VirtualClock())
    runner.stop()
    with pytest.raises(RuntimeError, match="clock stopped"):
        runner.sleep(0.01)
