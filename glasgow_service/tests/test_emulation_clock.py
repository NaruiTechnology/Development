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


def test_accelerated_catchup_yields_between_short_rig_lock_intervals(monkeypatch):
    clock = VirtualClock()
    runner = RealtimeRunner(clock, speed=20)
    batches = []
    yielded_at = []
    advance = clock.advance

    def record_advance(seconds):
        batches.append(seconds)
        advance(seconds)

    monkeypatch.setattr(clock, "advance", record_advance)
    monkeypatch.setattr("glasgow_service.emulation.clock.time.sleep",
                        lambda _: yielded_at.append(clock.now()))
    # A 250 ms host delay at 20x speed used to hold the rig lock for
    # five simulated seconds in one uninterruptible integration batch.
    runner._advance(0.25 * runner.speed)
    assert clock.now() == pytest.approx(5)
    assert max(batches) <= 0.05
    assert len(yielded_at) == len(batches)
    assert yielded_at == sorted(yielded_at)


def test_accelerated_catchup_stops_between_batches(monkeypatch):
    clock = VirtualClock()
    runner = RealtimeRunner(clock, speed=20)
    monkeypatch.setattr("glasgow_service.emulation.clock.time.sleep",
                        lambda _: runner._stop.set())
    runner._advance(5)
    assert clock.now() == pytest.approx(0.05)
