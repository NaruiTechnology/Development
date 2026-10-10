"""Hardware-neutral device boundary for the continuous vacuum controller.

The controller depends on :class:`VacuumDevice`, not on transport-specific
implementation details.  The deterministic simulator is deliberately small:
it models digital output and comparator input levels while the controller owns
the vacuum-pressure/cascade model.
"""
from __future__ import annotations

import inspect
import math
from collections.abc import Awaitable, Callable, Iterable, Mapping
from typing import Protocol, runtime_checkable


@runtime_checkable
class VacuumDevice(Protocol):
    """Minimum device operations required by ``VacuumController``."""

    async def write(self, pin: str, value: bool) -> None: ...

    async def read_port_b(self) -> dict[str, int]: ...

    async def read_gauge_values(self) -> dict[str, float | None]: ...

    def output_level(self, pin: str) -> bool: ...

    async def close(self) -> None: ...


@runtime_checkable
class SimulatedVacuumDeviceControl(Protocol):
    """Extra control surface used only by the deterministic plant model."""

    async def set_gauge_ready(self, pin: str, ready: bool) -> None: ...

    async def set_gauge_excursion(self, pin: str, pressure_mbar: float | None) -> None: ...

    def reconnect(self) -> None: ...


class SimulatedVacuumDevice:
    """Deterministic in-memory implementation with explicit fault injection.

    No wall-clock sleeps or random values are used, so a test advances only
    when it invokes the controller.  ``fail_next`` affects one matching device
    operation and then automatically clears.
    """

    def __init__(
        self,
        output_pins: Iterable[str],
        input_pins: Iterable[str],
        *,
        initial_outputs: dict[str, bool] | None = None,
        gauge_channels: Mapping[str, tuple[str, float]] | None = None,
        error_range: float = 0.0,
        simulation_step_fraction: float = 0.02,
    ) -> None:
        self._outputs = {pin: False for pin in output_pins}
        self._outputs.update(initial_outputs or {})
        self._inputs = {pin: False for pin in input_pins}
        self._gauge_channels = dict(gauge_channels or {})
        self._gauge_values: dict[str, float | None] = {
            pin: None for pin in self._gauge_channels
        }
        self._gauge_overrides: dict[str, float | None] = {
            pin: None for pin in self._gauge_channels
        }
        self._forced_ready = {pin: False for pin in self._gauge_channels}
        self._error_range = error_range
        self._simulation_step_fraction = simulation_step_fraction
        self._connected = True
        self._closed = False
        self._next_failure: dict[str, BaseException] = {}
        self.history: list[tuple[str, str | None, bool | None]] = []

    @property
    def connected(self) -> bool:
        return self._connected and not self._closed

    def disconnect(self) -> None:
        self._connected = False

    def reconnect(self) -> None:
        self._closed = False
        self._connected = True

    def fail_next(self, operation: str, error: BaseException | None = None) -> None:
        if operation not in {"write", "read", "set_gauge_ready", "set_gauge_excursion", "close"}:
            raise ValueError(f"unknown simulated operation: {operation}")
        self._next_failure[operation] = error or RuntimeError(
            f"simulated {operation} failure"
        )

    async def write(self, pin: str, value: bool) -> None:
        self._check("write")
        if pin not in self._outputs:
            raise ValueError(f"unknown vacuum output pin: {pin}")
        self._outputs[pin] = bool(value)
        for read_pin, (write_pin, threshold) in self._gauge_channels.items():
            if write_pin != pin:
                continue
            if value:
                if self._gauge_values[read_pin] is None:
                    self._gauge_values[read_pin] = 1.5 * abs(threshold)
            else:
                self._gauge_values[read_pin] = None
                self._gauge_overrides[read_pin] = None
                self._forced_ready[read_pin] = False
                self._inputs[read_pin] = False
        self.history.append(("write", pin, bool(value)))

    async def set_gauge_ready(self, pin: str, ready: bool) -> None:
        self._check("set_gauge_ready")
        if pin not in self._gauge_channels:
            raise ValueError(f"unknown simulated gauge pin: {pin}")
        self._gauge_overrides[pin] = None
        self._forced_ready[pin] = bool(ready)
        _write_pin, threshold = self._gauge_channels[pin]
        self._gauge_values[pin] = (
            abs(threshold) if ready else 1.5 * abs(threshold)
        )
        self._inputs[pin] = bool(ready)
        self.history.append(("set_gauge_ready", pin, bool(ready)))

    async def set_gauge_excursion(self, pin: str, pressure_mbar: float | None) -> None:
        """Hold a simulated gauge above threshold while its ready input stays on.

        Passing ``None`` releases the excursion and restores the configured
        threshold, modeling a recovered gauge without changing pump power.
        """
        self._check("set_gauge_excursion")
        if pin not in self._gauge_channels:
            raise ValueError(f"unknown simulated gauge pin: {pin}")
        _write_pin, threshold = self._gauge_channels[pin]
        if pressure_mbar is not None and (not math.isfinite(pressure_mbar) or pressure_mbar < 0):
            raise ValueError("simulated pressure must be finite and non-negative")
        self._forced_ready[pin] = True
        self._gauge_overrides[pin] = (
            None if pressure_mbar is None else float(pressure_mbar)
        )
        self._gauge_values[pin] = (
            abs(threshold) if pressure_mbar is None else float(pressure_mbar)
        )
        self._inputs[pin] = True
        self.history.append(("set_gauge_excursion", pin, pressure_mbar is not None))

    async def read_gauge_values(self) -> dict[str, float | None]:
        self._check("read")
        readings: dict[str, float | None] = {}
        for read_pin, (write_pin, threshold) in self._gauge_channels.items():
            if not self._outputs[write_pin]:
                value = None
            elif self._gauge_overrides[read_pin] is not None:
                value = self._gauge_overrides[read_pin]
            elif self._forced_ready[read_pin]:
                value = abs(threshold)
            else:
                current = self._gauge_values[read_pin]
                if current is None:
                    value = 1.5 * abs(threshold)
                else:
                    step = abs(threshold) * self._simulation_step_fraction
                    value = max(abs(threshold), current - step)
            self._gauge_values[read_pin] = value
            readings[read_pin] = value
            if self._gauge_overrides[read_pin] is not None:
                self._inputs[read_pin] = self._forced_ready[read_pin]
            else:
                tolerance = abs(threshold) * self._error_range
                self._inputs[read_pin] = (
                    value is not None and abs(value - abs(threshold)) <= tolerance
                )
        self.history.append(("read_gauges", None, None))
        return readings

    async def read_port_b(self) -> dict[str, int]:
        self._check("read")
        self.history.append(("read", None, None))
        return {pin: int(value) for pin, value in self._inputs.items()}

    def output_level(self, pin: str) -> bool:
        if pin not in self._outputs:
            raise ValueError(f"unknown vacuum output pin: {pin}")
        return self._outputs[pin]

    async def close(self) -> None:
        self._check("close", require_connected=False)
        self._closed = True
        self._connected = False
        self.history.append(("close", None, None))

    def _check(self, operation: str, *, require_connected: bool = True) -> None:
        failure = self._next_failure.pop(operation, None)
        if failure is not None:
            raise failure
        if self._closed:
            raise RuntimeError("simulated vacuum device is closed")
        if require_connected and not self._connected:
            raise ConnectionError("simulated vacuum device is disconnected")


class RaspberryPiGPIODevice:
    """Map logical vacuum channels to Raspberry Pi BCM GPIO lines.

    ``gpio_factory`` is injectable for tests. Production uses gpiozero with
    the lgpio pin factory, the supported character-device path on current
    Raspberry Pi OS releases.
    """

    def __init__(
        self,
        output_pins: dict[str, int],
        input_pins: dict[str, int],
        *,
        initial_outputs: dict[str, bool] | None = None,
        active_high: bool = True,
        input_pull_up: bool | None = None,
        gauge_reader: Callable[
            [], Mapping[str, float | None] | Awaitable[Mapping[str, float | None]]
        ] | None = None,
        gpio_factory=None,
    ) -> None:
        all_bcm = [*output_pins.values(), *input_pins.values()]
        if len(set(all_bcm)) != len(all_bcm):
            raise ValueError("SBC BCM GPIO assignments must be unique")
        if any(not 0 <= pin <= 27 for pin in all_bcm):
            raise ValueError("SBC BCM GPIO numbers must be between 0 and 27")
        if gpio_factory is None:
            try:
                from gpiozero import DigitalInputDevice, DigitalOutputDevice
                from gpiozero.pins.lgpio import LGPIOFactory
            except ImportError as exc:
                raise RuntimeError(
                    "Raspberry Pi GPIO requires gpiozero and python3-lgpio"
                ) from exc
            pin_factory = LGPIOFactory()

            def gpio_factory(kind, bcm, **kwargs):
                cls = DigitalOutputDevice if kind == "output" else DigitalInputDevice
                return cls(bcm, pin_factory=pin_factory, **kwargs)

        initial_outputs = initial_outputs or {}
        self._outputs = {
            name: gpio_factory(
                "output",
                bcm,
                active_high=active_high,
                initial_value=bool(initial_outputs.get(name, False)),
            )
            for name, bcm in output_pins.items()
        }
        self._inputs = {
            name: gpio_factory("input", bcm, pull_up=input_pull_up)
            for name, bcm in input_pins.items()
        }
        self._gauge_reader = gauge_reader

    async def write(self, pin: str, value: bool) -> None:
        try:
            self._outputs[pin].value = bool(value)
        except KeyError as exc:
            raise ValueError(f"unknown vacuum output pin: {pin}") from exc

    async def read_port_b(self) -> dict[str, int]:
        return {name: int(device.value) for name, device in self._inputs.items()}

    async def read_gauge_values(self) -> dict[str, float | None]:
        """Read numeric gauges through an injected SBC hardware adapter.

        GPIO comparator inputs remain usable when no analog/serial gauge
        adapter is configured; in that case every channel has an unknown
        numeric value.
        """
        if self._gauge_reader is None:
            return {name: None for name in self._inputs}
        result = self._gauge_reader()
        if inspect.isawaitable(result):
            result = await result
        unknown = set(result) - set(self._inputs)
        if unknown:
            channels = ", ".join(sorted(unknown))
            raise ValueError(f"gauge reader returned unknown channels: {channels}")
        readings = {name: result.get(name) for name in self._inputs}
        for name, value in readings.items():
            if value is not None and (
                not isinstance(value, (int, float)) or not math.isfinite(value)
            ):
                raise ValueError(f"gauge reader returned invalid value for {name}")
        return {
            name: None if value is None else float(value)
            for name, value in readings.items()
        }

    def output_level(self, pin: str) -> bool:
        try:
            # Read the GPIO line through the driver, not controller cache.
            return bool(self._outputs[pin].value)
        except KeyError as exc:
            raise ValueError(f"unknown vacuum output pin: {pin}") from exc

    async def close(self) -> None:
        # A leadership loss must put outputs in their safe state immediately.
        # Keep line handles open so a later leadership term can reacquire.
        for output in self._outputs.values():
            output.off()
