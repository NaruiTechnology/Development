"""Hardware-neutral device boundary for the continuous vacuum controller.

The controller depends on :class:`VacuumDevice`, not on transport-specific
implementation details.  The deterministic simulator is deliberately small:
it models digital output and comparator input levels while the controller owns
the vacuum-pressure/cascade model.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol, runtime_checkable


@runtime_checkable
class VacuumDevice(Protocol):
    """Minimum device operations required by ``VacuumController``."""

    async def write(self, pin: str, value: bool) -> None: ...

    async def read_port_b(self) -> dict[str, int]: ...

    def output_level(self, pin: str) -> bool: ...

    async def close(self) -> None: ...


@runtime_checkable
class SimulatedVacuumDeviceControl(Protocol):
    """Extra control surface used only by the deterministic plant model."""

    async def write_comparator(self, pin: str, value: bool) -> None: ...

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
    ) -> None:
        self._outputs = {pin: False for pin in output_pins}
        self._outputs.update(initial_outputs or {})
        self._inputs = {pin: False for pin in input_pins}
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
        if operation not in {"write", "read", "write_comparator", "close"}:
            raise ValueError(f"unknown simulated operation: {operation}")
        self._next_failure[operation] = error or RuntimeError(
            f"simulated {operation} failure"
        )

    async def write(self, pin: str, value: bool) -> None:
        self._check("write")
        if pin not in self._outputs:
            raise ValueError(f"unknown vacuum output pin: {pin}")
        self._outputs[pin] = bool(value)
        self.history.append(("write", pin, bool(value)))

    async def write_comparator(self, pin: str, value: bool) -> None:
        self._check("write_comparator")
        if pin not in self._inputs:
            raise ValueError(f"unknown comparator output pin: {pin}")
        self._inputs[pin] = bool(value)
        self.history.append(("write_comparator", pin, bool(value)))

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

    async def write(self, pin: str, value: bool) -> None:
        try:
            self._outputs[pin].value = bool(value)
        except KeyError as exc:
            raise ValueError(f"unknown vacuum output pin: {pin}") from exc

    async def read_port_b(self) -> dict[str, int]:
        return {name: int(device.value) for name, device in self._inputs.items()}

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
