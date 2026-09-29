from amaranth import *
import logging

from .controlStepperSubtarget import ControlStepperSubtarget

class ControlStepperInterface:
    def __init__(self, interface, logger):
        self.lower   = interface
        self._logger = logger
        self._level  = logging.DEBUG if self._logger.name == __name__ else logging.INFO

    def _log(self, message, *args):
        self._logger.log(self._level, "stepper: " + message, *args)

    async def enable(self, is_enabled=True):
        if is_enabled:
            self._log("enable")
            await self.lower.write([ControlStepperSubtarget.Command.Enable.value])
        else:
            self._log("disable")
            await self.lower.write([ControlStepperSubtarget.Command.Disable.value])
        await self.lower.flush()

    async def disable(self):
        await self.enable(False)

    async def set_direction(self, direction: int):
        self._log(f"dir={direction}")
        await self.lower.write([
            ControlStepperSubtarget.Command.SetDirection.value,
            direction & 0x01
        ])
        await self.lower.flush()

    async def set_period_us(self, period_us: int):
        """Microseconds per step (>=1). Smaller = faster."""
        assert period_us >= 1
        self._log(f"period_us={period_us}")
        await self.lower.write([
            ControlStepperSubtarget.Command.SetPeriodUS.value,
            *int(period_us).to_bytes(2, "little")
        ])
        await self.lower.flush()

    async def run_steps(self, steps: int):
        """Execute a finite number of steps."""
        assert 0 <= steps <= 0xFFFFFFFF
        self._log(f"run_steps={steps}")
        await self.lower.write([
            ControlStepperSubtarget.Command.RunSteps.value,
            *int(steps).to_bytes(4, "little")
        ])
        await self.lower.flush()
        # enable is forced inside the gateware for this command

    async def run_continuous(self, is_running: bool = True):
        """Start/stop continuous stepping."""
        self._log(f"run_continuous={is_running}")
        await self.lower.write([
            ControlStepperSubtarget.Command.RunContinuous.value,
            1 if is_running else 0
        ])
        await self.lower.flush()
        # enable is forced inside the gateware for this command