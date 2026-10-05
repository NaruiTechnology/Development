"""Raspberry Pi peripheral-level emulator (Pi 4 Model B and Pi 5).

The default target is the **Raspberry Pi 4 Model B** from the controller
shopping list (``docs/rpi-vacuum-shopping-list.md``): 2 GB, official 15 W
USB-C PSU, USB 3 SSD boot, microSD rescue card.  QEMU's ``raspi4b`` machine
boots the same Raspberry Pi OS image (``tools/qemu/run-raspi4b.sh``), but it
has no model of the carrier board's I2C chips, relays or field wiring.  This
emulator provides exactly that layer, for both Pi models:

* the 40-pin header (physical pin <-> BCM GPIO / power / ground);
* GPIO bank 0 (BCM 0..27): input / output / alternate function, internal
  pulls, the documented power-on pull defaults (BCM 0-8 up, 9-27 down), and
  net resolution against external drivers and resistors on a carrier board;
* PWM on any output (lgpio ``tx_pwm`` semantics) and edge counting for
  software-toggled pins;
* ``/dev/i2c-1`` (I2C1 on BCM 2/3, fixed 1.8 kOhm pull-ups) with NACK as
  ``OSError(EREMOTEIO)`` exactly as the kernel reports it through smbus2;
* the UARTs on BCM 14/15 and 12/13, muxed by ``config.txt`` exactly as the
  firmware does for each model (see :data:`MODELS`);
* the EEPROM ``BOOT_ORDER`` / boot-media / PSU / USB-current rules.

It does not execute ARM code.  The production driver runs unmodified on top
of :class:`EmulatedGpioHAL` and :class:`EmulatedSMBus`.
"""
from __future__ import annotations

import errno
import threading
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Iterable, Protocol

from .clock import VirtualClock

# --------------------------------------------------------------------------
# Header


#: Physical header pin -> BCM number, or a power/ground name.
HEADER: dict[int, int | str] = {
    1: "3V3", 2: "5V", 3: 2, 4: "5V", 5: 3, 6: "GND", 7: 4, 8: 14, 9: "GND",
    10: 15, 11: 17, 12: 18, 13: 27, 14: "GND", 15: 22, 16: 23, 17: "3V3",
    18: 24, 19: 10, 20: "GND", 21: 9, 22: 25, 23: 11, 24: 8, 25: "GND",
    26: 7, 27: 0, 28: 1, 29: 5, 30: "GND", 31: 6, 32: 12, 33: 13, 34: "GND",
    35: 19, 36: 16, 37: 26, 38: 20, 39: "GND", 40: 21,
}
BCM_TO_HEADER: dict[int, int] = {
    bcm: pin for pin, bcm in HEADER.items() if isinstance(bcm, int)
}

#: RP1 bank-0 lines exposed on the header.
GPIO_COUNT = 28

#: Internal pull resistance (RP1 pads are ~50-65 kOhm; 50 k is the
#: conservative value for "who wins" against an external resistor).
INTERNAL_PULL_OHMS = 50_000.0
#: I2C1 lines have fixed 1.8 kOhm pull-ups to 3V3 on the Pi itself.
I2C_FIXED_PULLUP_OHMS = 1_800.0
VDD_IO = 3.3
V_IH = 1.65  # switching threshold used for net resolution


class Func(str, Enum):
    INPUT = "input"
    OUTPUT = "output"
    ALT = "alt"
    OFF = "off"  # SBC unpowered: pad is high-impedance


class Pull(str, Enum):
    UP = "up"
    DOWN = "down"
    NONE = "none"


def default_pull(bcm: int) -> Pull:
    """Power-on pull of a bank-0 line (BCM 0-8 up, 9-27 down)."""
    return Pull.UP if bcm <= 8 else Pull.DOWN


# --------------------------------------------------------------------------
# External net drivers (what a carrier board puts on a GPIO line)


@dataclass(frozen=True)
class Drive:
    """A push-pull / open-drain-asserted driver forcing a logic level."""
    level: bool


@dataclass(frozen=True)
class Resistor:
    """A resistor from the line to 3V3 (``level=True``) or GND."""
    level: bool
    ohms: float


NetSource = Callable[[], "Drive | Resistor | None | Iterable[Drive | Resistor]"]


@dataclass
class GpioLine:
    bcm: int
    func: Func = Func.INPUT
    alt: str | None = None
    pull: Pull = Pull.NONE
    out_level: bool = False
    pwm_freq: float = 0.0
    pwm_duty: float = 0.0  # percent
    edges: int = 0          # software edges since the consumer last looked
    owner: str | None = None


class PinConflict(RuntimeError):
    pass


class InterfaceDisabled(FileNotFoundError):
    pass


# --------------------------------------------------------------------------
# I2C


class I2CDevice(Protocol):
    def i2c_acks(self) -> bool: ...
    def i2c_write(self, data: bytes) -> None: ...
    def i2c_read(self, length: int) -> bytes: ...


class I2CBus:
    """Byte-level I2C bus with 7-bit addressing and general-call support."""

    def __init__(self, name: str) -> None:
        self.name = name
        self._devices: dict[int, I2CDevice] = {}
        self._nack_once: dict[int, int] = {}
        self.transactions = 0

    def attach(self, address: int, device: I2CDevice) -> None:
        if not 0x03 <= address <= 0x77:
            raise ValueError(f"invalid 7-bit I2C address 0x{address:02x}")
        if address in self._devices:
            raise ValueError(f"I2C address 0x{address:02x} already in use")
        self._devices[address] = device

    def inject_nack(self, address: int, count: int = 1) -> None:
        """Fault injection: the next ``count`` transfers to ``address`` NACK."""
        self._nack_once[address] = self._nack_once.get(address, 0) + count

    def _target(self, address: int) -> I2CDevice:
        pending = self._nack_once.get(address, 0)
        if pending:
            self._nack_once[address] = pending - 1
            raise OSError(errno.EREMOTEIO, "Remote I/O error")
        device = self._devices.get(address)
        if device is None or not device.i2c_acks():
            raise OSError(errno.EREMOTEIO, "Remote I/O error")
        return device

    def write(self, address: int, data: bytes) -> None:
        self.transactions += 1
        if address == 0x00:  # general call
            for device in self._devices.values():
                handler = getattr(device, "general_call", None)
                if handler is not None and device.i2c_acks():
                    handler(bytes(data))
            return
        self._target(address).i2c_write(bytes(data))

    def write_read(self, address: int, data: bytes, length: int) -> bytes:
        """Write then repeated-start read (one ``i2c_rdwr`` transaction)."""
        self.transactions += 1
        device = self._target(address)
        if data:
            device.i2c_write(bytes(data))
        return device.i2c_read(length)

    def scan(self) -> list[int]:
        found = []
        for address in range(0x03, 0x78):
            device = self._devices.get(address)
            if device is not None and device.i2c_acks():
                found.append(address)
        return found


# --------------------------------------------------------------------------
# UART


class UartPort:
    """One PL011 UART as seen from both ends.

    The Pi side (``/dev/ttyAMAx``) writes ``tx`` and reads ``rx``; the carrier
    side calls :meth:`deliver` to put bytes on the Pi's RX line and registers a
    ``on_tx`` sink for bytes the Pi transmits.
    """

    def __init__(self, name: str, device: str, tx_bcm: int, rx_bcm: int) -> None:
        self.name = name
        self.device = device
        self.tx_bcm = tx_bcm
        self.rx_bcm = rx_bcm
        self.baudrate = 115200
        self._rx: deque[int] = deque()
        self._rx_ready = threading.Condition()
        self.on_tx: Callable[[bytes], None] | None = None

    def deliver(self, data: bytes) -> None:
        with self._rx_ready:
            self._rx.extend(data)
            self._rx_ready.notify_all()

    def pi_write(self, data: bytes) -> int:
        if self.on_tx is not None:
            self.on_tx(bytes(data))
        return len(data)

    def pi_read(self, size: int, timeout: float | None) -> bytes:
        with self._rx_ready:
            if not self._rx and timeout:
                self._rx_ready.wait(timeout)
            out = bytearray()
            while self._rx and len(out) < size:
                out.append(self._rx.popleft())
            return bytes(out)

    @property
    def in_waiting(self) -> int:
        return len(self._rx)

    def reset_input_buffer(self) -> None:
        with self._rx_ready:
            self._rx.clear()


# --------------------------------------------------------------------------
# Boot model


class PowerState(str, Enum):
    OFF = "off"
    BOOTLOADER = "bootloader"
    KERNEL = "kernel"
    RUNNING = "running"
    HALTED = "halted"


BOOT_MODES = {0x1: "sd", 0x2: "network", 0x4: "usb", 0x6: "nvme",
              0x7: "http", 0xE: "stop", 0xF: "restart"}


@dataclass(frozen=True)
class ModelProfile:
    name: str
    soc: str
    ram_options: tuple[int, ...]
    default_boot_order: int
    boot_modes: frozenset[str]
    #: USB budget (A) with a full-rated PSU, and with an under-rated one.
    usb_budget_full: float
    usb_budget_reduced: float
    #: PSU current at which the full USB budget applies.
    psu_full_amps: float
    #: dtoverlay name -> (uart name, device node, (tx, rx) BCM)
    uart_overlays: dict
    qemu_machine: str | None


MODELS: dict[str, ModelProfile] = {
    "4B": ModelProfile(
        name="Raspberry Pi 4 Model B", soc="BCM2711",
        ram_options=(1, 2, 3, 4, 8),
        default_boot_order=0xF41,
        # NVMe needs PCIe, which the 4B does not expose: use a USB enclosure.
        boot_modes=frozenset({"sd", "usb", "network", "http"}),
        usb_budget_full=1.2, usb_budget_reduced=1.2, psu_full_amps=3.0,
        uart_overlays={
            # On the 4B GPIO12/13 carry UART5 (ALT4); "uart4" is GPIO8/9.
            # The node is ttyAMA1 when it is the only extra PL011 enabled;
            # check `ls -l /dev/ttyAMA*` on the target.
            "uart5": ("uart5", "/dev/ttyAMA1", (12, 13)),
            "uart4": ("uart4", "/dev/ttyAMA1", (8, 9)),
            "uart3": ("uart3", "/dev/ttyAMA1", (4, 5)),
            "uart2": ("uart2", "/dev/ttyAMA1", (0, 1)),
        },
        qemu_machine="raspi4b",
    ),
    "5": ModelProfile(
        name="Raspberry Pi 5", soc="BCM2712 + RP1",
        ram_options=(1, 2, 4, 8, 16),
        default_boot_order=0xF41,
        boot_modes=frozenset({"sd", "usb", "network", "http", "nvme"}),
        usb_budget_full=1.6, usb_budget_reduced=0.6, psu_full_amps=5.0,
        uart_overlays={
            "uart4-pi5": ("uart4", "/dev/ttyAMA4", (12, 13)),
            "uart3-pi5": ("uart3", "/dev/ttyAMA3", (8, 9)),
            "uart2-pi5": ("uart2", "/dev/ttyAMA2", (4, 5)),
        },
        qemu_machine=None,  # QEMU has no BCM2712/RP1 machine
    ),
}

#: config.txt for the vacuum I/O board, per model.
VACUUM_CONFIG_TXT = {
    "4B": ("dtparam=i2c_arm=on\n"
           "enable_uart=1\n"
           "dtoverlay=disable-bt\n"   # full PL011 (ttyAMA0) on GPIO14/15
           "dtoverlay=uart5\n"),      # RS-232 on GPIO12/13
    "5": ("dtparam=i2c_arm=on\n"
          "enable_uart=1\n"
          "dtoverlay=uart4-pi5\n"),
}


@dataclass
class PiSpec:
    """Hardware as purchased (see docs/rpi-vacuum-shopping-list.md)."""
    model: str = "4B"
    ram_gb: int = 2                       # matches QEMU raspi4b (2 GiB)
    psu_amps: float = 3.0                 # official 15 W USB-C PSU (5.1 V 3 A)
    boot_order: int | None = None         # None: the model's default
    usb_max_current_enable: bool = False  # Pi 5 only
    sd_card: bool = True                  # 64 GB A2 rescue card
    m2_hat: bool = False                  # Pi 5 only
    nvme: bool = False
    usb_ssd: bool = True                  # Samsung T7 / USB-SATA SSD
    usb_ssd_amps: float = 0.9
    config_txt: str | None = None         # None: VACUUM_CONFIG_TXT[model]
    #: Emulated boot durations (seconds of emulated time).
    bootloader_seconds: float = 1.5
    kernel_seconds: float = 8.0

    def __post_init__(self) -> None:
        if self.model not in MODELS:
            raise ValueError(f"unknown Raspberry Pi model {self.model!r}; use one of {list(MODELS)}")
        profile = MODELS[self.model]
        if self.ram_gb not in profile.ram_options:
            raise ValueError(f"{profile.name} is not sold with {self.ram_gb} GB")
        if self.boot_order is None:
            self.boot_order = profile.default_boot_order
        if self.config_txt is None:
            self.config_txt = VACUUM_CONFIG_TXT[self.model]
        if self.model == "4B" and (self.m2_hat or self.nvme):
            raise ValueError("the M.2 HAT+ / NVMe boot is Raspberry Pi 5 only")

    @property
    def profile(self) -> ModelProfile:
        return MODELS[self.model]


@dataclass
class ConfigTxt:
    i2c_arm: bool = False
    enable_uart: bool = False
    overlays: list[str] = field(default_factory=list)

    @classmethod
    def parse(cls, text: str) -> "ConfigTxt":
        cfg = cls()
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line or line.startswith("["):
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip()
            if key == "dtparam":
                for item in value.split(","):
                    name, _, val = item.partition("=")
                    if name.strip() in {"i2c_arm", "i2c"}:
                        cfg.i2c_arm = val.strip().lower() in {"on", "1", "true", "yes", ""}
            elif key == "enable_uart":
                cfg.enable_uart = value == "1"
            elif key == "dtoverlay":
                cfg.overlays.append(value.split(",", 1)[0])
        return cfg


# --------------------------------------------------------------------------
# The SBC


class RaspberryPi:
    """Emulated Raspberry Pi peripheral surface (model chosen by ``spec``)."""

    def __init__(self, clock: VirtualClock, spec: PiSpec | None = None) -> None:
        self.clock = clock
        self.spec = spec or PiSpec()
        self.profile = self.spec.profile
        self.lines = [GpioLine(bcm) for bcm in range(GPIO_COUNT)]
        self._net_sources: dict[int, list[NetSource]] = {}
        self.i2c1 = I2CBus("i2c-1")
        #: The UART on GPIO14/15 (``uart0``) and the one on GPIO12/13
        #: (``uart_gpio12``: UART5 on the 4B, UART4 on the 5).  Device nodes
        #: are filled in when config.txt is applied.
        self.uart0 = UartPort("uart0", "", 14, 15)
        self.uart_gpio12 = UartPort("uart-gpio12", "", 12, 13)
        self.uart0_is_mini_uart = False
        self.state = PowerState.OFF
        self.boot_device: str | None = None
        self.boot_log: list[str] = []
        self.config = ConfigTxt()
        self._state_until = 0.0
        self._apply_power_off()
        clock.subscribe(self)

    # ------------------------------------------------------------- power
    @property
    def powered(self) -> bool:
        return self.state not in (PowerState.OFF,)

    @property
    def rail_3v3(self) -> bool:
        """3V3 on header pins 1/17 (present whenever the SoC is powered)."""
        return self.state in (PowerState.BOOTLOADER, PowerState.KERNEL,
                              PowerState.RUNNING, PowerState.HALTED)

    @property
    def userspace_ready(self) -> bool:
        return self.state is PowerState.RUNNING

    def power_on(self) -> None:
        if self.powered:
            return
        self.boot_log.clear()
        self._log(f"{self.profile.name} ({self.profile.soc}) {self.spec.ram_gb} GB: "
                  f"power on, PSU {self.spec.psu_amps:.1f} A")
        for line in self.lines:
            line.func = Func.INPUT
            line.alt = None
            line.pull = default_pull(line.bcm)
            line.out_level = False
            line.pwm_freq = line.pwm_duty = 0.0
            line.owner = None
        self.state = PowerState.BOOTLOADER
        self._state_until = self.clock.now() + self.spec.bootloader_seconds

    def power_off(self) -> None:
        self._log("power removed")
        self.state = PowerState.OFF
        self._apply_power_off()

    def halt(self) -> None:
        """``sudo halt``: userspace stops, pads return to reset defaults."""
        self._log("system halted")
        self._reset_pads()
        self.state = PowerState.HALTED

    def reboot(self) -> None:
        self.power_off()
        self.power_on()

    def boot_now(self) -> None:
        """Skip the boot delay (tests): run bootloader and kernel stages."""
        if not self.powered:
            self.power_on()
        while self.state is not PowerState.RUNNING:
            if self.state in (PowerState.OFF, PowerState.HALTED):
                raise RuntimeError("; ".join(self.boot_log[-2:]))
            self._advance_boot(force=True)

    def _apply_power_off(self) -> None:
        for line in self.lines:
            line.func = Func.OFF
            line.alt = None
            line.pull = Pull.NONE
            line.out_level = False
            line.pwm_freq = line.pwm_duty = 0.0
            line.owner = None

    def _reset_pads(self) -> None:
        for line in self.lines:
            line.func = Func.INPUT
            line.alt = None
            line.pull = default_pull(line.bcm)
            line.out_level = False
            line.pwm_freq = line.pwm_duty = 0.0
            line.owner = None

    def _log(self, message: str) -> None:
        self.boot_log.append(f"[{self.clock.now():9.3f}] {message}")

    @property
    def usb_budget_amps(self) -> float:
        p = self.profile
        if self.spec.psu_amps >= p.psu_full_amps or self.spec.usb_max_current_enable:
            return p.usb_budget_full
        return p.usb_budget_reduced

    def _select_boot_device(self) -> str | None:
        usb_budget = self.usb_budget_amps
        order = self.spec.boot_order
        nibbles = []
        while order:
            nibbles.append(order & 0xF)
            order >>= 4
        for nibble in nibbles:
            mode = BOOT_MODES.get(nibble)
            if mode is not None and mode not in self.profile.boot_modes | {"stop", "restart"}:
                self._log(f"EEPROM: boot mode {nibble:x} ({mode}) not supported on "
                          f"{self.profile.name}; skipped")
                continue
            if mode == "nvme" and self.spec.m2_hat and self.spec.nvme:
                return "nvme"
            if mode == "sd" and self.spec.sd_card:
                return "sd"
            if mode == "usb" and self.spec.usb_ssd:
                if self.spec.usb_ssd_amps > usb_budget:
                    self._log(f"USB boot: device needs {self.spec.usb_ssd_amps} A "
                              f"but the USB budget is {usb_budget} A (use the 5 A PSU "
                              "or usb_max_current_enable=1)")
                    continue
                return "usb"
            if mode == "stop":
                return None
            if mode == "restart":
                break
        return None

    def _advance_boot(self, force: bool = False) -> None:
        now = self.clock.now()
        if not force and now < self._state_until:
            return
        if self.state is PowerState.BOOTLOADER:
            device = self._select_boot_device()
            if device is None:
                self._log(f"EEPROM: no bootable device for BOOT_ORDER=0x{self.spec.boot_order:x}")
                self.state = PowerState.HALTED
                return
            self.boot_device = device
            self._log(f"EEPROM: booting from {device} (BOOT_ORDER=0x{self.spec.boot_order:x})")
            self.state = PowerState.KERNEL
            self._state_until = now + self.spec.kernel_seconds
        elif self.state is PowerState.KERNEL:
            self.config = ConfigTxt.parse(self.spec.config_txt)
            self._apply_config()
            self._log("kernel up; userspace running")
            self.state = PowerState.RUNNING

    def _apply_config(self) -> None:
        cfg = self.config
        if cfg.i2c_arm:
            for bcm in (2, 3):
                self.lines[bcm].func, self.lines[bcm].alt = Func.ALT, "i2c1"
            self._log("i2c_arm=on: /dev/i2c-1 on GPIO2/3")
        self.uart0.device = ""
        self.uart_gpio12.device = ""
        if cfg.enable_uart:
            if self.spec.model == "4B" and not ({"disable-bt", "miniuart-bt"} & set(cfg.overlays)):
                # Firmware gives the PL011 to Bluetooth; GPIO14/15 get the
                # mini UART, whose baud rate follows the VPU clock.
                self.uart0_is_mini_uart = True
                self.uart0.device = "/dev/ttyS0"
                self._log("enable_uart=1: mini UART /dev/ttyS0 on GPIO14/15 (PL011 is "
                          "on Bluetooth; add dtoverlay=disable-bt for RS-485)")
            else:
                self.uart0_is_mini_uart = False
                self.uart0.device = "/dev/ttyAMA0"
                self._log("enable_uart=1: PL011 /dev/ttyAMA0 on GPIO14/15")
            for bcm in (14, 15):
                self.lines[bcm].func, self.lines[bcm].alt = Func.ALT, "uart0"
        for overlay in cfg.overlays:
            if overlay in ("disable-bt", "miniuart-bt"):
                continue
            entry = self.profile.uart_overlays.get(overlay)
            if entry is None:
                if overlay.startswith("uart"):
                    self._log(f"dtoverlay={overlay}: not valid on {self.profile.name}; ignored")
                continue
            uart, device, (tx, rx) = entry
            for bcm in (tx, rx):
                self.lines[bcm].func, self.lines[bcm].alt = Func.ALT, uart
            if (tx, rx) == (12, 13):
                self.uart_gpio12.device = device
                self.uart_gpio12.name = uart
            self._log(f"dtoverlay={overlay}: {device} ({uart}) on GPIO{tx}/{rx}")

    def tick(self, now: float, dt: float) -> None:
        if self.state in (PowerState.BOOTLOADER, PowerState.KERNEL):
            self._advance_boot()

    # ------------------------------------------------------------- nets
    def connect(self, bcm: int, source: NetSource) -> None:
        """Attach a carrier-board net source to a GPIO line."""
        self._net_sources.setdefault(bcm, []).append(source)

    def _external(self, bcm: int) -> tuple[list[Drive], list[Resistor]]:
        drives: list[Drive] = []
        resistors: list[Resistor] = []
        for source in self._net_sources.get(bcm, []):
            result = source()
            items = result if isinstance(result, (list, tuple)) else [result]
            for item in items:
                if isinstance(item, Drive):
                    drives.append(item)
                elif isinstance(item, Resistor):
                    resistors.append(item)
        return drives, resistors

    def pin_level(self, bcm: int) -> bool:
        """Electrical level of a line (what a voltmeter / the board sees)."""
        line = self.lines[bcm]
        drives, resistors = self._external(bcm)
        if line.func is Func.OUTPUT:
            if line.pwm_freq > 0:
                return line.pwm_duty >= 50.0
            return line.out_level
        if drives:
            # Wired-AND (open drain) semantics: any low driver wins.
            return all(d.level for d in drives)
        if line.func is Func.ALT and line.alt == "i2c1":
            resistors = resistors + [Resistor(True, I2C_FIXED_PULLUP_OHMS)]
        if line.func is not Func.OFF:
            if line.pull is Pull.UP:
                resistors = resistors + [Resistor(True, INTERNAL_PULL_OHMS)]
            elif line.pull is Pull.DOWN:
                resistors = resistors + [Resistor(False, INTERNAL_PULL_OHMS)]
        if not resistors:
            return False  # floating: report low (undefined on hardware)
        g_up = sum(1 / r.ohms for r in resistors if r.level)
        g_dn = sum(1 / r.ohms for r in resistors if not r.level)
        voltage = VDD_IO * g_up / (g_up + g_dn) if (g_up + g_dn) else 0.0
        return voltage >= V_IH

    def is_driven_output(self, bcm: int) -> bool:
        return self.lines[bcm].func is Func.OUTPUT

    def pwm_of(self, bcm: int) -> tuple[float, float]:
        line = self.lines[bcm]
        if line.func is not Func.OUTPUT:
            return 0.0, 0.0
        return line.pwm_freq, line.pwm_duty

    def take_edges(self, bcm: int) -> int:
        line = self.lines[bcm]
        edges, line.edges = line.edges, 0
        return edges

    # ------------------------------------------------------------- userspace API
    def _require_userspace(self) -> None:
        if not self.userspace_ready:
            raise OSError(errno.ENODEV, "Raspberry Pi 5 is not running")

    def _claim(self, bcm: int, owner: str) -> GpioLine:
        self._require_userspace()
        if not 0 <= bcm < GPIO_COUNT:
            raise ValueError(f"BCM GPIO {bcm} does not exist on the header")
        line = self.lines[bcm]
        if line.func is Func.ALT:
            raise PinConflict(
                f"GPIO{bcm} is in use by {line.alt}; disable that interface first")
        if line.owner not in (None, owner):
            raise PinConflict(f"GPIO{bcm} is busy (claimed by {line.owner})")
        line.owner = owner
        return line

    def gpio_claim_output(self, bcm: int, level: bool, owner: str = "user") -> None:
        line = self._claim(bcm, owner)
        line.func = Func.OUTPUT
        line.pwm_freq = line.pwm_duty = 0.0
        if line.out_level != bool(level):
            line.edges += 1
        line.out_level = bool(level)

    def gpio_claim_input(self, bcm: int, pull: Pull = Pull.NONE, owner: str = "user") -> None:
        line = self._claim(bcm, owner)
        line.func = Func.INPUT
        line.pull = pull
        line.pwm_freq = line.pwm_duty = 0.0

    def gpio_write(self, bcm: int, level: bool) -> None:
        self._require_userspace()
        line = self.lines[bcm]
        if line.func is not Func.OUTPUT:
            raise PinConflict(f"GPIO{bcm} is not claimed as an output")
        line.pwm_freq = line.pwm_duty = 0.0
        if line.out_level != bool(level):
            line.edges += 1
        line.out_level = bool(level)

    def gpio_read(self, bcm: int) -> bool:
        self._require_userspace()
        return self.pin_level(bcm)

    def tx_pwm(self, bcm: int, frequency: float, duty_percent: float) -> None:
        """lgpio ``tx_pwm``: frequency 0 stops PWM and leaves the line low."""
        self._require_userspace()
        line = self.lines[bcm]
        if line.func is not Func.OUTPUT:
            raise PinConflict(f"GPIO{bcm} is not claimed as an output")
        if frequency <= 0 or duty_percent <= 0:
            line.pwm_freq = line.pwm_duty = 0.0
            line.out_level = False
            return
        if not 0.1 <= frequency <= 10_000:
            raise ValueError("lgpio software PWM supports 0.1 Hz .. 10 kHz")
        line.pwm_freq = float(frequency)
        line.pwm_duty = min(100.0, float(duty_percent))

    def gpio_free(self, bcm: int) -> None:
        line = self.lines[bcm]
        if line.func is Func.OUTPUT:
            line.func = Func.INPUT
            line.pull = default_pull(bcm)
            line.pwm_freq = line.pwm_duty = 0.0
        line.owner = None

    def i2c_bus(self, number: int) -> I2CBus:
        self._require_userspace()
        if number != 1:
            raise InterfaceDisabled(f"/dev/i2c-{number}: no such bus on the header")
        if not self.config.i2c_arm:
            raise InterfaceDisabled("/dev/i2c-1 missing: add dtparam=i2c_arm=on")
        if self.lines[2].alt != "i2c1" or self.lines[3].alt != "i2c1":
            raise InterfaceDisabled("/dev/i2c-1 pins were re-muxed away from I2C1")
        return self.i2c1

    def serial(self, device: str) -> UartPort:
        self._require_userspace()
        for port in (self.uart0, self.uart_gpio12):
            if port.device and port.device == device:
                return port
        raise InterfaceDisabled(f"{device} is not enabled in config.txt")

    # ------------------------------------------------------------- tools
    def pinout(self) -> str:
        rows = []
        for odd in range(1, 41, 2):
            left, right = HEADER[odd], HEADER[odd + 1]
            fmt = lambda v: f"GPIO{v}" if isinstance(v, int) else v  # noqa: E731
            rows.append(f"{fmt(left):>7} ({odd:2d}) ({odd + 1:2d}) {fmt(right)}")
        return "\n".join(rows)

    def pinctrl_get(self, bcm: int) -> str:
        line = self.lines[bcm]
        if line.func is Func.ALT:
            mode = line.alt
        elif line.func is Func.OUTPUT and line.pwm_freq:
            mode = f"op pwm {line.pwm_freq:g}Hz {line.pwm_duty:g}%"
        elif line.func is Func.OUTPUT:
            mode = "op " + ("dh" if line.out_level else "dl")
        else:
            mode = f"ip p{line.pull.value[0]}"
        return f"{bcm:2d}: {mode} | {'hi' if self.pin_level(bcm) else 'lo'}"

    def i2cdetect(self, bus: int = 1) -> str:
        found = set(self.i2c_bus(bus).scan())
        lines = ["     " + " ".join(f"{c:2x}" for c in range(16))]
        for row in range(0, 0x80, 0x10):
            cells = []
            for col in range(16):
                addr = row + col
                if addr < 0x03 or addr > 0x77:
                    cells.append("  ")
                else:
                    cells.append(f"{addr:02x}" if addr in found else "--")
            lines.append(f"{row:02x}: " + " ".join(cells))
        return "\n".join(lines)


# --------------------------------------------------------------------------
# Linux userspace facades used by the production driver


class EmulatedSMBus:
    """Subset of ``smbus2.SMBus`` backed by the emulated ``/dev/i2c-1``."""

    def __init__(self, pi: RaspberryPi, bus: int = 1) -> None:
        self._pi = pi
        self._number = bus
        with pi.clock.lock:
            self._bus = pi.i2c_bus(bus)

    def _bus_live(self) -> I2CBus:
        if not self._pi.userspace_ready:
            raise OSError(errno.ENODEV, "No such device")
        return self._bus

    def write_byte_data(self, addr: int, reg: int, value: int) -> None:
        with self._pi.clock.lock:
            self._bus_live().write(addr, bytes([reg & 0xFF, value & 0xFF]))

    def read_byte_data(self, addr: int, reg: int) -> int:
        with self._pi.clock.lock:
            return self._bus_live().write_read(addr, bytes([reg & 0xFF]), 1)[0]

    def write_i2c_block_data(self, addr: int, reg: int, data: list[int]) -> None:
        with self._pi.clock.lock:
            self._bus_live().write(addr, bytes([reg & 0xFF, *[b & 0xFF for b in data]]))

    def read_i2c_block_data(self, addr: int, reg: int, length: int) -> list[int]:
        with self._pi.clock.lock:
            return list(self._bus_live().write_read(addr, bytes([reg & 0xFF]), length))

    def write_byte(self, addr: int, value: int) -> None:
        with self._pi.clock.lock:
            self._bus_live().write(addr, bytes([value & 0xFF]))

    def close(self) -> None:
        pass


class EmulatedGpioHAL:
    """``GpioHAL`` (see ``glasgow_service.vacuum_io_board``) on the emulator."""

    OWNER = "sbc-vacuum"

    def __init__(self, pi: RaspberryPi) -> None:
        self._pi = pi

    def setup_output(self, bcm: int, level: bool) -> None:
        with self._pi.clock.lock:
            self._pi.gpio_claim_output(bcm, level, owner=self.OWNER)

    def setup_input(self, bcm: int, pull: str | None = None) -> None:
        mapping = {None: Pull.NONE, "none": Pull.NONE, "up": Pull.UP, "down": Pull.DOWN}
        with self._pi.clock.lock:
            self._pi.gpio_claim_input(bcm, mapping[pull], owner=self.OWNER)

    def write(self, bcm: int, level: bool) -> None:
        with self._pi.clock.lock:
            self._pi.gpio_write(bcm, level)

    def read(self, bcm: int) -> bool:
        with self._pi.clock.lock:
            return self._pi.gpio_read(bcm)

    def pwm(self, bcm: int, frequency: float, duty_percent: float) -> None:
        with self._pi.clock.lock:
            self._pi.tx_pwm(bcm, frequency, duty_percent)

    def close(self) -> None:
        with self._pi.clock.lock:
            for line in self._pi.lines:
                if line.owner == self.OWNER:
                    self._pi.gpio_free(line.bcm)


class EmulatedSerial:
    """Subset of ``serial.Serial`` (pyserial) on an emulated UART."""

    def __init__(self, pi: RaspberryPi, device: str, baudrate: int = 9600,
                 timeout: float | None = 0.5,
                 wait: Callable[[float], None] | None = None) -> None:
        self._pi = pi
        with pi.clock.lock:
            self._port = pi.serial(device)
        self._port.baudrate = baudrate
        self.timeout = timeout
        self.port = device
        # ``wait`` advances emulated time (deterministic rigs) or sleeps
        # (real-time rigs) while waiting for bytes.
        self._wait = wait or pi.clock.sleep

    def write(self, data: bytes) -> int:
        with self._pi.clock.lock:
            return self._port.pi_write(data)

    def _read_one(self) -> bytes:
        waited = 0.0
        step = 0.0005
        while True:
            chunk = self._port.pi_read(1, None)
            if chunk:
                return chunk
            if self.timeout is not None and waited >= self.timeout:
                return b""
            self._wait(step)
            waited += step

    def read(self, size: int = 1) -> bytes:
        out = bytearray()
        while len(out) < size:
            chunk = self._read_one()
            if not chunk:
                break
            out += chunk
        return bytes(out)

    def read_until(self, expected: bytes = b"\n", size: int | None = None) -> bytes:
        out = bytearray()
        while True:
            chunk = self._read_one()
            if not chunk:
                return bytes(out)
            out += chunk
            if out.endswith(expected) or (size is not None and len(out) >= size):
                return bytes(out)

    def reset_input_buffer(self) -> None:
        self._port.reset_input_buffer()

    @property
    def in_waiting(self) -> int:
        return self._port.in_waiting

    def close(self) -> None:
        pass
