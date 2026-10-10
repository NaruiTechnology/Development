"""Configuration-driven Raspberry Pi SBC vacuum control."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from .models import VacuumPumpState, VacuumSystemStatus
from .execution_authority import (
    ExecutionAuthority,
    ExecutionPermit,
    RemoteExecutionAuthority,
)
from .vacuum_device import (
    SimulatedVacuumDevice,
    SimulatedVacuumDeviceControl,
    RaspberryPiGPIODevice,
    VacuumDevice,
)


log = logging.getLogger("glasgow_service.vacuum")

#: Prefix on every vacuum log line, so the journal shows at a glance whether
#: real equipment is being driven:  journalctl -u sbc-vacuum | grep VACUUM-HW
LOG_TAGS = {
    "hardware": "[VACUUM-HW]",
    "emulator": "[VACUUM-EMU]",
    "simulator": "[VACUUM-SIM]",
}

VACUUM_CONFIG_ENV = "SBC_VACUUM_CONFIG"
DEFAULT_VACUUM_CONFIG = Path(
    Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json"
    / "vacuumSystem.json"
)
GPIO_PIN_RE = re.compile(r"^[AB]([0-7])$")
MECHANICAL_PUMP = "MechanicalVacuumPump"
#: ``groupName`` values: one identifier per cascade stage.
GROUP_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")

#: Raspberry Pi GPIO line names follow the official ``GPIOn`` convention
#: (``pinout``, ``gpioinfo``, ``pinctrl``); ``n`` is the Broadcom (BCM) line.
RPI_GPIO_NAME_RE = re.compile(r"^GPIO([0-9]|[1-9][0-9])$")
#: The 26 user GPIO lines on the 40-pin header (Pi 2B/3B/4B/5/400/Zero) and
#: the physical header pin each one is wired to.  GPIO0/GPIO1 (pins 27/28,
#: ID_SD/ID_SC) are reserved for the HAT ID EEPROM and are not assignable.
RPI_HEADER_GPIO: dict[int, int] = {
    2: 3, 3: 5, 4: 7, 5: 29, 6: 31, 7: 26, 8: 24, 9: 21, 10: 19,
    11: 23, 12: 32, 13: 33, 14: 8, 15: 10, 16: 36, 17: 11, 18: 12,
    19: 35, 20: 38, 21: 40, 22: 15, 23: 16, 24: 18, 25: 22, 26: 37, 27: 13,
}


def rpi_gpio_name(line: int) -> str:
    """``17`` -> ``"GPIO17 (pin 11)"``."""
    pin = RPI_HEADER_GPIO.get(line)
    return f"GPIO{line}" + (f" (pin {pin})" if pin is not None else "")


def _parse_rpi_gpio(logical: str, value: Any) -> int:
    """Accept ``"GPIO17"`` (preferred) or a bare BCM number; return the line."""
    if isinstance(value, bool):
        raise ValueError(f"SBC.GPIO.{logical} must be a Raspberry Pi GPIO name such as GPIO17")
    if isinstance(value, int):
        line = value
    else:
        match = RPI_GPIO_NAME_RE.fullmatch(str(value).strip().upper())
        if match is None:
            raise ValueError(
                f"SBC.GPIO.{logical} must be a Raspberry Pi GPIO name such as GPIO17, "
                f"got {value!r}")
        line = int(match.group(1))
    if line not in RPI_HEADER_GPIO:
        reserved = " (reserved for the HAT ID EEPROM)" if line in (0, 1) else ""
        raise ValueError(
            f"SBC.GPIO.{logical}=GPIO{line}{reserved} is not one of the 26 header "
            "GPIO lines GPIO2..GPIO27")
    return line


def _parse_threshold(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().lower().replace(" ", "")
    # The supplied config uses values such as ``1.0*e-1``.  Normalize this
    # project-specific spelling to standard scientific notation.
    text = text.replace("*e", "e")
    return float(text)


BOARD_RPI_VACUUM_IO = "RPi5VacuumIO-A"
RELAY_RE = re.compile(r"^K([1-8])$")
DI_RE = re.compile(r"^DI([1-9]|1[0-6])$")
AI_RE = re.compile(r"^AI([1-8])$")
VALVE_RE = re.compile(r"^V([1-8])$")
EMULATOR_SPEED_ENV = "SBC_VACUUM_EMULATOR_SPEED"
EMULATOR_MODEL_ENV = "SBC_VACUUM_EMULATOR_MODEL"


class GaugeConfig(BaseModel):
    """AI input -> pressure conversion for one vacuum-equipment channel."""
    ain: str = Field(alias="AIN")
    law: Literal["log", "linear"] = Field("log", alias="Law")
    slope: float = Field(1.0, alias="Slope")
    offset: float = Field(0.0, alias="Offset")
    min_volts: float = Field(0.5, alias="MinVolts")
    max_volts: float = Field(10.0, alias="MaxVolts")
    # The pump counts as ready only once this gauge reads exactly the pump's
    # configured ``value`` or lower, in addition
    # to its ready input.  Default on; set ``"Interlock": false`` to rely on
    # the ready input alone (for example while commissioning a gauge).
    interlock: bool = Field(True, alias="Interlock")

    @field_validator("ain")
    @classmethod
    def validate_ain(cls, value: str) -> str:
        if not AI_RE.fullmatch(value):
            raise ValueError("gauge AIN must be AI1..AI8")
        return value


class SbcDeviceConfig(BaseModel):
    """Either a direct Raspberry Pi ``GPIO`` map, or the RPi5VacuumIO ``Board`` map.

    ``GPIO`` maps a logical channel to a Raspberry Pi GPIO line name, for
    example ``{"A0": "GPIO17"}``.  After validation the value is the BCM line
    number (``17``), which is what gpiozero/lgpio take.
    """
    id: str = Field("raspberry-pi", alias="Id")
    voltage: float = 3.3
    gpio: dict[str, int] | None = Field(None, alias="GPIO")

    @field_validator("gpio", mode="before")
    @classmethod
    def parse_gpio(cls, value: Any) -> Any:
        if value is None:
            return None
        if not isinstance(value, dict):
            raise ValueError("SBC.GPIO must map logical channels to GPIO names")
        lines: dict[str, int] = {}
        for logical, raw in value.items():
            if not GPIO_PIN_RE.fullmatch(str(logical)):
                raise ValueError(f"SBC.GPIO key {logical!r} must be a logical channel A0..A7/B0..B7")
            lines[logical] = _parse_rpi_gpio(logical, raw)
        used: dict[int, str] = {}
        for logical, line in lines.items():
            if line in used:
                raise ValueError(
                    f"SBC.GPIO.{logical} and SBC.GPIO.{used[line]} both use GPIO{line}")
            used[line] = logical
        return lines

    active_high: bool = Field(True, alias="ActiveHigh")
    input_pull_up: bool | None = Field(None, alias="InputPullUp")
    board: Literal["RPi5VacuumIO-A"] | None = Field(None, alias="Board")
    #: Raspberry Pi model the controller runs on ("4B" or "5"); informational
    #: for hardware, and the model the emulator builds.
    pi_model: Literal["4B", "5"] = Field("4B", alias="PiModel")
    channels: dict[str, str] = Field(default_factory=dict, alias="Channels")
    gauges: dict[str, GaugeConfig] = Field(default_factory=dict, alias="Gauges")
    faults: dict[str, str] = Field(default_factory=dict, alias="Faults")
    #: Per-pump isolation valve, keyed by the pump's B (ready) channel:
    #: ``{"B1": "V2"}``.  The controller opens a pump's valve only while that
    #: pump is ready and closes it on any loss (reading above its value, ready
    #: input lost, fault, interlock).  Board mode only.
    valves: dict[str, str] = Field(default_factory=dict, alias="Valves")
    i2c_bus: int = Field(1, alias="I2CBus")
    heartbeat_hz: float = Field(1000.0, alias="HeartbeatHz", ge=200, le=5000)
    keepalive_seconds: float = Field(3.0, alias="KeepAliveSeconds", gt=0, le=30)
    #: Serial device nodes for the board's RS-485 (J4) and RS-232 (J5) ports.
    #: Pi 4B: /dev/ttyAMA0 + uart5 node; Pi 5: /dev/ttyAMA0 + /dev/ttyAMA4.
    serial: dict[str, str] = Field(default_factory=dict, alias="Serial")

    @model_validator(mode="after")
    def validate_mode(self):
        if (self.gpio is None) == (self.board is None):
            raise ValueError("SBC needs exactly one of GPIO (direct BCM pins) or Board")
        if self.board is not None:
            for logical, target in self.channels.items():
                if logical.startswith("A") and not RELAY_RE.fullmatch(target):
                    raise ValueError(f"SBC.Channels.{logical} must name a relay K1..K8")
                if logical.startswith("B") and not DI_RE.fullmatch(target):
                    raise ValueError(f"SBC.Channels.{logical} must name an input DI1..DI16")
            for logical, target in self.faults.items():
                if not DI_RE.fullmatch(target):
                    raise ValueError(f"SBC.Faults.{logical} must name an input DI1..DI16")
            used = [t for k, t in self.channels.items() if k.startswith("B")] + list(self.faults.values())
            if len(set(used)) != len(used):
                raise ValueError("SBC ready and fault inputs must use distinct DI channels")
            relays = [t for k, t in self.channels.items() if k.startswith("A")]
            if len(set(relays)) != len(relays):
                raise ValueError("SBC output channels must use distinct relays")
            for logical, target in self.valves.items():
                if not VALVE_RE.fullmatch(target):
                    raise ValueError(f"SBC.Valves.{logical} must name a solenoid V1..V8")
            if len(set(self.valves.values())) != len(self.valves):
                raise ValueError("SBC valves must use distinct solenoid outputs")
            ains = [g.ain for g in self.gauges.values()]
            if len(set(ains)) != len(ains):
                raise ValueError("SBC gauges must use distinct AI inputs")
        return self

    @property
    def channel_map(self) -> dict[str, object]:
        return self.channels if self.board is not None else (self.gpio or {})


class VacuumPumpConfig(BaseModel):
    name: str
    #: Cascade stage this equipment belongs to.  Equipment sharing a
    #: ``groupName`` is energized together and must all be ready before the
    #: next group starts.  Groups run in the order they first appear.
    group_name: str = Field(alias="groupName")
    power: str = "off"
    threshold: float = Field(alias="value")
    write: str
    read: str

    @field_validator("group_name")
    @classmethod
    def validate_group_name(cls, value: str) -> str:
        if not GROUP_NAME_RE.fullmatch(value):
            raise ValueError(
                "groupName must start with a letter and use only letters, digits, '_' or '-'")
        return value

    @field_validator("threshold", mode="before")
    @classmethod
    def parse_threshold(cls, value: Any) -> float:
        return _parse_threshold(value)

    @field_validator("write")
    @classmethod
    def validate_write_pin(cls, value: str) -> str:
        if not GPIO_PIN_RE.fullmatch(value) or not value.startswith("A"):
            raise ValueError("vacuum output pins must use Port A (A0..A7)")
        return value

    @field_validator("read")
    @classmethod
    def validate_read_pin(cls, value: str) -> str:
        if not GPIO_PIN_RE.fullmatch(value) or not value.startswith("B"):
            raise ValueError("vacuum input pins must use Port B (B0..B7)")
        return value


class HighVoltageTransformerConfig(BaseModel):
    power: Literal["off"] = "off"
    write: str

    @field_validator("write")
    @classmethod
    def validate_write_pin(cls, value: str) -> str:
        if not GPIO_PIN_RE.fullmatch(value) or not value.startswith("A"):
            raise ValueError("high-voltage output pin must use Port A (A0..A7)")
        return value


class VacuumConfig(BaseModel):
    enabled: bool = Field(True, alias="Enable")
    pumps: list[VacuumPumpConfig] = Field(alias="VacuumPumps")
    error_range: float = Field(alias="errorRange", ge=0, le=1)
    log_name: str = Field("VacuumDashboard", alias="LogName")
    verbose: bool = Field(False, alias="Verbose")
    simulate: bool = Field(False, alias="Simulate")
    # Low-level simulator tools select hardware/emulation with this field.
    # The normal service uses Enable for activation and scanner IsProduction
    # to select real hardware or emulation.
    is_production: bool = Field(True, alias="IsProduction")
    sbc: SbcDeviceConfig = Field(alias="SBC")
    high_voltage_transformer: HighVoltageTransformerConfig = Field(
        alias="HighVoltageTransformer"
    )

    @model_validator(mode="after")
    def select_execution_mode(self):
        if self.is_production:
            # Production always requires real hardware, regardless of stale
            # simulator settings or a development environment override.
            self.simulate = False
        elif self.sbc.board is None:
            self.simulate = True
        return self

    @property
    def uses_emulator(self) -> bool:
        """True when the board driver runs on the emulator, not hardware."""
        if self.is_production or self.simulate or self.sbc.board is None:
            return False
        return True

    @model_validator(mode="after")
    def validate_channel_map(self):
        if len(self.pumps) < 3:
            raise ValueError("vacuum config must define at least 3 pumps")
        if len(self.pumps) > 8:
            raise ValueError("vacuum control sub-target supports at most 8 pumps")
        writes = [pump.write for pump in self.pumps]
        reads = [pump.read for pump in self.pumps]
        names = [pump.name for pump in self.pumps]
        if len(set(names)) != len(names):
            raise ValueError("vacuum equipment names must be unique")
        if MECHANICAL_PUMP not in names:
            raise ValueError(f"vacuum config requires {MECHANICAL_PUMP}")
        self._validate_groups()
        if len(set(writes)) != len(writes):
            raise ValueError("vacuum Port A output pins must be unique")
        if self.high_voltage_transformer.write in writes:
            raise ValueError("high-voltage output must not share a pump output pin")
        if len(set(reads)) != len(reads):
            raise ValueError("vacuum Port B comparator pins must be unique")
        section = "SBC.Channels" if self.sbc.board else "SBC.GPIO"
        missing = [
            pin for pin in writes + reads + [self.high_voltage_transformer.write]
            if pin not in self.sbc.channel_map
        ]
        if missing:
            raise ValueError(f"{section} is missing channels: {', '.join(missing)}")
        if self.sbc.board:
            unknown = sorted((set(self.sbc.gauges) | set(self.sbc.faults)
                              | set(self.sbc.valves)) - set(reads))
            if unknown:
                raise ValueError(
                    f"SBC gauges/faults/valves reference unknown channels: {', '.join(unknown)}")
        return self

    def _validate_groups(self) -> None:
        """``groupName`` defines the cascade; check it is well formed.

        * each group's equipment is listed contiguously, so the stage order
          is unambiguous;
        * the first group contains only the backing ``MechanicalVacuumPump``
          (it is always on and starts the cascade);
        * there is at least one downstream group.
        """
        seen: list[str] = []
        for pump in self.pumps:
            if seen and pump.group_name == seen[-1]:
                continue
            if pump.group_name in seen:
                raise ValueError(
                    f"groupName {pump.group_name!r} is split: list equipment of the "
                    "same group next to each other")
            seen.append(pump.group_name)
        first = [p.name for p in self.pumps if p.group_name == seen[0]]
        if first != [MECHANICAL_PUMP]:
            raise ValueError(
                f"the first groupName must contain only {MECHANICAL_PUMP}, got {first}")
        if len(seen) < 2:
            raise ValueError("vacuum config needs at least two groupName stages")

    @property
    def stages(self) -> list[tuple[str, list[str]]]:
        """``[(groupName, [equipment names]), ...]`` in cascade order."""
        stages: list[tuple[str, list[str]]] = []
        for pump in self.pumps:
            if stages and stages[-1][0] == pump.group_name:
                stages[-1][1].append(pump.name)
            else:
                stages.append((pump.group_name, [pump.name]))
        return stages

    @property
    def device(self) -> SbcDeviceConfig:
        return self.sbc


def find_vacuum_config_path() -> Path:
    configured = os.environ.get(VACUUM_CONFIG_ENV)
    path = Path(configured).expanduser() if configured else DEFAULT_VACUUM_CONFIG
    if not path.is_file():
        raise FileNotFoundError(f"vacuum configuration not found: {path}")
    return path.resolve()


def vacuum_config_enabled(path: Path) -> bool:
    """Read the feature flag without validating unused controller settings."""
    payload = json.loads(path.read_text())
    enabled = payload.get("Enable", True)
    if not isinstance(enabled, bool):
        raise ValueError("vacuum configuration Enable must be true or false")
    return enabled


def load_vacuum_config(path: Path) -> VacuumConfig:
    return VacuumConfig.model_validate(json.loads(path.read_text()))


def load_runtime_vacuum_config(path: Path) -> VacuumConfig:
    """The vacuum profile enables control; scanner production selects its mode."""
    payload = json.loads(path.read_text())
    enabled = payload.get("Enable", False)
    if not isinstance(enabled, bool):
        raise ValueError("vacuum configuration Enable must be true or false")
    payload["Enable"] = enabled
    stream_path = Path(os.environ.get("GLASGOW_CONFIG") or path.parent / "streamData.json")
    if enabled and stream_path.is_file():
        stream = json.loads(stream_path.read_text())
        production = stream.get("IsProduction", True)
        if not isinstance(production, bool):
            raise ValueError("stream configuration IsProduction must be true or false")
        payload["IsProduction"] = production
    # Runtime mode is selected by the scanner, not a stale simulator-tool flag.
    # GPIO-only profiles still use the simulator via select_execution_mode.
    if enabled:
        payload["Simulate"] = False
    return VacuumConfig.model_validate(payload)


def emulator_for_config(config: VacuumConfig):
    """Build the real-time emulated rig the config asks for, or None.

    The emulator is used for an SBC.Board config with ``Simulate: false`` when
    ``IsProduction`` is false. In that mode, ``Simulate: true`` selects the
    built-in deterministic simulator instead. Production requires hardware.
    """
    if not config.uses_emulator:
        return None
    from .emulation.raspberry_pi import PiSpec
    from .emulation.rig import VacuumRig

    model = os.environ.get(EMULATOR_MODEL_ENV, config.sbc.pi_model)
    speed = float(os.environ.get(EMULATOR_SPEED_ENV, "1"))
    spec = PiSpec(model=model) if model == "4B" else PiSpec(
        model="5", ram_gb=4, psu_amps=5.0, m2_hat=True, nvme=True, usb_ssd=False)
    return VacuumRig(spec=spec, realtime=True, speed=speed)


#: Backwards-compatible name.
emulator_from_environment = emulator_for_config


class VacuumController:
    POLL_INTERVAL_SECONDS = 1.0
    READING_MAX_AGE_SECONDS = 5.0
    SIMULATION_STEP_FRACTION = 0.02
    #: Default OFF dwell of a backing-pump restart (wall seconds).
    BACKING_RESTART_OFF_SECONDS = 3.0
    #: Float rounding only; not an operating tolerance (see _reading_reached).
    READING_MATCH_RTOL = 1e-9

    def __init__(
        self,
        config: VacuumConfig,
        device: VacuumDevice | None = None,
        authority: ExecutionAuthority | None = None,
        emulator=None,
    ):
        self.config = config
        self._authority = authority
        self._last_permit: ExecutionPermit | None = None
        if device is None and emulator is None:
            emulator = emulator_for_config(config)
        if (device is None and emulator is None and not config.is_production
                and not config.simulate):
            # Belt and braces: IsProduction=false must never open real GPIO/I2C.
            raise RuntimeError("IsProduction is false but no emulator or simulator was selected")
        self.emulator = emulator
        if device is not None:
            self.gpio = device
        elif config.sbc.board is not None and not config.simulate:
            from .vacuum_io_board import build_board_device

            self.gpio = build_board_device(
                config.sbc,
                {pin: config.sbc.channels[pin] for pin in
                 [*(p.write for p in config.pumps), config.high_voltage_transformer.write]},
                {pump.read: config.sbc.channels[pump.read] for pump in config.pumps},
                emulator=emulator,
            )
        elif config.simulate:
            self.gpio = SimulatedVacuumDevice(
                [*(pump.write for pump in config.pumps), config.high_voltage_transformer.write],
                (pump.read for pump in config.pumps),
                initial_outputs={
                    **{pump.write: pump.power.lower() == "on" for pump in config.pumps},
                    config.high_voltage_transformer.write: False,
                },
                gauge_channels={
                    pump.read: (pump.write, pump.threshold) for pump in config.pumps
                },
                error_range=config.error_range,
                simulation_step_fraction=self.SIMULATION_STEP_FRACTION,
            )
        else:
            self.gpio = RaspberryPiGPIODevice(
                {
                    **{pump.write: config.sbc.gpio[pump.write] for pump in config.pumps},
                    config.high_voltage_transformer.write:
                        config.sbc.gpio[config.high_voltage_transformer.write],
                },
                {pump.read: config.sbc.gpio[pump.read] for pump in config.pumps},
                # Process construction must always be electrically safe. The
                # controller explicitly energizes the mechanical pump only
                # after configuration and optional authority checks succeed.
                initial_outputs={
                    **{pump.write: False for pump in config.pumps},
                    config.high_voltage_transformer.write: False,
                },
                active_high=config.sbc.active_high,
                input_pull_up=config.sbc.input_pull_up,
            )
        if config.simulate and not isinstance(self.gpio, SimulatedVacuumDeviceControl):
            raise TypeError(
                "simulation requires a device implementing set_gauge_ready"
            )
        self._states = {
            pump.name: VacuumPumpState(
                name=pump.name,
                power=pump.power.lower() == "on",
                threshold=pump.threshold,
                write=pump.write,
                read=pump.read,
                group=pump.group_name,
                valve=(config.sbc.valves.get(pump.read)
                       if config.sbc.board is not None else None),
            )
            for pump in config.pumps
        }
        #: Cascade stages from ``groupName``, upstream first.
        self._stages: list[list[VacuumPumpState]] = [
            [self._states[name] for name in names] for _group, names in config.stages
        ]
        self._task: Optional[asyncio.Task] = None
        self._io_lock = asyncio.Lock()
        self._last_error: Optional[str] = None
        self._updated_at: Optional[str] = None
        self._last_poll_monotonic: float | None = None
        self._cascade_stopped = False
        self._running = False
        self._started_at: float | None = None
        self._simulation_reads = {pump.name: False for pump in config.pumps}
        self._high_voltage_power = False
        self._alarms: list[str] = []
        self._logged_error: Optional[str] = None
        self._injected_device = device is not None
        self._restart_task: Optional[asyncio.Task] = None
        self._log_mode_banner()

    # ------------------------------------------------------------- logging
    @property
    def run_mode(self) -> str:
        """``hardware``, ``emulator`` or ``simulator``."""
        if self.config.simulate:
            return "simulator"
        if self.emulator is not None or str(
                getattr(self.gpio, "transport", "")).endswith("emulator"):
            return "emulator"
        return "hardware"

    @property
    def log_tag(self) -> str:
        return LOG_TAGS[self.run_mode]

    def _log(self, level: int, event: str, message: str) -> None:
        log.log(level, "%s %s", self.log_tag, message,
                extra={"event": event, "vacuum_mode": self.run_mode})

    def _channel_name(self, logical: str) -> str:
        target = self.config.sbc.channel_map.get(logical)
        if target is None:
            return logical
        if self.config.sbc.board:
            return f"{logical}/{target}"
        return f"{logical}/{rpi_gpio_name(int(target))}"

    def _log_mode_banner(self) -> None:
        cfg = self.config
        mode = self.run_mode
        if mode == "simulator":
            reason = ("IsProduction=false with an SBC.GPIO config"
                      if cfg.sbc.board is None else "IsProduction=false, Simulate=true")
        elif mode == "emulator":
            reason = "IsProduction=false"
        elif self._injected_device:
            reason = "device injected by caller"
        else:
            reason = "IsProduction=true, Simulate=false"
        detail = (f"mode={mode} IsProduction={str(cfg.is_production).lower()} "
                  f"Simulate={str(cfg.simulate).lower()} transport={self._transport()} "
                  f"board={cfg.sbc.board or 'none'} PiModel={cfg.sbc.pi_model} "
                  f"reason={reason}")
        if mode == "hardware":
            self._log(logging.WARNING, "vacuum.mode",
                      f"LIVE HARDWARE: outputs drive real equipment; {detail}")
        else:
            self._log(logging.INFO, "vacuum.mode",
                      f"no real equipment is driven; {detail}")

    @property
    def requires_remote_authority(self) -> bool:
        return isinstance(self._authority, RemoteExecutionAuthority)

    def accept_remote_authority(
        self, holder_id: str, fencing_token: int, valid_for: float
    ) -> ExecutionPermit:
        if not isinstance(self._authority, RemoteExecutionAuthority):
            raise RuntimeError("remote fencing is not enabled")
        return self._authority.accept(holder_id, fencing_token, valid_for)

    def configure_expected_channels(self, expected: dict[str, float]) -> None:
        unknown = sorted(set(expected) - set(self._states))
        if unknown:
            raise ValueError(f"unknown vacuum channels: {', '.join(unknown)}")
        for name, value in expected.items():
            numeric = float(value)
            if not math.isfinite(numeric) or numeric <= 0:
                raise ValueError(f"expected value for {name} must be positive and finite")
            self._states[name].threshold = numeric
            for pump in self.config.pumps:
                if pump.name == name:
                    pump.threshold = numeric
                    break

    async def start(self) -> None:
        if self._running:
            return
        self._require_authority()
        self._running = True
        self._last_poll_monotonic = None
        self._started_at = time.monotonic()
        try:
            if self.config.simulate:
                self.gpio.reconnect()
            opener = getattr(self.gpio, "open", None)
            if opener is not None:
                # Board mode: reset the expanders (all outputs off), configure
                # them, start the watchdog heartbeat.
                await opener()
            self._alarms = []
            self._cascade_stopped = False
            await self._set_high_voltage_output(False)
            for name, state in self._states.items():
                self._simulation_reads[name] = False
                state.simulation_read = False
                state.value = None
                state.port_b_value = 0.0
                state.ready = False
                state.excursion = False
                if self.config.simulate:
                    async with self._io_lock:
                        await self.gpio.set_gauge_ready(state.read, False)
                # Initialization: every isolation valve closed, every pump
                # but the backing pump stopped.
                await self._set_valve(state, False, reason="initialization", force=True)
                if name != MECHANICAL_PUMP:
                    await self.set_power(name, False, automatic=True)
            await self.set_power(MECHANICAL_PUMP, True, automatic=True)
            self._task = asyncio.create_task(self._poll_worker(), name="vacuum-gpio-port-b-worker")
            self._log(logging.INFO, "vacuum.start",
                      "controller started" + (": expanders reset, watchdog heartbeat running"
                                              if self._is_board else ""))
        except BaseException as exc:
            self._running = False
            self._log(logging.ERROR, "vacuum.start", f"controller failed to start: {exc}")
            await self.gpio.close()
            raise

    async def close(self) -> None:
        self._running = False
        if self._restart_task is not None and not self._restart_task.done():
            self._restart_task.cancel()
            try:
                await self._restart_task
            except asyncio.CancelledError:
                pass
        self._restart_task = None
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._high_voltage_power:
            await self._set_high_voltage_output(False)
        for state in self._states.values():
            try:
                await self._set_valve(state, False, reason="controller stop")
            except Exception:
                pass    # the board reset below drops every solenoid anyway
        await self.gpio.close()
        self._log(logging.INFO, "vacuum.stop", "controller stopped: all managed outputs off")

    @property
    def isVacuumSystemReady(self) -> bool:
        """True only when every configured vacuum-equipment B pin is high,
        no pump reports a fault and no board interlock is active."""
        return self._readings_current and bool(self._states) and not self._alarms and all(
            state.port_b_value == self.config.device.voltage
            and state.fault is not True
            and not state.excursion
            and (state.ready or not self._is_board)
            for state in self._states.values()
        )

    @property
    def _readings_current(self) -> bool:
        return (self._running and self._last_error is None
                and self._last_poll_monotonic is not None
                and time.monotonic() - self._last_poll_monotonic <= self.READING_MAX_AGE_SECONDS)

    @property
    def _is_board(self) -> bool:
        return hasattr(self.gpio, "read_safety")

    def _transport(self) -> str:
        if self.config.simulate:
            return "sbc-simulation"
        return getattr(self.gpio, "transport", "raspberry-pi-gpio")

    def status(self) -> VacuumSystemStatus:
        board = None
        if self._is_board:
            board = self.gpio.board_status().as_dict()
        return VacuumSystemStatus(
            device_id=self.config.device.id,
            voltage=self.config.device.voltage,
            connected=self._readings_current,
            simulation=self.config.simulate,
            control_transport=self._transport(),
            is_production=self.config.is_production,
            alarms=list(self._alarms),
            board=board,
            running=self._running,
            runtime_seconds=(
                max(0.0, time.monotonic() - self._started_at)
                if self._running and self._started_at is not None else 0.0
            ),
            cascade_stopped=self._cascade_stopped,
            restarting=self.restarting,
            isVacuumSystemReady=self.isVacuumSystemReady,
            high_voltage_power=self._high_voltage_power,
            last_error=(self._last_error or
                        ("vacuum readings are stale" if self._running
                         and self._last_poll_monotonic is not None
                         and not self._readings_current else None)),
            updated_at=self._updated_at,
            pumps=[state.model_copy(update={} if self._readings_current else {
                "value": None, "ready": False, "port_b_value": 0.0,
                "border": (state.border if self._last_poll_monotonic is None
                           else "error" if state.power else "off"),
            }) for state in self._states.values()],
        )

    async def set_high_voltage_power(self, power: bool) -> None:
        """Control the transformer with vacuum readiness as a hard interlock."""
        async with self._io_lock:
            if power:
                self._require_authority()
                if not self._running:
                    raise RuntimeError("vacuum controller is not running")
                # Check while holding the same lock used for GPIO reads and
                # writes so a poll cannot invalidate the interlock between
                # validation and energizing the transformer.
                if not self.isVacuumSystemReady:
                    raise ValueError("high voltage requires the vacuum system to be ready")
            await self.gpio.write(self.config.high_voltage_transformer.write, power)
            self._log_high_voltage(power, "operator")
            self._high_voltage_power = power

    async def _set_high_voltage_output(self, power: bool) -> None:
        async with self._io_lock:
            await self.gpio.write(self.config.high_voltage_transformer.write, power)
        self._log_high_voltage(power, "interlock")
        self._high_voltage_power = power

    def _log_high_voltage(self, power: bool, source: str) -> None:
        if power == self._high_voltage_power:
            return
        channel = self._channel_name(self.config.high_voltage_transformer.write)
        self._log(logging.WARNING if power else logging.INFO, "vacuum.high_voltage",
                  f"HighVoltageTransformer ({channel}) permissive {'ON' if power else 'OFF'} "
                  f"({source})")

    async def set_power(self, name: str, power: bool, *, automatic: bool = False) -> None:
        state = self._states.get(name)
        if state is None:
            raise KeyError(name)
        if name == MECHANICAL_PUMP and not power:
            raise ValueError("MechanicalVacuumPump must remain powered on")
        try:
            async with self._io_lock:
                # Validate immediately before the side effect. This catches a
                # lease lost while the caller was waiting for another GPIO
                # operation to release the lock.
                self._require_authority()
                await self.gpio.write(state.write, power)
                if self.config.simulate and not power:
                    await self.gpio.set_gauge_ready(state.read, False)
            if state.power != power:
                self._log(logging.INFO, "vacuum.output",
                          f"{name} ({self._channel_name(state.write)}) "
                          f"{'ON' if power else 'OFF'} ({'automatic' if automatic else 'manual'})")
            state.power = power
            state.port_a_value = self.config.device.voltage if power else 0.0
            state.ready = False
            state.border = "waiting" if power else "off"
            state.port_b_value = 0.0
            if not power:
                state.value = None
            if not power:
                self._simulation_reads[name] = False
                state.simulation_read = False
            self._last_error = None
            if not automatic:
                # A manual pump toggle applies only to the selected pump.
                # Keep the cascade paused for downstream manual controls so
                # polling cannot implicitly energize a sibling UH pump.
                self._cascade_stopped = name != MECHANICAL_PUMP or not power
            if name != MECHANICAL_PUMP and not power and not automatic:
                await self._reset_mechanical_if_downstream_stopped()
        except Exception as exc:
            state.border = "error"
            self._last_error = str(exc)
            self._log(logging.ERROR, "vacuum.output",
                      f"{name} ({self._channel_name(state.write)}) "
                      f"{'ON' if power else 'OFF'} failed: {exc}")
            raise

    # ------------------------------------------------------- backing restart
    @property
    def restarting(self) -> bool:
        """True while a backing-pump restart is in progress."""
        return self._restart_task is not None and not self._restart_task.done()

    async def restart_backing_pump(self, off_seconds: float | None = None) -> None:
        """Power-cycle the backing (mechanical) pump, like controller initialization.

        Runs the stop phase before returning -- high voltage off, every other
        pump stopped (downstream first), every isolation valve closed, the
        mechanical pump switched OFF -- then, in the background, waits
        ``off_seconds`` and switches the mechanical pump ON again.  The
        cascade then restarts from the top exactly as after ``start()``.
        """
        self._require_authority()
        if not self._running:
            raise RuntimeError("vacuum controller is not running")
        if self.restarting:
            raise ValueError("a backing-pump restart is already in progress")
        off = self.BACKING_RESTART_OFF_SECONDS if off_seconds is None else float(off_seconds)
        if not 0.0 <= off <= 60.0:
            raise ValueError("off_seconds must be between 0 and 60")
        self._log(logging.WARNING, "vacuum.restart",
                  f"{MECHANICAL_PUMP} restart requested: stopping every pump, closing every "
                  f"valve, OFF for {off:g} s")
        self._cascade_stopped = True          # nothing advances while restarting
        if self._high_voltage_power:
            await self._set_high_voltage_output(False)
        for stage in reversed(self._stages[1:]):
            for state in stage:
                if state.power:
                    await self.set_power(state.name, False, automatic=True)
        for state in self._states.values():
            state.excursion = False
            await self._set_valve(state, False, reason="backing pump restart")
        mechanical = self._states[MECHANICAL_PUMP]
        async with self._io_lock:
            self._require_authority()
            await self.gpio.write(mechanical.write, False)
        self._log(logging.WARNING, "vacuum.output",
                  f"{MECHANICAL_PUMP} ({self._channel_name(mechanical.write)}) OFF (restart)")
        mechanical.power = False
        mechanical.port_a_value = 0.0
        mechanical.ready = False
        mechanical.value = None
        mechanical.border = "off"
        self._restart_task = asyncio.create_task(
            self._finish_backing_restart(off), name="vacuum-backing-restart")

    async def _finish_backing_restart(self, off_seconds: float) -> None:
        try:
            await asyncio.sleep(off_seconds)
            if not self._running:
                return
            await self.set_power(MECHANICAL_PUMP, True, automatic=True)
            self._cascade_stopped = False     # restart the cascade from the top
            self._log(logging.INFO, "vacuum.restart",
                      f"{MECHANICAL_PUMP} back ON: cascade restarting from the top")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._last_error = f"backing-pump restart failed: {exc}"
            self._log(logging.ERROR, "vacuum.restart", self._last_error)

    async def stop_non_mechanical(self) -> None:
        self._require_authority()
        self._cascade_stopped = True
        for name, state in self._states.items():
            if name != MECHANICAL_PUMP and state.power:
                await self.set_power(name, False, automatic=True)

    async def resume_cascade(self) -> None:
        """Resume automatic progression from the current measured state.

        On the I/O board this is also the explicit operator reset after an
        E-stop, output-rail or keep-alive trip: the heartbeat is re-armed and
        the backing pump restarted.  Nothing restarts by itself when the
        E-stop is released.
        """
        self._require_authority()
        if not self._running:
            raise RuntimeError("vacuum controller is not running")
        if self._is_board:
            await self.poll_once()
            estop_ok, _rail_ok = self.gpio.read_safety()
            if not estop_ok:
                raise RuntimeError("cannot resume: E-stop loop is open")
            rearm = getattr(self.gpio, "rearm", None)
            if rearm is not None:
                await rearm()
            self._last_error = None
            mechanical = self._states.get(MECHANICAL_PUMP)
            if mechanical is not None and not self.gpio.output_level(mechanical.write):
                await self.set_power(MECHANICAL_PUMP, True, automatic=True)
        self._log(logging.INFO, "vacuum.resume", "operator resume: cascade re-enabled")
        self._cascade_stopped = False
        await self.poll_once()

    async def set_simulated_read(self, name: str, checked: bool) -> None:
        if not self.config.simulate:
            raise ValueError("simulated read controls are read-only on real hardware")
        state = self._states.get(name)
        if state is None:
            raise KeyError(name)
        self._simulation_reads[name] = checked
        state.simulation_read = checked
        async with self._io_lock:
            await self.gpio.set_gauge_ready(state.read, checked)
        if name == MECHANICAL_PUMP and checked:
            self._cascade_stopped = False
        if name != MECHANICAL_PUMP and not checked:
            await self.set_power(name, False)
            await self.poll_once()
            return
        await self.poll_once()

    async def set_simulated_excursion(self, name: str, pressure_mbar: float | None) -> None:
        """Inject or clear a gauge excursion in the deterministic simulator."""
        if not self.config.simulate:
            raise ValueError("simulated excursions are unavailable outside simulation mode")
        state = self._states.get(name)
        if state is None:
            raise KeyError(name)
        if not state.power:
            raise ValueError(f"{name} must be running before an excursion can be injected")
        self._simulation_reads[name] = True
        state.simulation_read = True
        async with self._io_lock:
            self._require_authority()
            await self.gpio.set_gauge_excursion(state.read, pressure_mbar)
        await self.poll_once()

    async def _reset_mechanical_if_downstream_stopped(self) -> None:
        if not self.config.simulate:
            return
        downstream = [
            state for name, state in self._states.items() if name != MECHANICAL_PUMP
        ]
        if not downstream or any(state.power for state in downstream):
            return
        mechanical = self._states.get(MECHANICAL_PUMP)
        if mechanical is None:
            return
        self._simulation_reads[MECHANICAL_PUMP] = False
        async with self._io_lock:
            await self.gpio.set_gauge_ready(mechanical.read, False)
        mechanical.simulation_read = False
        mechanical.value = None
        mechanical.port_b_value = 0.0
        mechanical.ready = False
        mechanical.border = "waiting" if mechanical.power else "off"
        self._cascade_stopped = True

    async def poll_once(self) -> None:
        try:
            async with self._io_lock:
                gauge_values = await self.gpio.read_gauge_values()
                readings = await self.gpio.read_port_b()
            board = self._is_board
            faults = self.gpio.fault_states() if board else {}
            interlocks = self.gpio.gauge_interlocks() if board else {}
            for state in self._states.values():
                state.value = gauge_values.get(state.read)
                state.port_a_value = (
                    self.config.device.voltage if self.gpio.output_level(state.write) else 0.0
                )
                state.port_b_value = (
                    self.config.device.voltage if readings[state.read] else 0.0
                )
                state.simulation_read = self._simulation_reads[state.name]
                state.fault = (not faults[state.read]) if state.read in faults else None
                if state.power:
                    ready = state.port_b_value == self.config.device.voltage
                    if state.fault:
                        ready = False
                    # The real-time reading must reach the configured value
                    # before the pump reports ready (success).  Board mode:
                    # every configured gauge unless "Interlock": false.
                    # Direct GPIO: whenever a gauge adapter supplies a reading.
                    gauge_checked = (interlocks.get(state.read) if board
                                     else state.value is not None)
                    if gauge_checked:
                        ready = ready and self._reading_reached(state)
                    # Vacuum excursion: the pump is running, its ready input
                    # is still on, but its reading rose above its value after
                    # it had been ready (valve open).  Close its valve and
                    # show it red until the pump works the reading back down.
                    input_ok = (state.port_b_value == self.config.device.voltage
                                and not state.fault)
                    state.excursion = bool(
                        not ready and gauge_checked and input_ok
                        and (state.excursion or state.valve_open))
                    state.ready = ready
                    state.border = "error" if (state.fault or state.excursion) else (
                        "ready" if ready else "waiting")
                else:
                    state.excursion = False
                    state.ready = False
                    state.border = "error" if state.fault else "off"
            self._updated_at = datetime.now(timezone.utc).isoformat()
            self._last_poll_monotonic = time.monotonic()
            self._last_error = None
            if self._logged_error is not None:
                self._log(logging.INFO, "vacuum.poll", "device communication recovered")
                self._logged_error = None
            if board:
                await self._enforce_board_safety()
            await self._enforce_interlocks()
            if self._high_voltage_power and not self.isVacuumSystemReady:
                await self._set_high_voltage_output(False)
            if not self._cascade_stopped:
                await self._advance_cascade()
            await self._apply_valves()
        except Exception as exc:
            errors = [str(exc)]
            if self._high_voltage_power:
                try:
                    await self._set_high_voltage_output(False)
                except Exception as shutdown_exc:
                    errors.append(f"failed to de-energize high voltage: {shutdown_exc}")
            # Input state is unknown. Attempt the safe downstream state even
            # when the read path failed; keep the backing pump untouched.
            for name, state in self._states.items():
                if name == MECHANICAL_PUMP or not state.power:
                    continue
                try:
                    async with self._io_lock:
                        self._require_authority()
                        await self.gpio.write(state.write, False)
                    state.power = False
                    state.port_a_value = 0.0
                    state.value = None
                    state.border = "off"
                except Exception as shutdown_exc:
                    errors.append(f"failed to de-energize {name}: {shutdown_exc}")
                    state.border = "error"
            for state in self._states.values():
                try:
                    await self._set_valve(state, False, reason="device error")
                except Exception as valve_exc:
                    errors.append(f"failed to close {state.valve or 'valve'} of "
                                  f"{state.name}: {valve_exc}")
            self._cascade_stopped = True
            self._last_error = "; ".join(errors)
            if self._last_error != self._logged_error:
                # Logged once per distinct error, not on every 1 s poll.
                self._log(logging.ERROR, "vacuum.poll",
                          f"device error, downstream outputs de-energized: {self._last_error}")
                self._logged_error = self._last_error
            for state in self._states.values():
                state.value = None
                state.port_b_value = 0.0
                state.ready = False
                if self._is_board:
                    # After an expander reset the hardware already dropped
                    # every output, the backing pump included.
                    try:
                        state.power = self.gpio.output_level(state.write)
                        state.port_a_value = self.config.device.voltage if state.power else 0.0
                    except Exception:
                        pass
                if state.power:
                    state.border = "error"

    async def _force_off(self, state: VacuumPumpState) -> None:
        """De-energize one output, bypassing the 'mechanical stays on' rule.

        Used only when the hardware has already removed power (E-stop), so
        that restoring power does not restart equipment by itself.
        """
        async with self._io_lock:
            self._require_authority()
            await self.gpio.write(state.write, False)
        if state.power:
            self._log(logging.WARNING, "vacuum.output",
                      f"{state.name} ({self._channel_name(state.write)}) OFF "
                      "(forced: hardware rail lost, no automatic restart)")
        state.power = False
        state.port_a_value = 0.0
        state.ready = False
        state.value = None
        state.border = "off"

    async def _enforce_board_safety(self) -> None:
        """Rail and fault interlocks of the RPi5VacuumIO board."""
        estop_ok, rail_ok = self.gpio.read_safety()
        alarms: list[str] = []
        if not estop_ok:
            alarms.append("E-stop loop open: +24V_ESTOP and +24V_SAFE are off")
        elif not rail_ok:
            alarms.append("output rail +24V_SAFE is off (watchdog relay K10 dropped)")
        for name, state in self._states.items():
            if state.fault:
                alarms.append(f"{name} fault input open")
        tripped = False
        if not estop_ok or not rail_ok:
            # The relays already dropped in hardware.  Make the commanded
            # state match, so nothing restarts when the rail returns.
            for name, state in self._states.items():
                if name == MECHANICAL_PUMP and estop_ok:
                    continue   # K1 runs from +24V_ESTOP by default (JP1)
                if state.power:
                    await self._force_off(state)
                    tripped = True
            if self._high_voltage_power:
                await self._set_high_voltage_output(False)
        for name, state in self._states.items():
            if state.fault and state.power and name != MECHANICAL_PUMP:
                await self.set_power(name, False, automatic=True)
                state.border = "error"
                tripped = True
        # Latch on a trip or on any *new* alarm.  An alarm that persists
        # across an operator resume does not re-latch, so healthy stages
        # can run while, say, one UH pump stays faulted (it is never started).
        for alarm in alarms:
            if alarm not in self._alarms:
                self._log(logging.WARNING, "vacuum.alarm", f"ALARM raised: {alarm}")
        for alarm in self._alarms:
            if alarm not in alarms:
                self._log(logging.INFO, "vacuum.alarm", f"alarm cleared: {alarm}")
        if tripped or (set(alarms) - set(self._alarms)):
            self._cascade_stopped = True
        self._alarms = alarms

    def _reading_reached(self, state: VacuumPumpState) -> bool:
        """Reading equals the configured ``value`` or is lower; no reading is not reached.

        No tolerance above the configured value.  ``READING_MATCH_RTOL`` only
        absorbs floating-point rounding in the gauge conversion, so a reading
        that is numerically equal to the configured value counts as a match.
        """
        limit = state.threshold * (1 + self.READING_MATCH_RTOL)
        return state.value is not None and state.value <= limit

    @staticmethod
    def _stage_ready(stage: list[VacuumPumpState]) -> bool:
        """A ``groupName`` stage is ready when every member is ready."""
        return bool(stage) and all(state.ready for state in stage)

    async def _advance_cascade(self) -> None:
        """Start the first ``groupName`` stage whose upstream stage is ready.

        One stage per poll.  All members of a stage are energized together
        before any of them is evaluated; a member whose fault input is open is
        never started.
        """
        for upstream, stage in zip(self._stages, self._stages[1:]):
            if not self._stage_ready(upstream):
                return
            pending = [s for s in stage if not s.power and s.fault is not True]
            if pending:
                for state in pending:
                    await self.set_power(state.name, True, automatic=True)
                return

    @staticmethod
    def _stage_holding(stage: list[VacuumPumpState]) -> bool:
        """Members are ready, or merely isolated by a vacuum excursion.

        An excursion closes that pump's valve but the pump keeps running, so
        it does not pull the stages downstream of it down.
        """
        return bool(stage) and all(s.ready or s.excursion for s in stage)

    async def _enforce_interlocks(self) -> None:
        backing = self._stages[0] if self._stages else []
        if backing and not self._stage_ready(backing):
            # The backing (mechanical) pump lost vacuum or its ready input:
            # restart like controller initialization -- every other pump
            # stopped and every valve closed at once.  The backing pump keeps
            # running to recover; the cascade then restarts from the top.
            stopped = [s for stage in self._stages[1:] for s in stage if s.power]
            for state in stopped:
                await self.set_power(state.name, False, automatic=True)
            for stage in self._stages:
                for state in stage:
                    await self._set_valve(state, False, reason="backing pump restart")
            if stopped:
                self._log(logging.WARNING, "vacuum.restart",
                          f"{MECHANICAL_PUMP} not ready: stopped "
                          f"{', '.join(s.name for s in stopped)}; all valves closed")
            return
        await self._enforce_stage_interlocks()

    async def _apply_valves(self) -> None:
        """Each pump's isolation valve is open exactly while it is ready."""
        for state in self._states.values():
            await self._set_valve(state, state.ready, reason=(
                "ready" if state.ready else
                "vacuum excursion" if state.excursion else "not ready"))

    async def _set_valve(self, state: VacuumPumpState, open_: bool, *,
                         reason: str, force: bool = False) -> None:
        board_valve = self._is_board and state.valve is not None
        current = self.gpio.valve_level(state.read) if board_valve else state.valve_open
        if current == open_ and not force:
            state.valve_open = bool(current)
            return
        if board_valve:
            async with self._io_lock:
                self._require_authority()
                await self.gpio.write_valve(state.read, open_)
            open_ = bool(self.gpio.valve_level(state.read))
        if state.valve_open != open_:
            self._log(logging.INFO if open_ else logging.WARNING, "vacuum.valve",
                      f"{state.name} isolation valve {state.valve or '(virtual)'} "
                      f"{'OPEN' if open_ else 'CLOSED'} ({reason})")
        state.valve_open = open_

    async def _enforce_stage_interlocks(self) -> None:
        # Reconcile from downstream to upstream before advancing. A dropped
        # comparator is an interlock event, not merely a dashboard update:
        # a stage loses power as soon as its upstream stage is not ready.
        # The backing/mechanical stage is never switched off here.
        for index in range(len(self._stages) - 1, 0, -1):
            if self._stage_holding(self._stages[index - 1]):
                continue
            for state in self._stages[index]:
                if state.power:
                    await self.set_power(state.name, False, automatic=True)

    async def _poll_worker(self) -> None:
        while True:
            await self.poll_once()
            await asyncio.sleep(self.POLL_INTERVAL_SECONDS)

    def _require_authority(self) -> ExecutionPermit | None:
        """Return the live executor permit, if fencing is enabled."""
        if self._authority is None:
            return None
        permit = self._authority.require()
        self._last_permit = permit
        return permit
