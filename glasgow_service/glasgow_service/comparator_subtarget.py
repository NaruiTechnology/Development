"""Service transport for the Glasgow vacuum-control sub-target."""
from dataclasses import dataclass
from typing import Any, Callable, Optional


@dataclass(frozen=True)
class ComparatorTarget:
    equipment: str
    source_pin: str
    result_pin: str
    configured_value: float
    error_range: float
    high_voltage: float
    enabled: bool


class VacuumComparatorSubtarget:
    """Lazy connection to the FPGA target plus its configured target mirror."""

    def __init__(
        self,
        device_id: str,
        voltage: float,
        pumps: list[Any],
        launcher_factory: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.device_id = device_id
        self.voltage = voltage
        self._pumps = list(pumps)
        self._channel_by_source = {
            pump.write: index for index, pump in enumerate(self._pumps)
        }
        self._result_by_channel = {
            index: pump.read for index, pump in enumerate(self._pumps)
        }
        self._launcher_factory = launcher_factory
        self._interface = None
        self._targets: dict[str, ComparatorTarget] = {}
        self._output_levels = {pump.write: False for pump in self._pumps}

    async def _connect(self):
        if self._interface is not None:
            return self._interface
        if self._launcher_factory is None:
            try:
                from GlasgowDataIO.IobeamControl.sysControl.vacuum.vacuumControlLauncher import (
                    VacuumControlLauncher,
                )
            except ModuleNotFoundError:
                # The GlasgowDataIO test suite places that package itself on
                # sys.path, where IobeamControl is the import root.
                from IobeamControl.sysControl.vacuum.vacuumControlLauncher import (
                    VacuumControlLauncher,
                )
            launcher_factory = VacuumControlLauncher
        else:
            launcher_factory = self._launcher_factory
        launcher = launcher_factory(
            self.device_id,
            self.voltage,
            [pump.write for pump in self._pumps],
            [pump.read for pump in self._pumps],
        )
        self._interface = await launcher.start()
        return self._interface

    async def write_target(self, target: ComparatorTarget) -> None:
        channel = self._channel_by_source.get(target.source_pin)
        if channel is None:
            raise ValueError(f"unknown comparator source pin: {target.source_pin}")
        interface = await self._connect()
        await interface.configure_target(
            channel,
            target.configured_value,
            target.error_range,
        )
        await interface.set_output(channel, target.enabled)
        self._targets[target.source_pin] = target

    async def write_output(self, source_pin: str, enabled: bool) -> None:
        """Drive a mapped real comparator output without simulation targets."""
        channel = self._channel_by_source.get(source_pin)
        if channel is None:
            raise ValueError(f"unknown comparator source pin: {source_pin}")
        interface = await self._connect()
        await interface.set_output(channel, enabled)
        self._output_levels[source_pin] = enabled

    async def read_inputs(self) -> dict[str, int]:
        interface = await self._connect()
        output_mask, input_mask = await interface.read_status()
        self._output_levels = {
            pump.write: bool(output_mask & (1 << channel))
            for channel, pump in enumerate(self._pumps)
        }
        return {
            pin: int(bool(input_mask & (1 << channel)))
            for channel, pin in self._result_by_channel.items()
        }

    def output_level(self, source_pin: str) -> bool:
        return self._output_levels.get(source_pin, False)

    async def close(self) -> None:
        if self._interface is None:
            return
        interface, self._interface = self._interface, None
        await interface.close()

    def target_for(self, source_pin: str) -> ComparatorTarget | None:
        return self._targets.get(source_pin)

    def targets(self) -> tuple[ComparatorTarget, ...]:
        return tuple(self._targets[pin] for pin in sorted(self._targets))
