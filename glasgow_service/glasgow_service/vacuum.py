"""Configuration-driven Raspberry Pi SBC vacuum control."""
from __future__ import annotations

import asyncio
import json
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


VACUUM_CONFIG_ENV = "SBC_VACUUM_CONFIG"
DEFAULT_VACUUM_CONFIG = (
    Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"
)
GPIO_PIN_RE = re.compile(r"^[AB]([0-7])$")
MECHANICAL_PUMP = "MechanicalVacuumPump"
UH_GROUP = "ultra-high-vacuum"


def _parse_threshold(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().lower().replace(" ", "")
    # The supplied config uses values such as ``1.0*e-1``.  Normalize this
    # project-specific spelling to standard scientific notation.
    text = text.replace("*e", "e")
    return float(text)


class SbcDeviceConfig(BaseModel):
    id: str = Field("raspberry-pi", alias="Id")
    voltage: float = 3.3
    gpio: dict[str, int] = Field(alias="GPIO")
    active_high: bool = Field(True, alias="ActiveHigh")
    input_pull_up: bool | None = Field(None, alias="InputPullUp")


class VacuumPumpConfig(BaseModel):
    name: str
    power: str = "off"
    threshold: float = Field(alias="value")
    write: str
    read: str

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
    sbc: SbcDeviceConfig = Field(alias="SBC")
    high_voltage_transformer: HighVoltageTransformerConfig = Field(
        alias="HighVoltageTransformer"
    )

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
        for required in (MECHANICAL_PUMP, "TurboVacuumPump"):
            if required not in names:
                raise ValueError(f"vacuum config requires {required}")
        if len(set(writes)) != len(writes):
            raise ValueError("vacuum Port A output pins must be unique")
        if self.high_voltage_transformer.write in writes:
            raise ValueError("high-voltage output must not share a pump output pin")
        if len(set(reads)) != len(reads):
            raise ValueError("vacuum Port B comparator pins must be unique")
        missing = [
            pin for pin in writes + reads + [self.high_voltage_transformer.write]
            if pin not in self.sbc.gpio
        ]
        if missing:
            raise ValueError(f"SBC.GPIO is missing channels: {', '.join(missing)}")
        return self

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


class VacuumController:
    POLL_INTERVAL_SECONDS = 1.0
    SIMULATION_STEP_FRACTION = 0.02

    def __init__(
        self,
        config: VacuumConfig,
        device: VacuumDevice | None = None,
        authority: ExecutionAuthority | None = None,
    ):
        self.config = config
        self._authority = authority
        self._last_permit: ExecutionPermit | None = None
        if device is not None:
            self.gpio = device
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
                group=UH_GROUP if pump.name.startswith("UHVacuumPump_") else None,
            )
            for pump in config.pumps
        }
        self._task: Optional[asyncio.Task] = None
        self._io_lock = asyncio.Lock()
        self._last_error: Optional[str] = None
        self._updated_at: Optional[str] = None
        self._cascade_stopped = False
        self._running = False
        self._started_at: float | None = None
        self._simulation_reads = {pump.name: False for pump in config.pumps}
        self._high_voltage_power = False

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
        self._started_at = time.monotonic()
        try:
            if self.config.simulate:
                self.gpio.reconnect()
            self._cascade_stopped = False
            await self._set_high_voltage_output(False)
            for name, state in self._states.items():
                self._simulation_reads[name] = False
                state.simulation_read = False
                state.value = None
                state.port_b_value = 0.0
                state.ready = False
                if self.config.simulate:
                    async with self._io_lock:
                        await self.gpio.set_gauge_ready(state.read, False)
                if name != MECHANICAL_PUMP:
                    await self.set_power(name, False, automatic=True)
            await self.set_power(MECHANICAL_PUMP, True, automatic=True)
            self._task = asyncio.create_task(self._poll_worker(), name="vacuum-gpio-port-b-worker")
        except BaseException:
            self._running = False
            await self.gpio.close()
            raise

    async def close(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._high_voltage_power:
            await self._set_high_voltage_output(False)
        await self.gpio.close()

    @property
    def isVacuumSystemReady(self) -> bool:
        """True only when every configured vacuum-equipment B pin is high."""
        return bool(self._states) and all(
            state.port_b_value == self.config.device.voltage
            for state in self._states.values()
        )

    def status(self) -> VacuumSystemStatus:
        return VacuumSystemStatus(
            device_id=self.config.device.id,
            voltage=self.config.device.voltage,
            connected=self._last_error is None,
            simulation=self.config.simulate,
            control_transport=(
                "sbc-simulation" if self.config.simulate else
                "raspberry-pi-gpio"
            ),
            running=self._running,
            runtime_seconds=(
                max(0.0, time.monotonic() - self._started_at)
                if self._running and self._started_at is not None else 0.0
            ),
            cascade_stopped=self._cascade_stopped,
            isVacuumSystemReady=self.isVacuumSystemReady,
            high_voltage_power=self._high_voltage_power,
            last_error=self._last_error,
            updated_at=self._updated_at,
            pumps=[state.model_copy() for state in self._states.values()],
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
            self._high_voltage_power = power

    async def _set_high_voltage_output(self, power: bool) -> None:
        async with self._io_lock:
            await self.gpio.write(self.config.high_voltage_transformer.write, power)
        self._high_voltage_power = power

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
            raise

    async def stop_non_mechanical(self) -> None:
        self._require_authority()
        self._cascade_stopped = True
        for name, state in self._states.items():
            if name != MECHANICAL_PUMP and state.power:
                await self.set_power(name, False, automatic=True)

    async def resume_cascade(self) -> None:
        """Resume automatic progression from the current measured state."""
        self._require_authority()
        if not self._running:
            raise RuntimeError("vacuum controller is not running")
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
            for state in self._states.values():
                state.value = gauge_values.get(state.read)
                state.port_a_value = (
                    self.config.device.voltage if self.gpio.output_level(state.write) else 0.0
                )
                state.port_b_value = (
                    self.config.device.voltage if readings[state.read] else 0.0
                )
                state.simulation_read = self._simulation_reads[state.name]
                if state.power:
                    state.ready = state.port_b_value == self.config.device.voltage
                    state.border = "ready" if state.ready else "waiting"
                else:
                    state.ready = False
                    state.border = "off"
            self._updated_at = datetime.now(timezone.utc).isoformat()
            self._last_error = None
            await self._enforce_interlocks()
            if self._high_voltage_power and not self.isVacuumSystemReady:
                await self._set_high_voltage_output(False)
            if not self._cascade_stopped:
                await self._advance_cascade()
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
            self._cascade_stopped = True
            self._last_error = "; ".join(errors)
            for state in self._states.values():
                state.value = None
                state.port_b_value = 0.0
                state.ready = False
                if state.power:
                    state.border = "error"

    async def _advance_cascade(self) -> None:
        mechanical = self._states.get(MECHANICAL_PUMP)
        turbo = self._states.get("TurboVacuumPump")
        uh = [state for state in self._states.values() if state.group == UH_GROUP]
        if mechanical and mechanical.ready and turbo and not turbo.power:
            await self.set_power(turbo.name, True, automatic=True)
            return
        if turbo and turbo.ready and uh and not all(state.power for state in uh):
            # The UH pumps are a stage: energize both before evaluating either.
            for state in uh:
                if not state.power:
                    await self.set_power(state.name, True, automatic=True)

    async def _enforce_interlocks(self) -> None:
        mechanical = self._states.get(MECHANICAL_PUMP)
        turbo = self._states.get("TurboVacuumPump")
        uh = [state for state in self._states.values() if state.group == UH_GROUP]
        # Reconcile from downstream to upstream before advancing. A dropped
        # comparator is an interlock event, not merely a dashboard update.
        # Keep the backing/mechanical pump running so the chamber can recover.
        if turbo and not turbo.ready:
            for state in uh:
                if state.power:
                    await self.set_power(state.name, False, automatic=True)
        if mechanical and not mechanical.ready:
            if turbo and turbo.power:
                await self.set_power(turbo.name, False, automatic=True)

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
