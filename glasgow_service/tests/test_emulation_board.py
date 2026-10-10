"""Electrical behaviour of the emulated RPi5VacuumIO board on the rig."""
import pytest

from glasgow_service.emulation.board import DIVIDER_RATIO
from glasgow_service.emulation.raspberry_pi import PiSpec
from glasgow_service.emulation.rig import VacuumRig


@pytest.fixture(params=["4B", "5"])
def rig(request):
    spec = PiSpec() if request.param == "4B" else PiSpec(model="5", ram_gb=4, psu_amps=5.0)
    return VacuumRig(spec=spec, tool_connected=False)


def release_reset_and_drive(rig, olat_a=0x00):
    hal, bus = rig.gpio_hal(), rig.smbus()
    hal.setup_output(22, True)
    hal.setup_output(19, False)
    bus.write_i2c_block_data(0x20, 0x14, [olat_a, 0])
    bus.write_i2c_block_data(0x20, 0x00, [0, 0])
    return hal, bus


def test_i2cdetect_matches_wiring_guide_after_reset_release(rig):
    # GPIO22 low after boot: R10 holds both expanders in reset.
    assert rig.pi.i2c1.scan() == [0x48, 0x49]
    rig.gpio_hal().setup_output(22, True)
    assert rig.pi.i2c1.scan() == [0x20, 0x21, 0x48, 0x49]


def test_outputs_are_off_while_pi_boots_or_service_is_down():
    rig = VacuumRig(boot=False, tool_connected=False)
    rig.pi.power_on()
    rig.advance(5)
    assert not any(rig.board.relay_closed(n) for n in range(1, 9))
    assert not rig.board.safe_rail_live          # no heartbeat yet
    assert rig.board.estop_rail_live             # E-stop loop closed


def test_k1_runs_from_estop_rail_and_k2_needs_the_watchdog_rail(rig):
    hal, _bus = release_reset_and_drive(rig, 0b11)
    rig.advance(0.05)
    assert rig.board.relay_closed(1) and not rig.board.relay_closed(2)
    hal.pwm(19, 1000, 50)
    rig.advance(0.05)
    assert rig.board.relay_closed(2)


def test_watchdog_drops_about_100ms_after_heartbeat_stops(rig):
    hal, _bus = release_reset_and_drive(rig, 0b10)
    hal.pwm(19, 1000, 50)
    rig.advance(0.1)
    assert rig.board.safe_rail_live
    hal.pwm(19, 0, 0)                            # stuck low
    t0 = rig.clock.now()
    while rig.board.safe_rail_live:
        rig.advance(0.001)
    dropout = rig.clock.now() - t0
    assert 0.07 < dropout < 0.13
    rig.advance(0.01)                            # G5LE release time (5 ms)
    assert not rig.board.relay_closed(2)


def test_heartbeat_stuck_high_also_trips(rig):
    hal, _bus = release_reset_and_drive(rig)
    hal.pwm(19, 1000, 50)
    rig.advance(0.1)
    hal.write(19, True)                          # static high: C4 blocks DC
    rig.advance(0.2)
    assert not rig.board.safe_rail_live


def test_estop_removes_both_rails_and_reports_on_gpio5_6(rig):
    hal, _bus = release_reset_and_drive(rig, 0b1)
    hal.pwm(19, 1000, 50)
    hal.setup_input(5)
    hal.setup_input(6)
    rig.advance(0.05)
    assert hal.read(5) is False and hal.read(6) is False   # low = OK
    rig.set_estop(True)
    rig.advance(0.05)
    assert hal.read(5) is True and hal.read(6) is True
    assert not rig.board.relay_closed(1)


def test_coil_rail_jumper_moves_k1_to_the_watchdog_rail(rig):
    rig.board.coil_rail[0] = "safe"
    release_reset_and_drive(rig, 0b1)
    rig.advance(0.05)
    assert not rig.board.relay_closed(1)


def test_inputs_are_active_low_at_the_expander(rig):
    rig.gpio_hal().setup_output(22, True)
    bus = rig.smbus()
    assert bus.read_i2c_block_data(0x21, 0x12, 2) == [0xFF, 0xFF]
    rig.jumper(1)
    rig.jumper(16)
    assert bus.read_i2c_block_data(0x21, 0x12, 2) == [0xFE, 0x7F]


def test_analog_divider_and_filter(rig):
    rig.board.set_ai(2, 5.0)
    rig.advance(0.02)                            # >> 1.66 ms time constant
    assert rig.board._ai_nodes[1] == pytest.approx(5.0 * DIVIDER_RATIO, rel=1e-3)


def test_rs485_is_silent_unless_driver_enabled(rig):
    rig.connect_tool(True)
    port = rig.serial("/dev/ttyAMA0")
    port.write(b"0010030902=?107\r")
    assert rig.board.rs485_dropped_bytes == 16
