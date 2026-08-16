"""Skip Raspberry Pi OS packages on the Windows deployment host."""
from buildingblocks.decorators import overrides

from .distributionDeploy_state import distributionDeploy_state


class installSbcGpioRuntime_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installSbcGpioRuntime_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        self.info(
            "[{}] Windows host: SBC GPIO operating-system packages are installed "
            "on the Raspberry Pi, not on this deployment machine."
            .format(type(self).__name__))
        self._success = True
