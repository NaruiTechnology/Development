"""Configuration-driven two-axis stage controller for a dedicated Glasgow."""
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
    pins: dict[str, str]
    minimum: float
    maximum: float
    steps_per_unit: float
    period_us: int
    pulse_high_us: int
    invert_direction: bool


@dataclass(frozen=True)
class StageConfig:
    enabled: bool
    simulate: bool
    device_id: str
    voltage: float
    maximum_travel_mm: float
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
    for name in ("X", "Y"):
        item = raw.get("Axes", {}).get(name)
        if not isinstance(item, dict):
            raise ValueError(f"sample stage requires Axes.{name}")
        pins = item.get("pins", {})
        if set(pins) != {"step", "dir", "en"}:
            raise ValueError(f"Axes.{name}.pins requires step, dir, and en")
        for pin in pins.values():
            if pin in used_pins:
                raise ValueError(f"duplicate sample-stage pin: {pin}")
            used_pins.add(pin)
        minimum, maximum = float(item["minimum"]), float(item["maximum"])
        if minimum >= maximum:
            raise ValueError(f"Axes.{name} minimum must be below maximum")
        if maximum - minimum > maximum_travel_mm:
            raise ValueError(
                f"Axes.{name} travel span exceeds {maximum_travel_inches:g} in "
                f"({maximum_travel_mm:g} mm)"
            )
        axes[name] = AxisConfig(
            name=name,
            pins=dict(pins),
            minimum=minimum,
            maximum=maximum,
            steps_per_unit=float(item["stepsPerUnit"]),
            period_us=int(item["periodUs"]),
            pulse_high_us=int(item["pulseHighUs"]),
            invert_direction=bool(item.get("invertDirection", False)),
        )
        if axes[name].steps_per_unit <= 0 or axes[name].period_us < 1:
            raise ValueError(f"Axes.{name} timing and scale must be positive")
    device = raw.get("Glasgow", {}).get("Device1", {})
    config = StageConfig(
        enabled=raw.get("Enable") is True,
        simulate=raw.get("Simulate") is True,
        device_id=str(device.get("Id", "")).strip(),
        voltage=float(device.get("voltage", 3.3)),
        maximum_travel_mm=maximum_travel_mm,
        axes=axes,
    )
    if config.enabled and not config.simulate and not config.device_id:
        raise ValueError("Glasgow.Device1.Id is required when Simulate=false")
    return config


class SampleStageController:
    def __init__(self, config: StageConfig):
        self.config = config
        self.position = {"X": 0.0, "Y": 0.0}
        self.connected = config.simulate
        self.moving = False
        self.last_error = None
        self._device = None
        self._interfaces = None
        self._lock = asyncio.Lock()

    async def start(self):
        if self.config.simulate:
            self.connected = True
            return
        from GlasgowDataIO.IobeamControl.sysControl.stepper.sampleStageLauncher import SampleStageLauncher
        axes = {
            name: {
                "pins": axis.pins,
                "pulseHighUs": axis.pulse_high_us,
            }
            for name, axis in self.config.axes.items()
        }
        self._device, self._interfaces = await SampleStageLauncher(
            self.config.device_id, self.config.voltage, axes
        ).start()
        self.connected = True

    async def move_absolute(self, targets: dict[str, float]):
        async with self._lock:
            moves = []
            for name in ("X", "Y"):
                target = float(targets.get(name.lower(), targets.get(name, self.position[name])))
                axis = self.config.axes[name]
                if not axis.minimum <= target <= axis.maximum:
                    raise ValueError(f"{name} target {target} outside [{axis.minimum}, {axis.maximum}]")
                moves.append((name, target, target - self.position[name]))
            self.moving = True
            try:
                if not self.config.simulate:
                    if not self._interfaces:
                        raise RuntimeError("sample-stage Glasgow is not connected")
                    for name, _target, delta in moves:
                        if delta == 0:
                            continue
                        axis = self.config.axes[name]
                        iface = self._interfaces[name]
                        direction = (delta > 0) != axis.invert_direction
                        await iface.set_period_us(axis.period_us)
                        await iface.set_direction(int(direction))
                        await iface.run_steps(round(abs(delta) * axis.steps_per_unit))
                for name, target, _delta in moves:
                    self.position[name] = target
                self.last_error = None
            except Exception as exc:
                self.last_error = str(exc)
                raise
            finally:
                self.moving = False
        return self.status()

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
            "maximum_travel_mm": self.config.maximum_travel_mm,
            "moving": self.moving,
            "last_error": self.last_error,
        }

    async def close(self):
        if self._interfaces:
            for iface in self._interfaces.values():
                await iface.disable()
        if self._device:
            self._device.close()
        self.connected = False
