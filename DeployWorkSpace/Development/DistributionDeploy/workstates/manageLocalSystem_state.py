"""Install and start the complete local systemd-managed Ionbeam stack."""
import asyncio
import os
import shlex

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class manageLocalSystem_state(distributionDeploy_state):
    def __init__(self, parent):
        super(manageLocalSystem_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        if self.isProduction():
            self.info("[{}] production deployment: local five-service manager skipped"
                      .format(type(self).__name__))
            self._success = True
            return
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = self.resolvedActionData(stateConfig)
            command = str(actionData.get("operation", "restart")).strip()
            if command not in {"install", "start", "restart", "stop", "status"}:
                raise ValueError("unsupported local-system operation: {}".format(command))
            script = self.resolveDeployPath(
                actionData.get("script", "Scripts/manage-local-system.sh"))
            if not os.path.isfile(script):
                raise FileNotFoundError("local system manager not found: {}".format(script))
            os.chmod(script, os.stat(script).st_mode | 0o100)
            cmd = "{} {}".format(shlex.quote(script), shlex.quote(command))
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 300.0) or 300.0)
            self.info("[{}] >> {}".format(type(self).__name__, cmd))
            try:
                self._success = await asyncio.wait_for(
                    self.commandAsyncio(cmd, self.deployRoot(), verbose=True),
                    timeout=timeout)
            except asyncio.TimeoutError:
                self.error("[{}] timed out after {}s".format(type(self).__name__, timeout))
                self._success = False
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False
