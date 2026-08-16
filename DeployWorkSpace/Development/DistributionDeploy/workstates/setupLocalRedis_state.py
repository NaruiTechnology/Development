

"""Create the Windows local Redis/Sentinel topology with PowerShell."""
import asyncio
import os

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class setupLocalRedis_state(distributionDeploy_state):
    def __init__(self, parent):
        super(setupLocalRedis_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        if self.isProduction():
            self.info("[{}] production deployment: external Redis/Sentinel is required"
                      .format(type(self).__name__))
            self._success = True
            return
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = self.resolvedActionData(stateConfig)
            script = self.resolveDeployPath(actionData.get(
                "script", r"glasgow_service\deploy\setup-redis-sentinel.ps1"))
            if not os.path.isfile(script):
                raise FileNotFoundError("Redis setup script not found: {}".format(script))
            command = (
                'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{}"'
                .format(script.replace('"', '""')))
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 600.0) or 600.0)
            self.info("[{}] >> {}".format(type(self).__name__, command))
            try:
                self._success = await asyncio.wait_for(
                    self.commandAsyncio(command, self.deployRoot(), verbose=True),
                    timeout=timeout)
            except asyncio.TimeoutError:
                self.error("[{}] timed out after {}s".format(type(self).__name__, timeout))
                self._success = False
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False
