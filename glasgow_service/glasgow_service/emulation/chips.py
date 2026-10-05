"""Register-level models of the I2C chips on the RPi5VacuumIO board.

* :class:`MCP23017` - Microchip DS20001952C: both IOCON.BANK layouts,
  sequential addressing, IPOL, interrupt-on-change / compare-to-DEFVAL with
  INTF/INTCAP latching, MIRROR / ODR / INTPOL, ~RESET and power-on reset.
* :class:`ADS1115` - TI SBAS444D: pointer register, single-shot and
  continuous conversion with data-rate timing, PGA full-scale ranges,
  input multiplexer, comparator incl. conversion-ready (ALERT/RDY) mode,
  general-call reset.
"""
from __future__ import annotations

from typing import Callable

# ===================================================================== MCP23017

# Logical register names, per port.
_PORT_REGS = ["IODIR", "IPOL", "GPINTEN", "DEFVAL", "INTCON", "IOCON",
              "GPPU", "INTF", "INTCAP", "GPIO", "OLAT"]

IOCON_BANK = 0x80
IOCON_MIRROR = 0x40
IOCON_SEQOP = 0x20
IOCON_DISSLW = 0x10
IOCON_HAEN = 0x08
IOCON_ODR = 0x04
IOCON_INTPOL = 0x02


def _bank0_map() -> dict[int, tuple[str, int]]:
    out = {}
    for index, name in enumerate(_PORT_REGS):
        out[2 * index] = (name, 0)
        out[2 * index + 1] = (name, 1)
    return out


def _bank1_map() -> dict[int, tuple[str, int]]:
    out = {}
    for index, name in enumerate(_PORT_REGS):
        out[index] = (name, 0)
        out[0x10 + index] = (name, 1)
    return out


MCP23017_BANK0 = _bank0_map()
MCP23017_BANK1 = _bank1_map()
#: Bank-0 addresses by name, for drivers and tests.
MCP_REG = {f"{name}{'AB'[port]}": addr for addr, (name, port) in MCP23017_BANK0.items()}
MCP_REG["IOCON"] = 0x0A


class MCP23017:
    """16-bit I/O expander.

    ``pin_inputs`` returns the electrical level on each of the 16 pins as
    seen from outside (bit 0..7 = GPA0..7, bit 8..15 = GPB0..7) for pins that
    are inputs.  ``powered`` and ``reset_n`` are callables evaluated on every
    access so the model follows the carrier board's nets.
    """

    def __init__(self, name: str, *, pin_inputs: Callable[[], int],
                 powered: Callable[[], bool], reset_n: Callable[[], bool]) -> None:
        self.name = name
        self._pin_inputs = pin_inputs
        self._powered = powered
        self._reset_n = reset_n
        self._pointer = 0
        self._expect_pointer = True
        self.resets = 0
        self._por()

    # ------------------------------------------------------------- state
    def _por(self) -> None:
        self.regs = {name: [0, 0] for name in _PORT_REGS}
        self.regs["IODIR"] = [0xFF, 0xFF]
        self._last_pins = self._safe_pins()
        self._pointer = 0
        self._expect_pointer = True

    def _safe_pins(self) -> int:
        try:
            return self._pin_inputs() & 0xFFFF
        except Exception:
            return 0

    @property
    def active(self) -> bool:
        return self._powered() and self._reset_n()

    def _check_reset(self) -> bool:
        if not self.active:
            if not getattr(self, "_held", False):
                self._held = True
            self._por()
            return False
        if getattr(self, "_held", False):
            self._held = False
            self.resets += 1
        return True

    def tick(self, now: float, dt: float) -> None:
        if self._check_reset():
            self._update_interrupts()

    @property
    def iocon(self) -> int:
        return self.regs["IOCON"][0]

    def _map(self) -> dict[int, tuple[str, int]]:
        return MCP23017_BANK1 if self.iocon & IOCON_BANK else MCP23017_BANK0

    # ------------------------------------------------------------- pins
    def output_word(self) -> int:
        """Driven level of output pins (bit set = high).  Input pins read 0."""
        if not self.active:
            return 0
        dirs = self.regs["IODIR"][0] | (self.regs["IODIR"][1] << 8)
        olat = self.regs["OLAT"][0] | (self.regs["OLAT"][1] << 8)
        return olat & ~dirs & 0xFFFF

    def output_enabled(self) -> int:
        """Bit set where the pin is an actively driven output."""
        if not self.active:
            return 0
        dirs = self.regs["IODIR"][0] | (self.regs["IODIR"][1] << 8)
        return ~dirs & 0xFFFF

    def _port_value(self, port: int) -> int:
        """GPIO register read value for one port."""
        pins = self._safe_pins()
        dirs = self.regs["IODIR"][port]
        ipol = self.regs["IPOL"][port]
        olat = self.regs["OLAT"][port]
        pin_byte = (pins >> (8 * port)) & 0xFF
        # Pull-ups make an unconnected input read high.
        pin_byte |= self.regs["GPPU"][port] & ~self._driven_mask(port) & 0xFF
        inputs = (pin_byte ^ ipol) & dirs
        outputs = olat & ~dirs & 0xFF
        return (inputs | outputs) & 0xFF

    def _driven_mask(self, port: int) -> int:
        # The emulated carrier always drives every pin it wires; pull-ups
        # only matter for NC pins.  Callers can override via subclassing.
        return 0xFF

    # ------------------------------------------------------------- interrupts
    def _update_interrupts(self) -> None:
        pins = self._safe_pins()
        for port in (0, 1):
            enabled = self.regs["GPINTEN"][port] & self.regs["IODIR"][port]
            if not enabled:
                continue
            new = (pins >> (8 * port)) & 0xFF
            old = (self._last_pins >> (8 * port)) & 0xFF
            intcon = self.regs["INTCON"][port]
            defval = self.regs["DEFVAL"][port]
            changed = (new ^ old) & ~intcon
            compare = (new ^ defval) & intcon
            trigger = (changed | compare) & enabled
            if trigger and not self.regs["INTF"][port]:
                self.regs["INTF"][port] = trigger
                self.regs["INTCAP"][port] = self._port_value(port)
            elif trigger:
                # Already pending: further conditions do not re-capture.
                pass
            # Compare-mode interrupts stay asserted while the condition holds.
        self._last_pins = pins

    def int_active(self, port: int) -> bool:
        if not self.active:
            return False
        a = bool(self.regs["INTF"][0])
        b = bool(self.regs["INTF"][1])
        if self.iocon & IOCON_MIRROR:
            return a or b
        return a if port == 0 else b

    def int_pin(self, port: int) -> bool | None:
        """INTA (0) / INTB (1) pin: True/False driven, None = high impedance."""
        if not self.active:
            return None
        active = self.int_active(port)
        if self.iocon & IOCON_ODR:
            return False if active else None
        polarity = bool(self.iocon & IOCON_INTPOL)
        return polarity if active else (not polarity)

    def _clear_interrupt(self, port: int) -> None:
        intcon = self.regs["INTCON"][port]
        if intcon & self.regs["INTF"][port]:
            # Compare mode: the interrupt clears only if the condition is gone.
            pins = (self._safe_pins() >> (8 * port)) & 0xFF
            still = (pins ^ self.regs["DEFVAL"][port]) & intcon & self.regs["INTF"][port]
            self.regs["INTF"][port] = still
            if still:
                self.regs["INTCAP"][port] = self._port_value(port)
        else:
            self.regs["INTF"][port] = 0

    # ------------------------------------------------------------- I2C
    def i2c_acks(self) -> bool:
        return self._check_reset()

    def _advance_pointer(self) -> None:
        if self.iocon & IOCON_SEQOP:
            return  # byte mode: pointer does not increment
        table = self._map()
        nxt = self._pointer + 1
        if self.iocon & IOCON_BANK:
            # Bank 1: toggles within the A block (0x00-0x0A) / B block.
            if nxt not in table:
                nxt = 0x00 if self._pointer < 0x10 else 0x10
        elif nxt > 0x15:
            nxt = 0x00
        self._pointer = nxt

    def i2c_write(self, data: bytes) -> None:
        if not self._check_reset():
            raise OSError(121, "Remote I/O error")
        if not data:
            return
        self._pointer = data[0]
        for value in data[1:]:
            self._write_reg(self._pointer, value)
            self._advance_pointer()

    def i2c_read(self, length: int) -> bytes:
        if not self._check_reset():
            raise OSError(121, "Remote I/O error")
        out = bytearray()
        for _ in range(length):
            out.append(self._read_reg(self._pointer))
            self._advance_pointer()
        return bytes(out)

    def _write_reg(self, address: int, value: int) -> None:
        entry = self._map().get(address)
        if entry is None:
            return
        name, port = entry
        value &= 0xFF
        if name == "IOCON":
            value &= 0xFE  # bit 0 unimplemented
            self.regs["IOCON"] = [value, value]
        elif name in ("INTF", "INTCAP"):
            return  # read-only
        elif name == "GPIO":
            self.regs["OLAT"][port] = value
        else:
            self.regs[name][port] = value
        self._update_interrupts()

    def _read_reg(self, address: int) -> int:
        entry = self._map().get(address)
        if entry is None:
            return 0
        name, port = entry
        if name == "GPIO":
            value = self._port_value(port)
            self._clear_interrupt(port)
            return value
        if name == "INTCAP":
            value = self.regs["INTCAP"][port]
            self._clear_interrupt(port)
            return value
        return self.regs[name][port]


# ===================================================================== ADS1115

ADS_REG_CONVERSION = 0x00
ADS_REG_CONFIG = 0x01
ADS_REG_LO_THRESH = 0x02
ADS_REG_HI_THRESH = 0x03

ADS_FSR = {0: 6.144, 1: 4.096, 2: 2.048, 3: 1.024, 4: 0.512, 5: 0.256, 6: 0.256, 7: 0.256}
ADS_DATA_RATE = {0: 8, 1: 16, 2: 32, 3: 64, 4: 128, 5: 250, 6: 475, 7: 860}
ADS_CONFIG_DEFAULT = 0x8583
#: MUX field -> (positive input, negative input or None for GND)
ADS_MUX = {0: (0, 1), 1: (0, 3), 2: (1, 3), 3: (2, 3),
           4: (0, None), 5: (1, None), 6: (2, None), 7: (3, None)}


class ADS1115:
    """16-bit delta-sigma ADC with PGA and comparator.

    ``analog_inputs`` returns the four AINx voltages (relative to GND) at the
    instant of the call; ``vdd`` returns the supply voltage (0 = unpowered).
    ``now`` is the emulated clock.
    """

    def __init__(self, name: str, *, analog_inputs: Callable[[], list[float]],
                 vdd: Callable[[], float], now: Callable[[], float]) -> None:
        self.name = name
        self._inputs = analog_inputs
        self._vdd = vdd
        self._now = now
        self._was_powered = False
        self._reset()

    def _reset(self) -> None:
        self.config = ADS_CONFIG_DEFAULT
        self.lo_thresh = 0x8000
        self.hi_thresh = 0x7FFF
        self.conversion = 0
        self._pointer = 0
        self._busy_until: float | None = None
        self._continuous_next: float | None = None
        self._alert_active = False
        self._comp_count = 0
        self._rdy_pending = False

    # ------------------------------------------------------------- helpers
    @property
    def powered(self) -> bool:
        return self._vdd() >= 2.0

    def _check_power(self) -> bool:
        if not self.powered:
            self._was_powered = False
            return False
        if not self._was_powered:
            self._was_powered = True
            self._reset()
        return True

    @property
    def fsr(self) -> float:
        return ADS_FSR[(self.config >> 9) & 0x7]

    @property
    def data_rate(self) -> int:
        return ADS_DATA_RATE[(self.config >> 5) & 0x7]

    @property
    def single_shot(self) -> bool:
        return bool(self.config & 0x0100)

    def _sample(self) -> int:
        pos, neg = ADS_MUX[(self.config >> 12) & 0x7]
        values = self._inputs()
        vdd = self._vdd()
        # Inputs are clamped by the ESD structure to GND-0.3 .. VDD+0.3.
        clamp = lambda v: max(-0.3, min(vdd + 0.3, v))  # noqa: E731
        v = clamp(values[pos]) - (clamp(values[neg]) if neg is not None else 0.0)
        code = round(v / self.fsr * 32768)
        return max(-32768, min(32767, code))

    def _finish(self, now: float) -> None:
        code = self._sample()
        self.conversion = code & 0xFFFF
        self._comparator(code)
        if self.single_shot:
            self._busy_until = None
            self.config |= 0x8000  # OS reads 1: idle
        else:
            self._continuous_next = now + 1.0 / self.data_rate

    def _comparator(self, code: int) -> None:
        que = self.config & 0x3
        if que == 0x3:
            self._alert_active = False
            return
        lo = self.lo_thresh - 0x10000 if self.lo_thresh & 0x8000 else self.lo_thresh
        hi = self.hi_thresh - 0x10000 if self.hi_thresh & 0x8000 else self.hi_thresh
        if (self.hi_thresh & 0x8000) and not (self.lo_thresh & 0x8000):
            # Conversion-ready mode: pulse/assert at end of every conversion.
            self._alert_active = True
            self._rdy_pending = True
            return
        window = bool(self.config & 0x10)
        latching = bool(self.config & 0x04)
        if window:
            exceed = code > hi or code < lo
        else:
            exceed = code > hi
        if exceed:
            self._comp_count += 1
            if self._comp_count >= {0: 1, 1: 2, 2: 4}[que]:
                self._alert_active = True
        else:
            self._comp_count = 0
            if not latching and (window or code < lo):
                self._alert_active = False

    def _settle(self) -> None:
        now = self._now()
        if self._busy_until is not None and now >= self._busy_until:
            self._finish(self._busy_until)
        while (self._continuous_next is not None and not self.single_shot
               and now >= self._continuous_next):
            self._finish(self._continuous_next)

    def tick(self, now: float, dt: float) -> None:
        if self._check_power():
            self._settle()

    def alert_pin(self) -> bool | None:
        """ALERT/RDY open-drain output: False when asserted, None = Hi-Z."""
        if not self.powered or (self.config & 0x3) == 0x3:
            return None
        active_high = bool(self.config & 0x08)
        if self._alert_active:
            return True if active_high else False
        return False if active_high else None

    # ------------------------------------------------------------- I2C
    def i2c_acks(self) -> bool:
        return self._check_power()

    def general_call(self, data: bytes) -> None:
        if data[:1] == b"\x06":
            self._reset()

    def i2c_write(self, data: bytes) -> None:
        if not self._check_power():
            raise OSError(121, "Remote I/O error")
        self._settle()
        if not data:
            return
        self._pointer = data[0] & 0x3
        if len(data) < 3:
            return
        value = (data[1] << 8) | data[2]
        if self._pointer == ADS_REG_CONFIG:
            start = bool(value & 0x8000)
            self.config = value & 0x7FFF
            now = self._now()
            if self.single_shot:
                if start and self._busy_until is None:
                    self._busy_until = now + 1.0 / self.data_rate
                    self._continuous_next = None
                    if self._rdy_pending:
                        self._alert_active = False
                        self._rdy_pending = False
                elif self._busy_until is None:
                    self.config |= 0x8000
            else:
                self._busy_until = None
                self._continuous_next = now + 1.0 / self.data_rate
        elif self._pointer == ADS_REG_LO_THRESH:
            self.lo_thresh = value
        elif self._pointer == ADS_REG_HI_THRESH:
            self.hi_thresh = value

    def i2c_read(self, length: int) -> bytes:
        if not self._check_power():
            raise OSError(121, "Remote I/O error")
        self._settle()
        if self._pointer == ADS_REG_CONVERSION:
            value = self.conversion
            # Latching comparator clears on a conversion-register read.
            if self.config & 0x04:
                self._alert_active = False
        elif self._pointer == ADS_REG_CONFIG:
            value = self.config
            if self._busy_until is not None:
                value &= 0x7FFF  # OS = 0 while converting
        elif self._pointer == ADS_REG_LO_THRESH:
            value = self.lo_thresh
        else:
            value = self.hi_thresh
        raw = bytes([(value >> 8) & 0xFF, value & 0xFF])
        return (raw * ((length + 1) // 2))[:length]
