"""The backing pump across an SBC service restart (RPi5VacuumIO board).

K1 (MechanicalVacuumPump) runs from the E-stop rail by design, so it can run
while no process supervises the board.  With ``KeepBackingPumpOnRestart`` an
orderly stop leaves it latched and the next start adopts it; every other
output still goes off and comes back only through the cascade.

Whether K1 also survives the process exit depends on the platform: the
board's R10 pulls IO_RESET_N low when no process drives it, which resets the
expanders.  These tests run both cases on the emulator:

* ``line_persists=False`` -- the board as built today (line released, R10
  resets the expanders): K1 drops, exactly as before this change.
* ``line_persists=True`` -- IO_RESET_N stays high while no process holds it
  (pull-up instead of R10, or kernel output persistence): K1 survives.
"""
import asyncio

import pytest

from glasgow_service.emulation.board import BCM_IO_RESET_N
from glasgow_service.emulation.rig import VacuumRig
from glasgow_service.vacuum import LATCH_SAFETY, VacuumController

from .test_vacuum_io_board import (  # noqa: F401  (autouse fixture by name)
    board_config,
    isolated_scan_configuration,
    jumper_gauges,
    poll,
    relays,
)


def run(coro):
    return asyncio.run(coro)


def keep_line_driven(rig):
    """Model a reset line that stays high while no process holds it."""
    original = rig.pi.gpio_free

    def gpio_free(bcm):
        if bcm == BCM_IO_RESET_N:
            rig.pi.lines[bcm].owner = None      # released, still driven high
            return
        original(bcm)

    rig.pi.gpio_free = gpio_free


def new_controller(rig, keep=True):
    config = board_config(Gauges=jumper_gauges(), KeepBackingPumpOnRestart=keep)
    return VacuumController(config, emulator=rig)


def running_rig(keep=True, line_persists=False):
    rig = VacuumRig(tool_connected=False)
    if line_persists:
        keep_line_driven(rig)
    for di in range(1, 9):
        rig.jumper(di)
    controller = new_controller(rig, keep)
    run(controller.start())
    run(poll(controller, rig, count=4))
    assert relays(rig)[:4] == [True] * 4
    return rig, controller


def process_exit(rig, controller):
    """The service process exits: the OS releases its GPIO lines."""
    controller.gpio._gpio.close()


def test_default_profile_still_switches_the_backing_pump_off():
    rig, controller = running_rig(keep=False, line_persists=True)
    run(controller.close(keep_backing_pump=True))
    rig.advance(0.2)
    assert relays(rig)[:4] == [False] * 4


def test_orderly_stop_keeps_only_the_backing_pump():
    rig, controller = running_rig(keep=True, line_persists=True)
    run(controller.close(keep_backing_pump=True))
    rig.advance(0.2)
    assert not rig.board.safe_rail_live            # watchdog rail dropped
    assert relays(rig)[:4] == [True, False, False, False]
    run(controller.close(keep_backing_pump=True))  # repeated close: no-op
    rig.advance(0.2)
    assert relays(rig)[0] is True


def test_restart_adopts_the_running_backing_pump_and_resumes_the_cascade():
    rig, controller = running_rig(keep=True, line_persists=True)
    run(controller.close(keep_backing_pump=True))
    process_exit(rig, controller)
    rig.advance(0.5)
    assert relays(rig)[:4] == [True, False, False, False]

    restarted = new_controller(rig)
    run(restarted.start())
    rig.advance(0.05)
    assert restarted.gpio.adopted is True
    # Nothing but the backing pump is on before the cascade decides.
    assert relays(rig)[:4] == [True, False, False, False]
    run(poll(restarted, rig, count=4))
    assert relays(rig)[:4] == [True] * 4
    assert restarted.status().cascade_latch is None
    run(restarted.close())


def test_board_as_built_today_still_drops_the_backing_pump_on_exit():
    rig, controller = running_rig(keep=True, line_persists=False)
    run(controller.close(keep_backing_pump=True))
    rig.advance(0.2)
    assert relays(rig)[0] is True                  # while the process lives
    process_exit(rig, controller)                  # R10 resets the expanders
    rig.advance(0.2)
    assert relays(rig)[:4] == [False] * 4
    restarted = new_controller(rig)
    run(restarted.start())
    assert restarted.gpio.adopted is False         # normal reset path
    run(poll(restarted, rig, count=4))
    assert relays(rig)[:4] == [True] * 4
    run(restarted.close())


def test_after_a_crash_stale_outputs_are_cleared_before_the_rail_returns():
    rig, controller = running_rig(keep=True, line_persists=True)
    process_exit(rig, controller)                  # crash: no orderly close
    rig.advance(0.5)
    assert not rig.board.safe_rail_live
    assert relays(rig)[:4] == [True, False, False, False]   # rail off, K1 on
    restarted = new_controller(rig)
    run(restarted.start())
    rig.advance(0.05)
    assert rig.board.safe_rail_live
    # Turbo/UH latches from before the crash must not come back with the rail.
    assert relays(rig)[:4] == [True, False, False, False]
    run(poll(restarted, rig, count=4))
    assert relays(rig)[:4] == [True] * 4
    run(restarted.close())


def test_explicit_release_still_switches_everything_off():
    rig, controller = running_rig(keep=True, line_persists=True)
    run(controller.close())                        # /vacuum/release
    rig.advance(0.2)
    assert relays(rig)[:4] == [False] * 4


def test_estop_while_stopped_wins_over_adoption():
    rig, controller = running_rig(keep=True, line_persists=True)
    run(controller.close(keep_backing_pump=True))
    process_exit(rig, controller)
    rig.set_estop(True)
    rig.advance(0.2)
    assert relays(rig)[0] is False                 # E-stop removes K1's rail
    restarted = new_controller(rig)
    run(restarted.start())
    run(poll(restarted, rig, count=3))
    assert restarted.status().cascade_latch == LATCH_SAFETY
    assert relays(rig)[:4] == [False] * 4
    rig.set_estop(False)
    rig.advance(0.2)
    run(poll(restarted, rig, count=3))
    assert relays(rig)[:4] == [False] * 4          # nothing restarts by itself
    run(restarted.close())


def test_cold_board_with_the_switch_on_starts_normally():
    rig = VacuumRig(tool_connected=False)
    for di in range(1, 9):
        rig.jumper(di)
    controller = new_controller(rig)
    run(controller.start())
    assert controller.gpio.adopted is False
    run(poll(controller, rig, count=4))
    assert relays(rig)[:4] == [True] * 4
    run(controller.close())
