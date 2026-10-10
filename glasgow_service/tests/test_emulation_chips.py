"""Register-level behaviour of the emulated MCP23017 and ADS1115."""
import pytest

from glasgow_service.emulation.chips import (
    ADS1115,
    ADS_REG_CONFIG,
    ADS_REG_CONVERSION,
    MCP23017,
    MCP_REG,
)


class Net:
    def __init__(self):
        self.pins = 0xFFFF
        self.powered = True
        self.reset_n = True
        self.now = 0.0
        self.ain = [0.0, 0.0, 0.0, 0.0]


@pytest.fixture
def mcp():
    net = Net()
    chip = MCP23017("U", pin_inputs=lambda: net.pins, powered=lambda: net.powered,
                    reset_n=lambda: net.reset_n)
    return chip, net


def wr(chip, reg, *values):
    chip.i2c_write(bytes([reg, *values]))


def rd(chip, reg, n=1):
    chip.i2c_write(bytes([reg]))
    return list(chip.i2c_read(n))


def test_mcp_power_on_state_and_sequential_access(mcp):
    chip, _ = mcp
    assert rd(chip, MCP_REG["IODIRA"], 2) == [0xFF, 0xFF]
    wr(chip, MCP_REG["OLATA"], 0x12, 0x34)        # pointer auto-increments
    assert rd(chip, MCP_REG["OLATA"], 2) == [0x12, 0x34]
    wr(chip, MCP_REG["IOCON"], 0x20)               # SEQOP=1: byte mode
    wr(chip, MCP_REG["OLATA"], 0x01, 0x02)
    assert rd(chip, MCP_REG["OLATA"], 1) == [0x02]


def test_mcp_outputs_follow_iodir_and_gpio_writes_olat(mcp):
    chip, _ = mcp
    wr(chip, MCP_REG["GPIOA"], 0xAA)
    assert chip.output_word() == 0                 # still inputs
    wr(chip, MCP_REG["IODIRA"], 0x00)
    assert chip.output_word() & 0xFF == 0xAA


def test_mcp_ipol_inverts_inputs_only(mcp):
    chip, net = mcp
    net.pins = 0x00F0
    wr(chip, MCP_REG["IPOLA"], 0xFF)
    assert rd(chip, MCP_REG["GPIOA"]) == [0x0F]


def test_mcp_interrupt_on_change_latches_intcap_and_clears_on_read(mcp):
    chip, net = mcp
    wr(chip, MCP_REG["IOCON"], 0x44)               # MIRROR | ODR
    wr(chip, MCP_REG["GPINTENA"], 0xFF, 0xFF)
    assert chip.int_pin(0) is None                 # open drain, released
    net.pins = 0xFFFE
    chip.tick(0, 0)
    assert chip.int_pin(0) is False
    assert rd(chip, MCP_REG["INTFA"]) == [0x01]
    net.pins = 0xFFFC                              # second change: no recapture
    chip.tick(0, 0)
    assert rd(chip, MCP_REG["INTCAPA"]) == [0xFE]  # read clears
    assert chip.int_pin(0) is None


def test_mcp_interrupt_mirror_routes_port_b_to_inta(mcp):
    chip, net = mcp
    wr(chip, MCP_REG["IOCON"], 0x44)
    wr(chip, MCP_REG["GPINTENB"], 0xFF)
    net.pins = 0x7FFF
    chip.tick(0, 0)
    assert chip.int_pin(0) is False


def test_mcp_bank1_register_map(mcp):
    chip, _ = mcp
    wr(chip, MCP_REG["IOCON"], 0x80)               # switch to BANK=1
    wr(chip, 0x0A, 0x55)                           # OLATA in bank 1
    wr(chip, 0x1A, 0x66)                           # OLATB in bank 1
    assert chip.regs["OLAT"] == [0x55, 0x66]


def test_mcp_reset_and_power_loss_restore_por_and_nack(mcp):
    chip, net = mcp
    wr(chip, MCP_REG["IODIRA"], 0x00)
    wr(chip, MCP_REG["OLATA"], 0xFF)
    net.reset_n = False
    assert chip.output_word() == 0
    with pytest.raises(OSError):
        rd(chip, MCP_REG["IODIRA"])
    net.reset_n = True
    assert rd(chip, MCP_REG["IODIRA"]) == [0xFF]
    assert chip.resets == 1


@pytest.fixture
def adc():
    net = Net()
    chip = ADS1115("ADC", analog_inputs=lambda: net.ain, vdd=lambda: 3.3 if net.powered else 0,
                   now=lambda: net.now)
    return chip, net


def adc_write(chip, reg, value):
    chip.i2c_write(bytes([reg, value >> 8, value & 0xFF]))


def adc_read(chip, reg):
    chip.i2c_write(bytes([reg]))
    hi, lo = chip.i2c_read(2)
    return (hi << 8) | lo


def test_ads_default_config_and_single_shot_timing(adc):
    chip, net = adc
    assert adc_read(chip, ADS_REG_CONFIG) == 0x8583
    net.ain[1] = 1.0
    # OS=1, AIN1 vs GND, FSR 4.096, single shot, 250 SPS
    adc_write(chip, ADS_REG_CONFIG, 0x8000 | (0b101 << 12) | (0b001 << 9) | 0x0100 | (5 << 5) | 3)
    assert adc_read(chip, ADS_REG_CONFIG) & 0x8000 == 0      # converting
    net.now += 1 / 250 + 1e-6
    assert adc_read(chip, ADS_REG_CONFIG) & 0x8000
    assert adc_read(chip, ADS_REG_CONVERSION) == round(1.0 / 4.096 * 32768)


def test_ads_clamps_to_full_scale_and_supports_negative_differential(adc):
    chip, net = adc
    net.ain[0], net.ain[1] = 0.2, 3.3
    adc_write(chip, ADS_REG_CONFIG, 0x8000 | (0b000 << 12) | (0b011 << 9) | 0x0100 | (7 << 5) | 3)
    net.now += 0.01
    raw = adc_read(chip, ADS_REG_CONVERSION)
    assert raw == 0x8000                            # -1.024 V full scale


def test_ads_conversion_ready_alert_and_general_call_reset(adc):
    chip, net = adc
    adc_write(chip, 2, 0x0000)
    adc_write(chip, 3, 0x8000)                      # conversion-ready mode
    adc_write(chip, ADS_REG_CONFIG, 0x8000 | (0b100 << 12) | (0b001 << 9) | 0x0100 | (7 << 5) | 0)
    assert chip.alert_pin() is None
    net.now += 0.01
    chip.tick(net.now, 0.01)
    assert chip.alert_pin() is False                # asserted low
    chip.general_call(b"\x06")
    assert adc_read(chip, ADS_REG_CONFIG) == 0x8583


def test_ads_unpowered_nacks(adc):
    chip, net = adc
    net.powered = False
    assert not chip.i2c_acks()
    with pytest.raises(OSError):
        adc_read(chip, ADS_REG_CONFIG)
