"""Configuration-driven multi-axis microscope stage controller."""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_CONFIG = (
    Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json" / "sampleStageSystem.json"
)


@dataclass(frozen=True)
class AxisConfig:
    name: str
    unit: str
    actuator: str
    driver: str
    continuous: bool
    resolution: float
    pins: dict[str, str]
    minimum: float
    maximum: float
    microsteps_per_unit: float
    invert_direction: bool
    spi_frequency_khz: int
    sck_idle: int
    sck_edge: str
    move_timeout_seconds: float
    poll_interval_seconds: float
    position_tolerance_microsteps: int
    register_writes: tuple[tuple[int, int], ...]


@dataclass(frozen=True)
class StageConfig:
    enabled: bool
    simulate: bool
    device_id: str
    voltage: float
    maximum_travel_mm: float
    state_path: Path
    axes: dict[str, AxisConfig]


def find_stage_config_path() -> Path:
    return Path(os.environ.get("SAMPLE_STAGE_CONFIG", DEFAULT_CONFIG)).expanduser().resolve()


def load_stage_config(path: Path | None = None) -> StageConfig:
    source = path or find_stage_config_path()
    raw = json.loads(source.read_text())
    maximum_travel_inches = float(
        raw.get("Safety", {}).get("maximumTravelInches", 15.0)
    )
    if maximum_travel_inches <= 0 or maximum_travel_inches > 15.0:
        raise ValueError("Safety.maximumTravelInches must be greater than 0 and no more than 15")
    maximum_travel_mm = maximum_travel_inches * 25.4
    axes = {}
    used_pins = set()
    raw_axes = raw.get("Axes", {})
    required_axes = tuple(raw.get("RequiredAxes", ("X", "Y")))
    for required in required_axes:
        if required not in raw_axes:
            raise ValueError(f"sample stage requires Axes.{required}")
    for name, item in raw_axes.items():
        if not isinstance(item, dict):
            raise ValueError(f"sample stage requires Axes.{name}")
        driver = str(item.get("driver", "TMC5160")).upper()
        pins = item.get("pins", {})
        if driver == "TMC5160":
            if set(pins) != {"sck", "cs", "sdi", "sdo"}:
                raise ValueError(f"Axes.{name}.pins requires sck, cs, sdi, and sdo")
            for pin in pins.values():
                if pin in used_pins:
                    raise ValueError(f"duplicate sample-stage pin: {pin}")
                used_pins.add(pin)
        elif pins:
            raise ValueError(f"Axes.{name}.pins is only valid for a local TMC5160 driver")
        minimum, maximum = float(item["minimum"]), float(item["maximum"])
        if minimum >= maximum:
            raise ValueError(f"Axes.{name} minimum must be below maximum")
        unit = str(item.get("unit", "mm"))
        travel_mm = (maximum - minimum) / 1000.0 if unit in {"um", "µm"} else maximum - minimum
        if unit in {"mm", "um", "µm"} and travel_mm > maximum_travel_mm:
            raise ValueError(
                f"Axes.{name} travel span exceeds {maximum_travel_inches:g} in "
                f"({maximum_travel_mm:g} mm)"
            )
        spi = item.get("spi", {})
        motion = item.get("motion", {})
        raw_registers = item.get("registerWrites", {}) if driver == "TMC5160" else {}
        if not isinstance(raw_registers, dict):
            raise ValueError(f"Axes.{name}.registerWrites must be an object")
        register_writes = []
        if raw_registers:
            from GlasgowDataIO.IobeamControl.sysControl.stepper.tmc5160Interface import REGISTER_NAMES
            for register, value in raw_registers.items():
                address = REGISTER_NAMES.get(str(register).upper())
                if address is None:
                    address = int(str(register), 0)
                register_writes.append((address, int(str(value), 0) if isinstance(value, str) else int(value)))
        axes[name] = AxisConfig(
            name=name,
            unit=unit,
            actuator=str(item.get("actuator", "stepper")),
            driver=driver,
            continuous=bool(item.get("continuous", False)),
            resolution=(
                float(item["resolutionMicrometers"]) / 1000.0
                if unit == "mm" and "resolutionMicrometers" in item
                else float(item.get("resolution", 1.0 / float(item["microstepsPerUnit"])))
            ),
            pins=dict(pins),
            minimum=minimum,
            maximum=maximum,
            microsteps_per_unit=float(item["microstepsPerUnit"]),
            invert_direction=bool(item.get("invertDirection", False)),
            spi_frequency_khz=int(spi.get("frequencyKHz", 500)),
            sck_idle=int(spi.get("sckIdle", 0)),
            sck_edge=str(spi.get("sckEdge", "rising")),
            move_timeout_seconds=float(motion.get("timeoutSeconds", 30.0)),
            poll_interval_seconds=float(motion.get("pollIntervalMs", 25.0)) / 1000.0,
            position_tolerance_microsteps=int(motion.get("positionToleranceMicrosteps", 1)),
            register_writes=tuple(register_writes),
        )
        axis = axes[name]
        if axis.microsteps_per_unit <= 0:
            raise ValueError(f"Axes.{name} scale must be positive")
        if axis.resolution <= 0:
            raise ValueError(f"Axes.{name} resolution must be positive")
        if axis.driver == "TMC5160" and axis.spi_frequency_khz < 1:
            raise ValueError(f"Axes.{name} SPI frequency must be positive")
        if axis.driver == "TMC5160" and (axis.sck_idle != 0 or axis.sck_edge not in {"r", "rising"}):
            raise ValueError(f"Axes.{name} TMC5160 SPI requires sckIdle=0 and sckEdge=rising")
        if axis.move_timeout_seconds <= 0 or axis.poll_interval_seconds <= 0:
            raise ValueError(f"Axes.{name} motion polling values must be positive")
    device = raw.get("Glasgow", {}).get("Device1", {})
    config = StageConfig(
        enabled=raw.get("Enable") is True,
        simulate=raw.get("Simulate") is True,
        device_id=str(device.get("Id", "")).strip(),
        voltage=float(device.get("voltage", 3.3)),
        maximum_travel_mm=maximum_travel_mm,
        state_path=Path(
            os.environ.get(
                "SAMPLE_STAGE_STATE",
                raw.get("Persistence", {}).get("stateFile", source.with_suffix(".state.json")),
            )
        ).expanduser().resolve(),
        axes=axes,
    )
    if config.enabled and not config.simulate and not config.device_id:
        raise ValueError("Glasgow.Device1.Id is required when Simulate=false")
    return config


class SampleStageController:
    def __init__(self, config: StageConfig):
        self.config = config
        self.position = {name: 0.0 for name in config.axes}
        self.connected = config.simulate
        self.moving = False
        self.last_error = None
        self.diagnostics = {name: None for name in config.axes}
        self._device = None
        self._interfaces = None
        self._lock = asyncio.Lock()
        if config.simulate:
            self._restore_position()

    def _restore_position(self):
        """Restore only valid coordinates; never command motion during restore."""
        try:
            saved = json.loads(self.config.state_path.read_text())
        except FileNotFoundError:
            return
        except (OSError, ValueError, TypeError):
            return
        values = saved.get("position", saved) if isinstance(saved, dict) else {}
        saved_units = saved.get("units", {}) if isinstance(saved, dict) else {}
        legacy_millimeters = isinstance(saved, dict) and saved.get("version", 1) < 2
        if not isinstance(values, dict):
            return
        for name, axis in self.config.axes.items():
            raw_value = values.get(name.lower(), values.get(name))
            if raw_value is None:
                continue
            try:
                value = float(raw_value)
            except (TypeError, ValueError):
                continue
            saved_unit = saved_units.get(name.lower()) if isinstance(saved_units, dict) else None
            if axis.unit in {"um", "µm"} and (saved_unit == "mm" or (saved_unit is None and legacy_millimeters)):
                value *= 1000.0
            if axis.continuous or axis.minimum <= value <= axis.maximum:
                self.position[name] = value

    def _persist_position(self):
        """Atomically save the last verified position for the next process."""
        self.config.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.config.state_path.with_suffix(self.config.state_path.suffix + ".tmp")
        temporary.write_text(json.dumps({
            "version": 2,
            "position": {name.lower(): value for name, value in self.position.items()},
            "units": {name.lower(): axis.unit for name, axis in self.config.axes.items()},
        }, indent=2) + "\n")
        temporary.replace(self.config.state_path)

    async def start(self):
        if self.config.simulate:
            self.connected = True
            return
        from GlasgowDataIO.IobeamControl.sysControl.stepper.sampleStageLauncher import SampleStageLauncher
        axes = {
            name: {
                "pins": axis.pins,
                "spiFrequencyKHz": axis.spi_frequency_khz,
                "sckIdle": axis.sck_idle,
                "sckEdge": axis.sck_edge,
            }
            for name, axis in self.config.axes.items()
            if axis.driver == "TMC5160"
        }
        unsupported = [name for name, axis in self.config.axes.items() if axis.driver != "TMC5160"]
        if unsupported:
            raise RuntimeError(
                "non-simulated external stage drivers are not configured: " + ", ".join(unsupported)
            )
        self._device, self._interfaces = await SampleStageLauncher(
            self.config.device_id, self.config.voltage, axes
        ).start()
        for name, interface in self._interfaces.items():
            await interface.initialize(self.config.axes[name].register_writes)
            microsteps = await interface.read_position()
            self.position[name] = microsteps / self.config.axes[name].microsteps_per_unit
        self._persist_position()
        self.connected = True

    async def move_absolute(self, targets: dict[str, float]):
        async with self._lock:
            moves = []
            for name in self.config.axes:
                target = float(targets.get(name.lower(), targets.get(name, self.position[name])))
                axis = self.config.axes[name]
                if not axis.continuous and not axis.minimum <= target <= axis.maximum:
                    raise ValueError(f"{name} target {target} outside [{axis.minimum}, {axis.maximum}]")
                moves.append((name, target, target - self.position[name]))
            self.moving = True
            try:
                if not self.config.simulate:
                    if not self._interfaces:
                        raise RuntimeError("sample-stage Glasgow is not connected")
                    for name, target, _delta in moves:
                        axis = self.config.axes[name]
                        iface = self._interfaces[name]
                        target_microsteps = round(target * axis.microsteps_per_unit)
                        if axis.invert_direction:
                            target_microsteps = -target_microsteps
                        await iface.move_to(target_microsteps)
                    await asyncio.gather(*(self._wait_for_axis(name, target) for name, target, _ in moves))
                else:
                    for name, target, _delta in moves:
                        self.position[name] = target
                self._persist_position()
                self.last_error = None
            except Exception as exc:
                self.last_error = str(exc)
                raise
            finally:
                self.moving = False
        return self.status()

    async def _wait_for_axis(self, name: str, target: float):
        axis = self.config.axes[name]
        iface = self._interfaces[name]
        target_microsteps = round(target * axis.microsteps_per_unit)
        if axis.invert_direction:
            target_microsteps = -target_microsteps
        deadline = asyncio.get_running_loop().time() + axis.move_timeout_seconds
        while True:
            actual = await iface.read_position()
            diagnostics = await iface.read_motion_status()
            self.diagnostics[name] = diagnostics
            physical_actual = -actual if axis.invert_direction else actual
            self.position[name] = physical_actual / axis.microsteps_per_unit
            if diagnostics["driver_error"]:
                raise RuntimeError(f"{name} TMC5160 driver error")
            if abs(actual - target_microsteps) <= axis.position_tolerance_microsteps:
                return
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeError(f"{name} move timed out at {actual} microsteps")
            await asyncio.sleep(axis.poll_interval_seconds)

    def status(self):
        return {
            "enabled": self.config.enabled,
            "connected": self.connected,
            "simulation": self.config.simulate,
            "device_id": self.config.device_id,
            "position": {k.lower(): v for k, v in self.position.items()},
            "limits": {
                k.lower(): {"minimum": v.minimum, "maximum": v.maximum}
                for k, v in self.config.axes.items()
            },
            "axes": {
                k.lower(): {
                    "unit": v.unit,
                    "actuator": v.actuator,
                    "driver": v.driver,
                    "continuous": v.continuous,
                    "resolution": v.resolution,
                    "resolution_micrometers": (
                        v.resolution * 1000.0 if v.unit == "mm"
                        else v.resolution if v.unit in {"um", "µm"}
                        else None
                    ),
                }
                for k, v in self.config.axes.items()
            },
            "maximum_travel_mm": self.config.maximum_travel_mm,
            "position_persisted": self.config.state_path.exists(),
            "moving": self.moving,
            "diagnostics": {k.lower(): v for k, v in self.diagnostics.items()},
            "last_error": self.last_error,
        }

    async def refresh_status(self):
        """Read XACTUAL and diagnostics so every GET reports hardware state."""
        if self.config.simulate or not self._interfaces:
            return self.status()
        async with self._lock:
            for name, interface in self._interfaces.items():
                axis = self.config.axes[name]
                actual = await interface.read_position()
                self.diagnostics[name] = await interface.read_motion_status()
                physical_actual = -actual if axis.invert_direction else actual
                self.position[name] = physical_actual / axis.microsteps_per_unit
        return self.status()

    async def close(self):
        if self._interfaces:
            for iface in self._interfaces.values():
                await iface.write_register(0x20, 3)
        if self._device:
            self._device.close()
        self.connected = False
