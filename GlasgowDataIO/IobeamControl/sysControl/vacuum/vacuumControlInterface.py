"""Host protocol for :class:`VacuumControlSubtarget`."""

import logging

from .vacuumControlSubtarget import VacuumControlSubtarget


class VacuumControlInterface:
    VALUE_SCALE = 1_000_000_000

    def __init__(self, interface, logger=None):
        self.lower = interface
        self._logger = logger or logging.getLogger(__name__)
        self._output_mask = 0

    async def set_outputs(self, mask: int) -> None:
        mask &= 0xFF
        await self.lower.write([VacuumControlSubtarget.Command.SetOutputs.value, mask])
        await self.lower.flush()
        self._output_mask = mask

    async def set_output(self, channel: int, enabled: bool) -> None:
        if channel not in range(8):
            raise IndexError("vacuum channel must be in the range 0..7")
        mask = self._output_mask
        if enabled:
            mask |= 1 << channel
        else:
            mask &= ~(1 << channel)
        await self.set_outputs(mask)

    @property
    def output_mask(self) -> int:
        return self._output_mask

    async def configure_target(
        self,
        channel: int,
        configured_value: float,
        error_range: float,
    ) -> None:
        if channel not in range(8):
            raise IndexError("vacuum channel must be in the range 0..7")
        target_code = round(abs(configured_value) * self.VALUE_SCALE)
        tolerance_code = round(abs(configured_value) * error_range * self.VALUE_SCALE)
        if not 0 <= target_code <= 0xFFFFFFFF or not 0 <= tolerance_code <= 0xFFFFFFFF:
            raise ValueError("vacuum comparator target is outside the fixed-point range")
        await self.lower.write([
            VacuumControlSubtarget.Command.ConfigureTarget.value,
            channel,
            *target_code.to_bytes(4, "little"),
            *tolerance_code.to_bytes(4, "little"),
        ])
        await self.lower.flush()

    async def read_status(self) -> tuple[int, int]:
        await self.lower.write([VacuumControlSubtarget.Command.ReadStatus.value])
        await self.lower.flush()
        response = bytes(await self.lower.read(3))
        if len(response) != 3:
            raise RuntimeError(f"vacuum sub-target returned {len(response)} status bytes; expected 3")
        tag, output_mask, input_mask = response
        if tag != VacuumControlSubtarget.STATUS_TAG:
            raise RuntimeError(f"vacuum sub-target returned invalid status tag 0x{tag:02x}")
        self._output_mask = output_mask
        return output_mask, input_mask

    async def close(self) -> None:
        device = self.lower.device
        try:
            await self.lower.cancel()
        finally:
            device.close()
