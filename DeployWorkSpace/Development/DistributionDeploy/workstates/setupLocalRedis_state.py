"""Install the single-host Redis/Sentinel topology used by local deployments."""
import asyncio
import os
import shlex

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
                "script", "Development/glasgow_service/deploy/setup-redis-sentinel.sh"))
            if not os.path.isfile(script):
                raise FileNotFoundError("Redis setup script not found: {}".format(script))
            cmd = "bash {}".format(shlex.quote(script))
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 600.0) or 600.0)
            try:
                self._success = await asyncio.wait_for(
                    self.commandAsyncio(cmd, self.deployRoot(), verbose=True), timeout=timeout)
            except asyncio.TimeoutError:
                self.error("[{}] timed out after {}s".format(type(self).__name__, timeout))
                self._success = False
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False
