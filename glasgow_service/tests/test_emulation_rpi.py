"""Raspberry Pi emulator: models, boot rules, config.txt muxing, GPIO nets."""
import errno

import pytest

from glasgow_service.emulation.clock import VirtualClock
from glasgow_service.emulation.raspberry_pi import (
    BCM_TO_HEADER,
    EmulatedGpioHAL,
    InterfaceDisabled,
    PinConflict,
    PiSpec,
    PowerState,
    RaspberryPi,
    Resistor,
)


def booted(spec=None):
    clock = VirtualClock()
    pi = RaspberryPi(clock, spec)
    pi.boot_now()
    return clock, pi


def test_default_target_is_pi4b_2gb_matching_qemu_raspi4b():
    spec = PiSpec()
    assert spec.model == "4B" and spec.ram_gb == 2
    assert spec.profile.qemu_machine == "raspi4b"
    assert PiSpec(model="5", ram_gb=4).profile.qemu_machine is None


def test_pi4b_rejects_pi5_only_hardware_and_unsold_ram():
    with pytest.raises(ValueError, match="Raspberry Pi 5 only"):
        PiSpec(model="4B", m2_hat=True)
    with pytest.raises(ValueError, match="not sold"):
        PiSpec(model="4B", ram_gb=16)


def test_boot_takes_bootloader_plus_kernel_time_and_follows_boot_order():
    clock = VirtualClock()
    pi = RaspberryPi(clock, PiSpec(boot_order=0xF14))   # USB first, then SD
    pi.power_on()
    clock.advance(1.0)
    assert pi.state is PowerState.BOOTLOADER
    clock.advance(9.0)
    assert pi.state is PowerState.RUNNING
    assert pi.boot_device == "usb"


def test_pi4b_skips_nvme_boot_mode_and_falls_back():
    _clock, pi = booted(PiSpec(boot_order=0xF16))   # NVMe first, then SD
    assert pi.boot_device == "sd"
    assert any("(nvme) not supported" in line for line in pi.boot_log)


def test_pi5_usb_boot_needs_the_5a_supply():
    clock = VirtualClock()
    pi = RaspberryPi(clock, PiSpec(model="5", ram_gb=4, psu_amps=3.0, sd_card=False,
                                   boot_order=0xF4))
    pi.power_on()
    clock.advance(3)
    assert pi.state is PowerState.HALTED
    assert any("USB budget is 0.6 A" in line for line in pi.boot_log)


def test_pi4b_config_txt_gives_pl011_on_14_15_and_uart5_on_12_13():
    _clock, pi = booted()
    assert pi.serial("/dev/ttyAMA0") is pi.uart0
    assert pi.serial("/dev/ttyAMA1") is pi.uart_gpio12
    assert pi.uart_gpio12.name == "uart5"
    assert pi.lines[12].alt == "uart5"


def test_pi4b_without_disable_bt_gets_the_mini_uart():
    _clock, pi = booted(PiSpec(config_txt="dtparam=i2c_arm=on\nenable_uart=1\n"))
    assert pi.uart0_is_mini_uart
    with pytest.raises(InterfaceDisabled):
        pi.serial("/dev/ttyAMA0")
    assert pi.serial("/dev/ttyS0") is pi.uart0


def test_pi5_overlay_is_rejected_on_pi4b_and_accepted_on_pi5():
    _c, pi4 = booted(PiSpec(config_txt="dtoverlay=uart4-pi5\n"))
    assert any("not valid on Raspberry Pi 4" in line for line in pi4.boot_log)
    _c, pi5 = booted(PiSpec(model="5", ram_gb=4, psu_amps=5.0))
    assert pi5.serial("/dev/ttyAMA4") is pi5.uart_gpio12


def test_i2c_requires_dtparam():
    _clock, pi = booted(PiSpec(config_txt="enable_uart=1\n"))
    with pytest.raises(InterfaceDisabled, match="i2c_arm"):
        pi.i2c_bus(1)


def test_power_on_pull_defaults_and_external_resistor_resolution():
    _clock, pi = booted()
    assert pi.pin_level(5) is True        # BCM 0-8 pull up at reset
    assert pi.pin_level(22) is False      # BCM 9-27 pull down
    pi.connect(5, lambda: Resistor(False, 10e3))   # 10 k beats the 50 k pull-up
    assert pi.pin_level(5) is False


def test_userspace_gpio_needs_a_running_system_and_respects_alt_functions():
    clock = VirtualClock()
    pi = RaspberryPi(clock)
    hal = EmulatedGpioHAL(pi)
    with pytest.raises(OSError) as exc:
        hal.setup_output(17, False)
    assert exc.value.errno == errno.ENODEV
    pi.boot_now()
    with pytest.raises(PinConflict, match="i2c1"):
        hal.setup_output(2, False)
    hal.setup_output(17, True)
    assert pi.pin_level(17) is True


def test_header_map_matches_the_board_pins():
    assert BCM_TO_HEADER[22] == 15 and BCM_TO_HEADER[19] == 35
    assert BCM_TO_HEADER[5] == 29 and BCM_TO_HEADER[6] == 31
    assert BCM_TO_HEADER[12] == 32 and BCM_TO_HEADER[13] == 33
