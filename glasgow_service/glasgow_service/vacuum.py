"""Vacuum-system GPIO control backed by ``vacuumSystem.json``.

The controller follows the same ``glasgow run control-gpio`` command path
used by ``GlasgowDataIO/glasgowWriteDataApp.py``. Reads sample every
configured Port B pin in one subprocess call, then distribute the returned
levels to the configured pump models.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from .comparator_subtarget import ComparatorTarget, VacuumComparatorSubtarget
from .models import VacuumPumpState, VacuumSystemStatus
from .execution_authority import (
    ExecutionAuthority,
    ExecutionPermit,
    RemoteExecutionAuthority,
)
from .vacuum_device import (
    SimulatedVacuumDevice,
    SimulatedVacuumDeviceControl,
    VacuumDevice,
)


VACUUM_CONFIG_ENV = "GLASGOW_VACUUM_CONFIG"
DEFAULT_VACUUM_CONFIG = Path(
    "/home/vboxuser/Project/Operations/Development/GlasgowDataIO/Json/vacuumSystem.json"
)
GPIO_PIN_RE = re.compile(r"^[AB]([0-7])$")
GPIO_VALUE_RE = re.compile(r"\b(B[0-7])=([01])\b")
MECHANICAL_PUMP = "MechanicalVacuumPump"
UH_GROUP = "ultra-high-vacuum"
VENDORED_GLASGOW_ROOT = (
    Path(__file__).resolve().parents[2]
    / "GlasgowDataIO" / "IobeamControl" / "glasgowLib"
)


def _parse_threshold(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().lower().replace(" ", "")
    # The supplied config uses values such as ``1.0*e-1``.  Normalize this
    # project-specific spelling to standard scientific notation.
    text = text.replace("*e", "e")
    return float(text)


class GlasgowDeviceConfig(BaseModel):
    id: str = Field(alias="Id")
    voltage: float = 3.3


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


class VacuumActionData(BaseModel):
    command_format: str = Field(alias="commandFormat")


class VacuumAction(BaseModel):
    action_data: VacuumActionData = Field(alias="actionData")
    # Loading an FPGA applet and configuring the USB interface routinely
    # takes tens of seconds, especially when the bitstream is generated.
    timeout: float = Field(60.0, gt=0, le=120)


class VacuumConfig(BaseModel):
    enabled: bool = Field(True, alias="Enable")
    glasgow: dict[str, GlasgowDeviceConfig] = Field(alias="Glasgow")
    pumps: list[VacuumPumpConfig] = Field(alias="VacuumPumps")
    actions: list[dict[str, VacuumAction]] = Field(alias="Actions")
    error_range: float = Field(alias="errorRange", ge=0, le=1)
    log_name: str = Field("VacuumDashboard", alias="LogName")
    verbose: bool = Field(False, alias="Verbose")
    simulate: bool = Field(False, alias="Simulate")

    @model_validator(mode="after")
    def validate_channel_map(self):
        if not self.pumps:
            raise ValueError("vacuum config must define at least one pump")
        if len(self.pumps) > 8:
            raise ValueError("vacuum control sub-target supports at most 8 pumps")
        writes = [pump.write for pump in self.pumps]
        reads = [pump.read for pump in self.pumps]
        if len(set(writes)) != len(writes):
            raise ValueError("vacuum Port A output pins must be unique")
        if len(set(reads)) != len(reads):
            raise ValueError("vacuum Port B comparator pins must be unique")
        return self

    def action(self, name: str) -> VacuumAction:
        for item in self.actions:
            if name in item:
                return item[name]
        raise ValueError(f"vacuum config is missing Actions.{name}")

    @property
    def device(self) -> GlasgowDeviceConfig:
        if not self.glasgow:
            raise ValueError("vacuum config does not define a Glasgow device")
        return next(iter(self.glasgow.values()))


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


class VacuumGPIOInterface:
    """Dedicated GPIO protocol adapter for the vacuum controller."""

    def __init__(
        self,
        config: VacuumConfig,
        comparator_subtarget: Optional[VacuumComparatorSubtarget] = None,
    ):
        if not config.enabled:
            raise RuntimeError("vacuum controller is disabled by configuration")
        self.config = config
        self.comparator_subtarget = comparator_subtarget or VacuumComparatorSubtarget(
            config.device.id,
            config.device.voltage,
            config.pumps,
        )
        self._outputs = {pump.write: pump.power.lower() == "on" for pump in config.pumps}
        self._comparator_outputs = {pump.read: False for pump in config.pumps}
        self._read_pins = sorted(self._comparator_outputs)
        self._pump_by_write = {pump.write: pump for pump in config.pumps}

    async def write(self, pin: str, value: bool) -> None:
        pump = self._pump_by_write.get(pin)
        if pump is None:
            raise ValueError(f"unknown vacuum output pin: {pin}")
        next_outputs = {**self._outputs, pin: value}
        if self.config.simulate:
            self._outputs = next_outputs
            return
        if not self.config.simulate:
            await self.comparator_subtarget.write_target(
                ComparatorTarget(
                    equipment=pump.name,
                    source_pin=pump.write,
                    result_pin=pump.read,
                    configured_value=pump.threshold,
                    error_range=self.config.error_range,
                    high_voltage=self.config.device.voltage,
                    enabled=value,
                )
            )
            self._outputs = next_outputs
            return

        action = self.config.action("writeData")
        output_pins = sorted(next_outputs)
        output_actions = " ".join(
            f"{output_pin}={int(next_outputs[output_pin])}" for output_pin in output_pins
        )
        command = action.action_data.command_format.format(
            self.config.device.voltage, ",".join(output_pins), output_actions
        )
        await self._run(command, action.timeout)
        self._outputs = next_outputs

    async def write_comparator(self, pin: str, value: bool) -> None:
        """Drive a simulated comparator result onto its configured Port B pin."""
        if pin not in self._comparator_outputs:
            raise ValueError(f"unknown comparator output pin: {pin}")
        if self._comparator_outputs[pin] == value:
            return

        next_comparators = {**self._comparator_outputs, pin: value}
        if self.config.simulate:
            self._comparator_outputs = next_comparators
            return

        action = self.config.action("writeData")
        # A GPIO applet invocation replaces the previous one, so reassert the
        # pump power outputs together with every configured comparator output.
        pin_values = {**self._outputs, **next_comparators}
        pins = sorted(pin_values)
        output_actions = " ".join(
            f"{output_pin}={int(pin_values[output_pin])}" for output_pin in pins
        )
        command = action.action_data.command_format.format(
            self.config.device.voltage, ",".join(pins), output_actions
        )
        await self._run(command, action.timeout)
        self._comparator_outputs = next_comparators

    async def read_port_b(self) -> dict[str, int]:
        """Read every configured Port B comparator result."""
        if not self.config.simulate:
            return await self.comparator_subtarget.read_inputs()

        if self.config.simulate:
            return {pin: int(self._comparator_outputs[pin]) for pin in self._read_pins}

        pins = self._read_pins
        output_pins = sorted(self._outputs)
        # In simulation, loading control-gpio replaces the prior applet, so
        # reassert Port A outputs while reading B.
        pin_declaration = output_pins + pins
        actions = [f"{pin}={int(self._outputs[pin])}" for pin in output_pins] + pins
        action = self.config.action("readData")
        command = action.action_data.command_format.format(
            self.config.device.voltage, ",".join(pin_declaration), " ".join(actions)
        )
        stdout = await self._run(command, action.timeout)
        values = {pin: int(value) for pin, value in GPIO_VALUE_RE.findall(stdout)}
        missing = [pin for pin in pins if pin not in values]
        if missing:
            raise RuntimeError(f"Glasgow GPIO response omitted pins: {', '.join(missing)}")
        return values

    async def close(self) -> None:
        await self.comparator_subtarget.close()

    def output_level(self, pin: str) -> bool:
        if self.config.simulate:
            return self._outputs.get(pin, False)
        return self.comparator_subtarget.output_level(pin)

    async def _run(self, command: str, timeout: float) -> str:
        # shlex + create_subprocess_exec preserves the existing JSON command
        # format without invoking a shell.
        argv = shlex.split(command)
        env = None
        if argv and argv[0] == "glasgow":
            # The shell's `glasgow` may be the newer API-6 installation.  Use
            # the same vendored API-5 CLI and firmware as the scan path.
            env = os.environ.copy()
            current_pythonpath = env.get("PYTHONPATH")
            env["PYTHONPATH"] = str(VENDORED_GLASGOW_ROOT) + (
                os.pathsep + current_pythonpath if current_pythonpath else ""
            )
            argv = [sys.executable, "-m", "glasgow.cli", *argv[1:]]
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError(f"Glasgow GPIO command timed out after {timeout:g}s")
        if process.returncode != 0:
            raw_detail = stderr.decode(errors="replace").strip()
            if raw_detail:
                # Glasgow's debug logger emits one line for every USB control
                # transfer. A failed command can therefore fill the UI error
                # panel with hundreds of redundant lines and hide the final
                # traceback. Keep the terminal error, summarize transfer
                # tracing, and retain the last lines where the root cause is.
                lines = raw_detail.splitlines()
                transfer_lines = [
                    line for line in lines
                    if "glasgow.hardware.device: USB: CONTROL " in line
                ]
                kept = [
                    line for line in lines
                    if "glasgow.hardware.device: USB: CONTROL " not in line
                ]
                if transfer_lines:
                    kept.insert(0, f"[suppressed {len(transfer_lines)} repetitive USB transfer log lines]")
                detail = "\n".join(kept[-120:])
            else:
                detail = f"exit {process.returncode}"
            raise RuntimeError(f"Glasgow GPIO command failed: {detail}")
        return stdout.decode(errors="replace")


class RealComparatorGPIOInterface(VacuumGPIOInterface):
    """Transport for physical IC comparator inputs.

    Port B is the comparator's digital output in this mode.  Use the same
    short-lived ``glasgow run control-gpio`` invocation as
    ``glasgowWriteDataApp.py``: drive mapped Port A outputs and sample Port B.
    This avoids keeping a second custom FPGA applet/demultiplexer alive.
    """

    async def write(self, pin: str, value: bool) -> None:
        if pin not in self._pump_by_write:
            raise ValueError(f"unknown vacuum output pin: {pin}")
        if self._outputs[pin] == value:
            return
        next_outputs = {**self._outputs, pin: value}
        action = self.config.action("writeData")
        output_pins = sorted(next_outputs)
        output_actions = " ".join(
            f"{output_pin}={int(next_outputs[output_pin])}" for output_pin in output_pins
        )
        command = action.action_data.command_format.format(
            self.config.device.voltage,
            ",".join(output_pins),
            output_actions,
        )
        await self._run(command, action.timeout)
        self._outputs[pin] = value

    async def read_port_b(self) -> dict[str, int]:
        pins = sorted(self._outputs) + self._read_pins
        actions = [f"{pin}={int(self._outputs[pin])}" for pin in sorted(self._outputs)] + self._read_pins
        action = self.config.action("readData")
        command = action.action_data.command_format.format(
            self.config.device.voltage,
            ",".join(pins),
            " ".join(actions),
        )
        stdout = await self._run(command, action.timeout)
        values = {pin: int(value) for pin, value in GPIO_VALUE_RE.findall(stdout)}
        missing = [pin for pin in self._read_pins if pin not in values]
        if missing:
            raise RuntimeError(f"Glasgow GPIO response omitted pins: {', '.join(missing)}")
        return values

    async def close(self) -> None:
        # Each control-gpio invocation owns and closes its own Glasgow device.
        return None

    def output_level(self, pin: str) -> bool:
        return self._outputs.get(pin, False)


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
                (pump.write for pump in config.pumps),
                (pump.read for pump in config.pumps),
                initial_outputs={
                    pump.write: pump.power.lower() == "on" for pump in config.pumps
                },
            )
        else:
            self.gpio = RealComparatorGPIOInterface(config)
        if config.simulate and not isinstance(self.gpio, SimulatedVacuumDeviceControl):
            raise TypeError(
                "simulation requires a device implementing write_comparator"
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
        self._simulation_reads = {pump.name: False for pump in config.pumps}

    @property
    def requires_device(self) -> bool:
        """Whether this controller owns the shared Glasgow USB device."""
        return not self.config.simulate

    @property
    def requires_remote_authority(self) -> bool:
        return isinstance(self._authority, RemoteExecutionAuthority)

    def accept_remote_authority(
        self, holder_id: str, fencing_token: int, valid_for: float
    ) -> ExecutionPermit:
        if not isinstance(self._authority, RemoteExecutionAuthority):
            raise RuntimeError("remote fencing is not enabled")
        return self._authority.accept(holder_id, fencing_token, valid_for)

    async def start(self) -> None:
        if self._running:
            return
        self._require_authority()
        self._running = True
        try:
            if self.config.simulate:
                self.gpio.reconnect()
            self._cascade_stopped = False
            for name, state in self._states.items():
                self._simulation_reads[name] = False
                state.simulation_read = False
                state.value = None
                state.port_b_value = 0.0
                state.ready = False
                if self.config.simulate:
                    async with self._io_lock:
                        await self.gpio.write_comparator(state.read, False)
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
                "glasgow-gpio" if self.config.simulate else "vacuum-control-subtarget"
            ),
            running=self._running,
            cascade_stopped=self._cascade_stopped,
            isVacuumSystemReady=self.isVacuumSystemReady,
            last_error=self._last_error,
            updated_at=self._updated_at,
            pumps=[state.model_copy() for state in self._states.values()],
        )

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
                    await self.gpio.write_comparator(state.read, False)
            state.power = power
            state.port_a_value = self.config.device.voltage if power else 0.0
            state.ready = False
            state.border = "waiting" if power else "off"
            state.port_b_value = 0.0
            if self.config.simulate:
                state.value = self._simulation_initial_value(state) if power else None
            elif not power:
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

    async def set_simulated_read(self, name: str, checked: bool) -> None:
        if not self.config.simulate:
            raise ValueError("simulated read controls are read-only on real hardware")
        state = self._states.get(name)
        if state is None:
            raise KeyError(name)
        self._simulation_reads[name] = checked
        state.simulation_read = checked
        if checked and state.power:
            # The simulation control represents the comparator's measured
            # input reaching its configured reference; it does not bypass the
            # comparator and force the digital output high.
            state.value = abs(state.threshold)
        elif name == MECHANICAL_PUMP and state.power:
            state.value = self._simulation_initial_value(state)
        if name == MECHANICAL_PUMP and checked:
            self._cascade_stopped = False
        if name != MECHANICAL_PUMP and not checked:
            await self.set_power(name, False)
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
            await self.gpio.write_comparator(mechanical.read, False)
        mechanical.simulation_read = False
        mechanical.value = self._simulation_initial_value(mechanical)
        mechanical.port_b_value = 0.0
        mechanical.ready = False
        mechanical.border = "waiting" if mechanical.power else "off"
        self._cascade_stopped = True

    async def poll_once(self) -> None:
        try:
            readings: dict[str, int] = {}
            if not self.config.simulate:
                async with self._io_lock:
                    readings = await self.gpio.read_port_b()
            for state in self._states.values():
                if self.config.simulate:
                    if state.power:
                        state.value = self._next_simulation_value(state)
                        comparator_output = self._comparator_matches(
                            state.value, state.threshold
                        )
                        async with self._io_lock:
                            await self.gpio.write_comparator(state.read, comparator_output)
                    else:
                        async with self._io_lock:
                            await self.gpio.write_comparator(state.read, False)
                        state.value = None
                else:
                    state.value = None
            if self.config.simulate:
                async with self._io_lock:
                    readings = await self.gpio.read_port_b()
            for state in self._states.values():
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
            if not self._cascade_stopped:
                await self._advance_cascade()
        except Exception as exc:
            self._last_error = str(exc)
            for state in self._states.values():
                state.port_b_value = 0.0
                state.ready = False
                if state.power:
                    state.border = "error"

    @staticmethod
    def _simulation_initial_value(state: VacuumPumpState) -> float:
        return 1.5 * abs(state.threshold)

    def _comparator_matches(self, measured: float, configured: float) -> bool:
        target = abs(configured)
        tolerance = target * self.config.error_range
        return abs(measured - target) <= tolerance

    def _next_simulation_value(self, state: VacuumPumpState) -> float:
        target = abs(state.threshold)
        current = state.value
        if current is None:
            return self._simulation_initial_value(state)
        step = abs(state.threshold) * self.SIMULATION_STEP_FRACTION
        return max(target, current - step)

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

    async def _poll_worker(self) -> None:
        while True:
            await self.poll_once()
            await asyncio.sleep(self.POLL_INTERVAL_SECONDS)

    def _require_authority(self) -> ExecutionPermit | None:
        """Return the live term permit, or preserve legacy single-node mode."""
        if self._authority is None:
            return None
        permit = self._authority.require()
        self._last_permit = permit
        return permit
