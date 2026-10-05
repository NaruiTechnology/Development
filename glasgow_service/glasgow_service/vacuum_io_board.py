"""Driver for the RPi5VacuumIO rev A.1 vacuum interface board.

The board (``GlasgowDataIO/Hardware/VacuumController/RPi5VacuumIO``) plugs
into the 40-pin header of a **Raspberry Pi 4 Model B or Raspberry Pi 5**;
pin use is identical on both.  This module implements the
:class:`~glasgow_service.vacuum_device.VacuumDevice` protocol on top of two
small hardware-abstraction seams:

* an smbus2-compatible I2C bus (``/dev/i2c-1``), and
* :class:`GpioHAL` - claim/read/write/PWM on BCM lines (lgpio in production).

The same code runs on real hardware (:class:`LgpioHAL` + ``smbus2.SMBus``)
and on the emulator (``glasgow_service.emulation``).

Board resources (see the board README):

==========  ===============================================================
U1 0x20     MCP23017: GPA0..7 -> K1..K8 relays, GPB0..7 -> V1..V8 solenoids
U3 0x21     MCP23017: GPA0..7 = DI1..8, GPB0..7 = DI9..16 (active low)
U9 / U10    ADS1115 0x48 (AI1..4) / 0x49 (AI5..8) behind a 68k/22k divider
GPIO22      IO_RESET_N - expanders held in reset (all outputs off) while low
GPIO19      heartbeat into the K10 charge-pump watchdog (1 kHz)
GPIO5 / 6   ESTOP_OK_N / SAFE_OK_N rail status, low = rail live
GPIO27/23   expander interrupt / ADC ALERT-RDY (open drain, pulled up)
GPIO18      RS-485 driver enable
GPIO26      RUN LED
==========  ===============================================================
"""
from __future__ import annotations

import asyncio
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Literal, Mapping, Protocol

# ------------------------------------------------------------------ constants

ADDR_OUTPUTS = 0x20
ADDR_INPUTS = 0x21
ADDR_ADC = (0x48, 0x49)

# MCP23017 registers, IOCON.BANK = 0
IODIRA, IODIRB = 0x00, 0x01
IPOLA, IPOLB = 0x02, 0x03
GPINTENA, GPINTENB = 0x04, 0x05
INTCONA, INTCONB = 0x08, 0x09
IOCON = 0x0A
GPPUA, GPPUB = 0x0C, 0x0D
GPIOA, GPIOB = 0x12, 0x13
OLATA, OLATB = 0x14, 0x15
IOCON_MIRROR = 0x40
IOCON_ODR = 0x04

# ADS1115
ADS_CONVERSION, ADS_CONFIG, ADS_LO, ADS_HI = 0, 1, 2, 3
ADS_PGA_4V096 = 0b001
ADS_FSR = 4.096
ADS_DR_CODES = {8: 0, 16: 1, 32: 2, 64: 3, 128: 4, 250: 5, 475: 6, 860: 7}
DIVIDER_RATIO = 22.0 / 90.0      # R15x / (R14x + R15x)

BCM_IO_RESET_N = 22
BCM_HEARTBEAT = 19
BCM_ESTOP_OK_N = 5
BCM_SAFE_OK_N = 6
BCM_DI_INT = 27
BCM_ADC_ALRT = 23
BCM_RS485_DE = 18
BCM_RUN_LED = 26

BOARD_ID = "RPi5VacuumIO-A"


class GpioHAL(Protocol):
    def setup_output(self, bcm: int, level: bool) -> None: ...
    def setup_input(self, bcm: int, pull: str | None = None) -> None: ...
    def write(self, bcm: int, level: bool) -> None: ...
    def read(self, bcm: int) -> bool: ...
    def pwm(self, bcm: int, frequency: float, duty_percent: float) -> None: ...
    def close(self) -> None: ...


class SMBusLike(Protocol):
    def write_byte_data(self, addr: int, reg: int, value: int) -> None: ...
    def read_byte_data(self, addr: int, reg: int) -> int: ...
    def write_i2c_block_data(self, addr: int, reg: int, data: list[int]) -> None: ...
    def read_i2c_block_data(self, addr: int, reg: int, length: int) -> list[int]: ...


class BoardError(RuntimeError):
    """Board-level failure; the controller treats it like a read failure."""


class ExpanderResetError(BoardError):
    """U1 lost its configuration (brown-out / reset): outputs went off."""


class WatchdogTrippedError(BoardError):
    """The keep-alive stopped the heartbeat; +24V_SAFE is off."""


# ------------------------------------------------------------------ config

@dataclass(frozen=True)
class GaugeChannel:
    """Conversion of one AI input to pressure.

    ``log``: p = 10^(slope * U + offset); ``linear``: p = slope * U + offset.
    Voltages outside [min_volts, max_volts] mean sensor error / unplugged.
    """
    ain: int
    law: Literal["log", "linear"] = "log"
    slope: float = 1.0
    offset: float = 0.0
    min_volts: float = 0.5
    max_volts: float = 10.0
    interlock: bool = False

    def pressure(self, volts: float) -> float | None:
        if not (self.min_volts <= volts <= self.max_volts):
            return None
        if self.law == "log":
            value = 10.0 ** (self.slope * volts + self.offset)
        else:
            value = self.slope * volts + self.offset
        return value if math.isfinite(value) else None


@dataclass
class BoardStatus:
    board: str = BOARD_ID
    estop_ok: bool = False
    output_rail_ok: bool = False
    heartbeat: bool = False
    keepalive_tripped: bool = False
    expander_resets: int = 0
    inputs: dict[str, bool] = field(default_factory=dict)
    relays: dict[str, bool] = field(default_factory=dict)
    solenoids: dict[str, bool] = field(default_factory=dict)
    analog_volts: dict[str, float | None] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "board": self.board, "estop_ok": self.estop_ok,
            "output_rail_ok": self.output_rail_ok, "heartbeat": self.heartbeat,
            "keepalive_tripped": self.keepalive_tripped,
            "expander_resets": self.expander_resets,
            "inputs": dict(self.inputs), "relays": dict(self.relays),
            "solenoids": dict(self.solenoids), "analog_volts": dict(self.analog_volts),
        }


def _parse_index(text: str, prefix: str, high: int) -> int:
    if not text.startswith(prefix) or not text[len(prefix):].isdigit():
        raise ValueError(f"{text!r} is not a {prefix}1..{prefix}{high} channel")
    n = int(text[len(prefix):])
    if not 1 <= n <= high:
        raise ValueError(f"{text!r} is not a {prefix}1..{prefix}{high} channel")
    return n


# ------------------------------------------------------------------ driver

class RPi5VacuumIODevice:
    """``VacuumDevice`` implementation for the board.

    ``outputs`` maps logical A channels to relays (``{"A0": "K1"}``),
    ``inputs`` maps B channels to opto inputs (``{"B0": "DI1"}``), ``faults``
    maps B channels to "healthy = ON" fault inputs and ``gauges`` maps B
    channels to :class:`GaugeChannel` conversions.
    """

    KEEPALIVE_POLL = 0.1

    def __init__(
        self,
        outputs: Mapping[str, str],
        inputs: Mapping[str, str],
        *,
        bus_factory: Callable[[], SMBusLike],
        gpio: GpioHAL,
        gauges: Mapping[str, GaugeChannel] | None = None,
        faults: Mapping[str, str] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        heartbeat_hz: float = 1000.0,
        keepalive_seconds: float = 3.0,
        adc_data_rate: int = 250,
        rail_wait_seconds: float = 0.5,
        keepalive_thread: bool = True,
        transport: str = "rpi5-vacuum-io",
    ) -> None:
        self._relay_of = {pin: _parse_index(k, "K", 8) for pin, k in outputs.items()}
        self._di_of = {pin: _parse_index(d, "DI", 16) for pin, d in inputs.items()}
        self._fault_di = {pin: _parse_index(d, "DI", 16) for pin, d in (faults or {}).items()}
        self._gauges = dict(gauges or {})
        if len(set(self._relay_of.values())) != len(self._relay_of):
            raise ValueError("each output channel needs its own relay")
        used_di = list(self._di_of.values()) + list(self._fault_di.values())
        if len(set(used_di)) != len(used_di):
            raise ValueError("ready and fault inputs must use distinct DI channels")
        for pin, gauge in self._gauges.items():
            if pin not in self._di_of:
                raise ValueError(f"gauge {pin} is not a configured input channel")
            if not 1 <= gauge.ain <= 8:
                raise ValueError(f"gauge {pin}: AI{gauge.ain} does not exist")
        if adc_data_rate not in ADS_DR_CODES:
            raise ValueError(f"ADS1115 data rate must be one of {sorted(ADS_DR_CODES)}")

        self._bus_factory = bus_factory
        self._bus: SMBusLike | None = None
        self._gpio = gpio
        self._sleep = sleep
        self._monotonic = monotonic
        self._heartbeat_hz = heartbeat_hz
        self._keepalive_seconds = keepalive_seconds
        self._adc_rate = adc_data_rate
        self._rail_wait = rail_wait_seconds
        self._use_thread = keepalive_thread
        self.transport = transport

        self._lock = threading.RLock()
        self._gpio_ready = False
        self._opened = False
        self._olat = [0, 0]           # what the driver last wrote
        self._olat_readback = [0, 0]  # what U1 reported back
        self._inputs_word = 0
        self._heartbeat = False
        self._tripped = False
        self._last_kick = 0.0
        self._expander_resets = 0
        self._analog: dict[str, float | None] = {}
        self._keepalive_stop = threading.Event()
        self._keepalive_thread: threading.Thread | None = None
        self._estop_ok = False
        self._rail_ok = False

    # ------------------------------------------------------------- lifecycle
    async def open(self) -> None:
        await asyncio.to_thread(self._open_sync)

    def _open_sync(self) -> None:
        with self._lock:
            g = self._gpio
            if not self._gpio_ready:
                g.setup_output(BCM_IO_RESET_N, False)
                g.setup_output(BCM_HEARTBEAT, False)
                g.setup_output(BCM_RUN_LED, False)
                g.setup_output(BCM_RS485_DE, False)
                for bcm in (BCM_ESTOP_OK_N, BCM_SAFE_OK_N, BCM_DI_INT, BCM_ADC_ALRT):
                    g.setup_input(bcm, None)   # board has external pull-ups
                self._gpio_ready = True
            # Pulse reset: every output starts from the hardware-off state.
            g.write(BCM_IO_RESET_N, False)
            self._sleep(0.001)
            g.write(BCM_IO_RESET_N, True)
            self._sleep(0.001)
            if self._bus is None:
                self._bus = self._bus_factory()
            self._configure_expanders()
            self._configure_adcs()
            self._tripped = False
            self._last_kick = self._monotonic()
            g.pwm(BCM_HEARTBEAT, self._heartbeat_hz, 50.0)
            self._heartbeat = True
            g.write(BCM_RUN_LED, True)
            self._opened = True
            self._wait_for_output_rail()
        self._start_keepalive_thread()

    def _configure_expanders(self) -> None:
        bus = self._bus
        try:
            # Outputs: latches low before the pins become outputs.
            bus.write_i2c_block_data(ADDR_OUTPUTS, OLATA, [0x00, 0x00])
            bus.write_i2c_block_data(ADDR_OUTPUTS, IODIRA, [0x00, 0x00])
            # Inputs: optos pull low when active -> invert; one open-drain
            # interrupt (INTA only is wired) covering both ports.
            bus.write_byte_data(ADDR_INPUTS, IOCON, IOCON_MIRROR | IOCON_ODR)
            bus.write_i2c_block_data(ADDR_INPUTS, IODIRA, [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
            bus.write_i2c_block_data(ADDR_INPUTS, INTCONA, [0x00, 0x00])
            bus.write_i2c_block_data(ADDR_INPUTS, GPPUA, [0x00, 0x00])
            iodir = bus.read_i2c_block_data(ADDR_OUTPUTS, IODIRA, 2)
            iocon = bus.read_byte_data(ADDR_INPUTS, IOCON)
            ipol = bus.read_i2c_block_data(ADDR_INPUTS, IPOLA, 2)
        except OSError as exc:
            raise BoardError(f"vacuum I/O board not responding on I2C: {exc}") from exc
        if iodir != [0, 0] or iocon != (IOCON_MIRROR | IOCON_ODR) or ipol != [0xFF, 0xFF]:
            raise BoardError("vacuum I/O board expander configuration did not verify")
        self._olat = [0, 0]
        self._olat_readback = [0, 0]

    def _configure_adcs(self) -> None:
        for addr in ADDR_ADC:
            try:
                # Comparator in conversion-ready mode: ALERT/RDY marks each
                # finished conversion (GPIO23); the driver polls OS anyway.
                self._bus.write_i2c_block_data(addr, ADS_LO, [0x00, 0x00])
                self._bus.write_i2c_block_data(addr, ADS_HI, [0x80, 0x00])
            except OSError as exc:
                raise BoardError(f"ADS1115 0x{addr:02x} not responding: {exc}") from exc

    def _wait_for_output_rail(self) -> None:
        deadline = self._monotonic() + self._rail_wait
        while True:
            self._read_rails()
            if self._rail_ok or not self._estop_ok or self._monotonic() >= deadline:
                return
            self._sleep(0.005)

    async def close(self) -> None:
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        self._stop_keepalive_thread()
        with self._lock:
            if not self._gpio_ready:
                return
            errors = []
            try:
                if self._bus is not None:
                    self._bus.write_i2c_block_data(ADDR_OUTPUTS, OLATA, [0x00, 0x00])
            except OSError as exc:
                errors.append(str(exc))
            self._olat = [0, 0]
            self._olat_readback = [0, 0]
            # Stop the heartbeat and hold the expanders in reset: the hardware
            # guarantees every relay and solenoid is off from here on.
            self._gpio.pwm(BCM_HEARTBEAT, 0, 0)
            self._heartbeat = False
            self._gpio.write(BCM_RUN_LED, False)
            self._gpio.write(BCM_IO_RESET_N, False)
            self._opened = False
            if errors:
                raise BoardError("; ".join(errors))

    def shutdown(self) -> None:
        """Release GPIO lines (process exit)."""
        try:
            self._close_sync()
        finally:
            self._gpio.close()
            self._gpio_ready = False

    # ------------------------------------------------------------- keep-alive
    def kick(self) -> None:
        self._last_kick = self._monotonic()

    def check_keepalive(self) -> bool:
        """Stop the heartbeat if the control loop has not polled in time.

        Returns True when the keep-alive has tripped.
        """
        with self._lock:
            if (self._heartbeat and not self._tripped and
                    self._monotonic() - self._last_kick > self._keepalive_seconds):
                self._gpio.pwm(BCM_HEARTBEAT, 0, 0)
                self._gpio.write(BCM_RUN_LED, False)
                self._heartbeat = False
                self._tripped = True
            return self._tripped

    def _start_keepalive_thread(self) -> None:
        if not self._use_thread or self._keepalive_thread is not None:
            return
        self._keepalive_stop.clear()

        def run() -> None:
            while not self._keepalive_stop.wait(self.KEEPALIVE_POLL):
                try:
                    self.check_keepalive()
                except Exception:
                    pass

        self._keepalive_thread = threading.Thread(
            target=run, name="vacuum-io-keepalive", daemon=True)
        self._keepalive_thread.start()

    def _stop_keepalive_thread(self) -> None:
        self._keepalive_stop.set()
        if self._keepalive_thread is not None:
            self._keepalive_thread.join(timeout=1.0)
            self._keepalive_thread = None

    async def rearm(self) -> None:
        """Restart the heartbeat after a keep-alive trip (operator resume)."""
        def run() -> None:
            with self._lock:
                if not self._opened:
                    raise BoardError("vacuum I/O board is closed")
                self._tripped = False
                self._last_kick = self._monotonic()
                self._gpio.pwm(BCM_HEARTBEAT, self._heartbeat_hz, 50.0)
                self._gpio.write(BCM_RUN_LED, True)
                self._heartbeat = True
                self._wait_for_output_rail()
        await asyncio.to_thread(run)

    # ------------------------------------------------------------- VacuumDevice
    def _require_open(self) -> SMBusLike:
        if not self._opened or self._bus is None:
            raise BoardError("vacuum I/O board is not open")
        return self._bus

    async def write(self, pin: str, value: bool) -> None:
        if pin not in self._relay_of:
            raise ValueError(f"unknown vacuum output pin: {pin}")
        await asyncio.to_thread(self._write_relay_sync, self._relay_of[pin], bool(value))

    def _write_relay_sync(self, relay: int, value: bool) -> None:
        self._write_bit_sync(0, relay - 1, value)

    async def write_solenoid(self, number: int, value: bool) -> None:
        """Drive solenoid output Vn (1..8).  Not used by the cascade yet."""
        if not 1 <= number <= 8:
            raise ValueError("solenoid outputs are V1..V8")
        await asyncio.to_thread(self._write_bit_sync, 1, number - 1, bool(value))

    def _write_bit_sync(self, port: int, bit: int, value: bool) -> None:
        with self._lock:
            bus = self._require_open()
            new = (self._olat[port] | (1 << bit)) if value else (self._olat[port] & ~(1 << bit))
            try:
                bus.write_byte_data(ADDR_OUTPUTS, OLATA + port, new)
                readback = bus.read_byte_data(ADDR_OUTPUTS, OLATA + port)
            except OSError as exc:
                raise BoardError(f"output expander write failed: {exc}") from exc
            self._olat[port] = new
            self._olat_readback[port] = readback
            if readback != new:
                raise BoardError(
                    f"output expander readback 0x{readback:02x} != 0x{new:02x}")

    async def read_port_b(self) -> dict[str, int]:
        return await asyncio.to_thread(self._read_inputs_sync)

    def _read_inputs_sync(self) -> dict[str, int]:
        self.kick()
        with self._lock:
            bus = self._require_open()
            if self._tripped:
                raise WatchdogTrippedError(
                    "control loop keep-alive expired: heartbeat stopped, output rail off")
            try:
                iodir = bus.read_i2c_block_data(ADDR_OUTPUTS, IODIRA, 2)
                olat = bus.read_i2c_block_data(ADDR_OUTPUTS, OLATA, 2)
                gpio = bus.read_i2c_block_data(ADDR_INPUTS, GPIOA, 2)
            except OSError as exc:
                raise BoardError(f"vacuum I/O board read failed: {exc}") from exc
            if iodir != [0, 0]:
                # The expander reset (supply dip, ESD): its pins are inputs and
                # every relay/solenoid has dropped.  Re-establish the safe,
                # all-off configuration and report it.
                self._expander_resets += 1
                try:
                    self._configure_expanders()
                except BoardError:
                    pass
                raise ExpanderResetError(
                    "output expander reset detected: all outputs went off")
            self._olat_readback = list(olat)
            if olat != self._olat:
                raise BoardError(
                    f"output latch mismatch: board 0x{olat[0]:02x}{olat[1]:02x}, "
                    f"driver 0x{self._olat[0]:02x}{self._olat[1]:02x}")
            self._inputs_word = gpio[0] | (gpio[1] << 8)
            self._read_rails()
        return {pin: int(self._di_active(di)) for pin, di in self._di_of.items()}

    def _di_active(self, di: int) -> bool:
        return bool(self._inputs_word & (1 << (di - 1)))

    def _read_rails(self) -> None:
        self._estop_ok = not self._gpio.read(BCM_ESTOP_OK_N)
        self._rail_ok = not self._gpio.read(BCM_SAFE_OK_N)

    async def read_gauge_values(self) -> dict[str, float | None]:
        return await asyncio.to_thread(self._read_gauges_sync)

    def _read_gauges_sync(self) -> dict[str, float | None]:
        values: dict[str, float | None] = {pin: None for pin in self._di_of}
        with self._lock:
            self._require_open()
            for pin, gauge in self._gauges.items():
                volts = self._read_ai_sync(gauge.ain)
                self._analog[f"AI{gauge.ain}"] = volts
                values[pin] = gauge.pressure(volts)
        return values

    def read_analog(self, ain: int) -> float:
        """Terminal voltage of AIn (blocking)."""
        with self._lock:
            self._require_open()
            volts = self._read_ai_sync(ain)
            self._analog[f"AI{ain}"] = volts
            return volts

    def _read_ai_sync(self, ain: int) -> float:
        bus = self._bus
        addr = ADDR_ADC[(ain - 1) // 4]
        mux = 0b100 + (ain - 1) % 4                      # AINx vs GND
        config = (1 << 15) | (mux << 12) | (ADS_PGA_4V096 << 9) | (1 << 8) | \
            (ADS_DR_CODES[self._adc_rate] << 5) | 0b00  # assert ALERT after 1
        try:
            bus.write_i2c_block_data(addr, ADS_CONFIG, [config >> 8, config & 0xFF])
            period = 1.0 / self._adc_rate
            # Deadline on the monotonic clock, not a retry count: robust to
            # scheduler latency (and to time-compressed emulation).
            deadline = self._monotonic() + 3 * period + 0.010
            self._sleep(period + 0.0005)
            while True:
                # Capture time before reading OS: the emulator clock can
                # advance past the deadline between a busy read and the
                # timeout check. That old read must not report a timeout.
                observed_at = self._monotonic()
                hi, _lo = bus.read_i2c_block_data(addr, ADS_CONFIG, 2)
                if hi & 0x80:
                    break
                if observed_at > deadline:
                    raise BoardError(f"ADS1115 0x{addr:02x} conversion timed out")
                self._sleep(0.0005)
            msb, lsb = bus.read_i2c_block_data(addr, ADS_CONVERSION, 2)
        except OSError as exc:
            raise BoardError(f"ADS1115 0x{addr:02x} read failed: {exc}") from exc
        code = (msb << 8) | lsb
        if code & 0x8000:
            code -= 0x10000
        return code * ADS_FSR / 32768.0 / DIVIDER_RATIO

    def output_level(self, pin: str) -> bool:
        """Relay drive level as read back from U1 on the last write/poll."""
        try:
            relay = self._relay_of[pin]
        except KeyError as exc:
            raise ValueError(f"unknown vacuum output pin: {pin}") from exc
        return bool(self._olat_readback[0] & (1 << (relay - 1)))

    # ------------------------------------------------------------- board extras
    def read_safety(self) -> tuple[bool, bool]:
        """(E-stop rail live, output rail live) as of the last poll."""
        return self._estop_ok, self._rail_ok

    def fault_states(self) -> dict[str, bool]:
        """B channel -> healthy, for channels with a configured fault input."""
        return {pin: self._di_active(di) for pin, di in self._fault_di.items()}

    def gauge_interlocks(self) -> dict[str, bool]:
        return {pin: g.interlock for pin, g in self._gauges.items()}

    def board_status(self) -> BoardStatus:
        return BoardStatus(
            estop_ok=self._estop_ok,
            output_rail_ok=self._rail_ok,
            heartbeat=self._heartbeat,
            keepalive_tripped=self._tripped,
            expander_resets=self._expander_resets,
            inputs={f"DI{n}": self._di_active(n) for n in range(1, 17)},
            relays={f"K{n}": bool(self._olat_readback[0] & (1 << (n - 1))) for n in range(1, 9)},
            solenoids={f"V{n}": bool(self._olat_readback[1] & (1 << (n - 1))) for n in range(1, 9)},
            analog_volts=dict(self._analog),
        )


# ------------------------------------------------------------------ production HAL

class LgpioHAL:
    """:class:`GpioHAL` on lgpio (``python3-lgpio``) for Pi 4B and Pi 5.

    Finds the header GPIO chip by label: ``pinctrl-bcm2711`` on the Pi 4B,
    ``pinctrl-rp1`` on the Pi 5 (gpiochip0 on current kernels, gpiochip4 on
    early Pi 5 kernels).  PWM is lgpio's software-timed ``tx_pwm``.
    """

    LABELS = ("pinctrl-rp1", "pinctrl-bcm2711", "pinctrl-bcm2712", "pinctrl-bcm2835")

    def __init__(self, chip: int | None = None) -> None:
        try:
            import lgpio
        except ImportError as exc:  # pragma: no cover - hardware only
            raise RuntimeError("the vacuum I/O board needs python3-lgpio") from exc
        self._lg = lgpio
        self._handle = self._open(chip)

    def _open(self, chip: int | None) -> int:  # pragma: no cover - hardware only
        lg = self._lg
        candidates = [chip] if chip is not None else [0, 4, 1, 2, 3]
        for number in candidates:
            try:
                handle = lg.gpiochip_open(number)
            except Exception:
                continue
            try:
                _status, _lines, _name, label = lg.gpio_get_chip_info(handle)
            except Exception:
                label = ""
            if chip is not None or any(label.startswith(x) for x in self.LABELS):
                return handle
            lg.gpiochip_close(handle)
        raise RuntimeError("no Raspberry Pi header GPIO chip found")

    def setup_output(self, bcm: int, level: bool) -> None:  # pragma: no cover
        self._lg.gpio_claim_output(self._handle, bcm, int(level))

    def setup_input(self, bcm: int, pull: str | None = None) -> None:  # pragma: no cover
        flags = {None: self._lg.SET_PULL_NONE, "none": self._lg.SET_PULL_NONE,
                 "up": self._lg.SET_PULL_UP, "down": self._lg.SET_PULL_DOWN}[pull]
        self._lg.gpio_claim_input(self._handle, bcm, flags)

    def write(self, bcm: int, level: bool) -> None:  # pragma: no cover
        self._lg.gpio_write(self._handle, bcm, int(level))

    def read(self, bcm: int) -> bool:  # pragma: no cover
        return bool(self._lg.gpio_read(self._handle, bcm))

    def pwm(self, bcm: int, frequency: float, duty_percent: float) -> None:  # pragma: no cover
        self._lg.tx_pwm(self._handle, bcm, frequency, duty_percent)

    def close(self) -> None:  # pragma: no cover
        self._lg.gpiochip_close(self._handle)


# ------------------------------------------------------------------ factory

def build_board_device(sbc, outputs: Mapping[str, str], inputs: Mapping[str, str], *,
                       emulator=None) -> RPi5VacuumIODevice:
    """Create the driver from ``SbcDeviceConfig``; ``emulator`` is a
    :class:`glasgow_service.emulation.rig.VacuumRig` or None for hardware."""
    gauges = {
        pin: GaugeChannel(ain=_parse_index(g.ain, "AI", 8), law=g.law, slope=g.slope,
                          offset=g.offset, min_volts=g.min_volts, max_volts=g.max_volts,
                          interlock=g.interlock)
        for pin, g in sbc.gauges.items()
    }
    common = dict(
        gauges=gauges, faults=dict(sbc.faults),
        heartbeat_hz=sbc.heartbeat_hz, keepalive_seconds=sbc.keepalive_seconds,
    )
    if emulator is not None:
        realtime = emulator.runner is not None
        return RPi5VacuumIODevice(
            outputs, inputs, bus_factory=lambda: emulator.smbus(sbc.i2c_bus),
            gpio=emulator.gpio_hal(),
            # Real-time rigs: the keep-alive supervises the controller's
            # wall-clock poll loop, so it uses wall time even when the
            # emulated plant runs compressed. Sleeps must wait for actual
            # virtual progress so ADC conversions finish on a busy host.
            sleep=emulator.sleep,
            monotonic=time.monotonic if realtime else emulator.monotonic,
            # A deterministic rig only moves when the test advances it, so the
            # test calls check_keepalive() itself.
            keepalive_thread=emulator.runner is not None,
            transport="rpi5-vacuum-io-emulator", **common)

    def smbus_factory():  # pragma: no cover - hardware only
        try:
            from smbus2 import SMBus
        except ImportError as exc:
            raise RuntimeError("the vacuum I/O board needs smbus2 (pip install '.[sbc]')") from exc
        return SMBus(sbc.i2c_bus)

    return RPi5VacuumIODevice(outputs, inputs, bus_factory=smbus_factory,
                              gpio=LgpioHAL(), **common)
