"""24/7 availability: recovery from transient device errors.

A single communication glitch used to latch the cascade until an operator
called /vacuum/resume.  Device-error latches now clear themselves after a run
of healthy polls; operator stops and safety trips keep their manual reset.
"""
import asyncio

import pytest

from glasgow_service.vacuum import (
    LATCH_DEVICE_ERROR,
    LATCH_OPERATOR,
    LATCH_RESTART,
    LATCH_SAFETY,
    MECHANICAL_PUMP,
    VacuumController,
)

from .test_vacuum import make_config


async def started_controller(**kwargs) -> VacuumController:
    controller = VacuumController(make_config(simulate=True), **kwargs)
    await controller.start()
    # Drive polls by hand so the test controls time.
    controller._task.cancel()
    try:
        await controller._task
    except asyncio.CancelledError:
        pass
    controller._task = None
    return controller


async def pump_down(controller: VacuumController) -> None:
    for name in [pump.name for pump in controller.status().pumps]:
        for _ in range(3):
            await controller.set_simulated_read(name, True)
            await controller.poll_once()
    assert controller.status().isVacuumSystemReady is True


def inject_one_read_error(controller: VacuumController) -> None:
    real = controller.gpio.read_port_b
    calls = {"n": 0}

    async def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("I2C NACK (transient)")
        return await real()

    controller.gpio.read_port_b = flaky


async def healthy_polls(controller: VacuumController, count: int) -> None:
    for _ in range(count):
        await controller.poll_once()


def powers(controller: VacuumController) -> dict[str, bool]:
    return {pump.name: pump.power for pump in controller.status().pumps}


def test_transient_device_error_auto_resumes_after_healthy_polls():
    async def scenario():
        controller = await started_controller()
        try:
            await pump_down(controller)
            inject_one_read_error(controller)
            await controller.poll_once()
            status = controller.status()
            assert status.cascade_latch == LATCH_DEVICE_ERROR
            assert powers(controller)[MECHANICAL_PUMP] is True
            assert not any(p for name, p in powers(controller).items()
                           if name != MECHANICAL_PUMP)

            # Not yet: one poll short of the threshold.
            await healthy_polls(controller, controller.AUTO_RESUME_HEALTHY_POLLS - 1)
            assert controller.status().cascade_latch == LATCH_DEVICE_ERROR

            await healthy_polls(controller, 1)
            assert controller.status().cascade_latch is None
            assert controller.status().cascade_stopped is False

            # The cascade advances again, stage by stage, from measured state.
            for name in [pump.name for pump in controller.status().pumps]:
                for _ in range(3):
                    await controller.set_simulated_read(name, True)
                    await controller.poll_once()
            assert all(powers(controller).values())
            assert controller.status().isVacuumSystemReady is True
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_another_error_restarts_the_healthy_poll_count():
    async def scenario():
        controller = await started_controller()
        try:
            await pump_down(controller)
            inject_one_read_error(controller)
            await controller.poll_once()
            await healthy_polls(controller, controller.AUTO_RESUME_HEALTHY_POLLS - 1)
            inject_one_read_error(controller)
            await controller.poll_once()
            await healthy_polls(controller, controller.AUTO_RESUME_HEALTHY_POLLS - 1)
            assert controller.status().cascade_latch == LATCH_DEVICE_ERROR
            await healthy_polls(controller, 1)
            assert controller.status().cascade_latch is None
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_auto_resume_can_be_disabled(monkeypatch):
    monkeypatch.setenv("SBC_VACUUM_AUTO_RESUME_POLLS", "0")

    async def scenario():
        controller = await started_controller()
        try:
            await pump_down(controller)
            inject_one_read_error(controller)
            await controller.poll_once()
            await healthy_polls(controller, 100)
            assert controller.status().cascade_latch == LATCH_DEVICE_ERROR
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_invalid_auto_resume_setting_is_rejected(monkeypatch):
    monkeypatch.setenv("SBC_VACUUM_AUTO_RESUME_POLLS", "-1")
    with pytest.raises(ValueError, match="SBC_VACUUM_AUTO_RESUME_POLLS"):
        VacuumController(make_config(simulate=True))


def test_operator_stop_is_never_auto_resumed():
    async def scenario():
        controller = await started_controller()
        try:
            await pump_down(controller)
            await controller.stop_non_mechanical()
            assert controller.status().cascade_latch == LATCH_OPERATOR
            # A device error on top of an operator stop must not downgrade it.
            inject_one_read_error(controller)
            await controller.poll_once()
            assert controller.status().cascade_latch == LATCH_OPERATOR
            await healthy_polls(controller, 50)
            assert controller.status().cascade_latch == LATCH_OPERATOR
            assert not any(p for name, p in powers(controller).items()
                           if name != MECHANICAL_PUMP)

            await controller.resume_cascade()
            assert controller.status().cascade_latch is None
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_no_auto_resume_when_backing_pump_lost_power():
    async def scenario():
        controller = await started_controller()
        try:
            await pump_down(controller)
            inject_one_read_error(controller)
            await controller.poll_once()
            # Hardware dropped the backing pump (e.g. expander reset).
            mechanical = controller._states[MECHANICAL_PUMP]
            await controller.gpio.write(mechanical.write, False)
            await healthy_polls(controller, 50)
            assert controller.status().cascade_latch == LATCH_DEVICE_ERROR
        finally:
            await controller.close()

    asyncio.run(scenario())


def test_latch_priority_never_downgrades():
    controller = VacuumController(make_config(simulate=True))
    controller._latch(LATCH_SAFETY)
    for reason in (LATCH_DEVICE_ERROR, LATCH_RESTART, LATCH_OPERATOR):
        controller._latch(reason)
        assert controller.cascade_latch == LATCH_SAFETY
    controller._cascade_stopped = False
    controller._latch(LATCH_DEVICE_ERROR)
    controller._latch(LATCH_OPERATOR)
    assert controller.cascade_latch == LATCH_OPERATOR
    # A plain stop is an operator latch.
    controller._cascade_stopped = False
    controller._cascade_stopped = True
    assert controller.cascade_latch == LATCH_OPERATOR


# ------------------------------------------------------------ board mode
# The production RPi5VacuumIO driver on the emulated rig.

from .test_vacuum_io_board import (  # noqa: E402  (fixtures are used by name)
    isolated_scan_configuration,  # noqa: F401
    poll,
    relays,
    run,
    started,  # noqa: F401
)


def test_board_i2c_glitch_auto_resumes_the_full_cascade(started):
    rig, controller = started
    rig.pi.i2c1.inject_nack(0x21)
    run(controller.poll_once())
    rig.advance(0.05)                           # relay release time
    assert controller.status().cascade_latch == LATCH_DEVICE_ERROR
    assert relays(rig)[:4] == [True, False, False, False]
    run(poll(controller, rig, count=controller.AUTO_RESUME_HEALTHY_POLLS + 4))
    status = controller.status()
    assert status.cascade_latch is None
    assert relays(rig)[:4] == [True] * 4


def test_board_keepalive_trip_still_needs_an_operator(started):
    rig, controller = started
    rig.advance(3.5)                            # control loop stalled
    assert controller.gpio.check_keepalive()
    rig.advance(0.2)
    run(poll(controller, rig, count=controller.AUTO_RESUME_HEALTHY_POLLS * 3))
    status = controller.status()
    assert status.cascade_latch is not None
    assert relays(rig)[1:4] == [False, False, False]
    run(controller.resume_cascade())
    run(poll(controller, rig, count=4))
    assert relays(rig)[:4] == [True] * 4


def test_board_expander_reset_still_needs_an_operator(started):
    rig, controller = started
    rig.board.u1._por()                         # brown-out: every output dropped
    run(poll(controller, rig, count=controller.AUTO_RESUME_HEALTHY_POLLS * 3))
    status = controller.status()
    assert status.cascade_latch is not None
    assert relays(rig)[:4] == [False] * 4


def test_board_estop_latch_is_safety_and_never_auto_resumes(started):
    rig, controller = started
    rig.set_estop(True)
    rig.advance(0.05)
    run(poll(controller, rig, count=3))
    rig.set_estop(False)
    rig.advance(0.05)
    run(poll(controller, rig, count=controller.AUTO_RESUME_HEALTHY_POLLS * 3))
    assert controller.status().cascade_latch == LATCH_SAFETY


# --------------------------------------------------------- executor failover
# With SBC_REQUIRE_FENCING the SBC only acts for the executor holding a live
# lease.  Between leaders its own interlocks must still make things safe.

import tempfile  # noqa: E402
from pathlib import Path  # noqa: E402

from glasgow_service.execution_authority import (  # noqa: E402
    PersistentFencingTokenStore,
    RemoteExecutionAuthority,
)


class ManualClock:
    def __init__(self):
        self.t = 1000.0

    def now(self):
        return self.t


async def fenced_controller():
    clock = ManualClock()
    authority = RemoteExecutionAuthority(
        PersistentFencingTokenStore(Path(tempfile.mkdtemp()) / "fencing.json"),
        clock=clock)
    authority.accept("exec-a", 1, 5.0)
    controller = await started_controller(authority=authority)
    for name in [pump.name for pump in controller.status().pumps]:
        for _ in range(3):
            authority.accept("exec-a", 1, 5.0)
            await controller.set_simulated_read(name, True)
            await controller.poll_once()
    assert controller.status().isVacuumSystemReady is True
    return controller, authority, clock


def test_interlocks_still_de_energize_while_no_executor_holds_a_lease():
    async def scenario():
        controller, authority, clock = await fenced_controller()
        try:
            clock.t += 10                    # leader died; lease expired
            turbo = controller._states["TurboVacuumPump"]
            controller._simulation_reads[turbo.name] = False
            await controller.gpio.set_gauge_ready(turbo.read, False)
            await controller.poll_once()
            power = powers(controller)
            downstream = [state.name for stage in controller._stages[2:] for state in stage]
            assert power[MECHANICAL_PUMP] is True
            assert downstream and not any(power[name] for name in downstream)
            assert controller.status().last_error is None
        finally:
            authority.accept("exec-a", 1, 5.0)
            await controller.close()

    asyncio.run(scenario())


def test_a_healthy_lease_gap_changes_nothing_and_is_not_a_device_error():
    async def scenario():
        controller, authority, clock = await fenced_controller()
        try:
            before = powers(controller)
            clock.t += 10                    # failover in progress
            await healthy_polls(controller, 20)
            assert powers(controller) == before
            status = controller.status()
            assert status.cascade_latch is None and status.last_error is None
            assert status.isVacuumSystemReady is True
            # The new leader takes over without any restart of the cascade.
            authority.accept("exec-b", 2, 5.0)
            await controller.start()         # what /vacuum/acquire does
            await controller.poll_once()
            assert powers(controller) == before
        finally:
            authority.accept("exec-b", 2, 5.0)
            await controller.close()

    asyncio.run(scenario())


def test_nothing_is_energized_without_a_lease():
    async def scenario():
        controller, authority, clock = await fenced_controller()
        try:
            await controller.stop_non_mechanical()
            # Cascade re-enabled, then the lease is lost before it could
            # restart anything.
            controller._cascade_stopped = False
            clock.t += 10
            await healthy_polls(controller, 5)
            assert not any(p for name, p in powers(controller).items()
                           if name != MECHANICAL_PUMP)
            authority.accept("exec-b", 2, 5.0)
            await controller.poll_once()
            assert powers(controller)["TurboVacuumPump"] is True
        finally:
            authority.accept("exec-b", 2, 5.0)
            await controller.close()

    asyncio.run(scenario())
