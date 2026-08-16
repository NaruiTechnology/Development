"""Control the complete local Windows Ionbeam stack with PowerShell."""
import asyncio
import os

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class manageLocalSystem_state(distributionDeploy_state):
    def __init__(self, parent):
        super(manageLocalSystem_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        if self.isProduction():
            self.info("[{}] production deployment: local process manager skipped"
                      .format(type(self).__name__))
            self._success = True
            return
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = self.resolvedActionData(stateConfig)
            operation = str(actionData.get("operation", "restart")).strip().lower()
            if operation not in {"install", "start", "restart", "stop", "status", "logs"}:
                raise ValueError("unsupported local-system operation: {}".format(operation))
            script = self.resolveDeployPath(actionData.get(
                "script", r"Development\Scripts\manage-local-system.ps1"))
            if not os.path.isfile(script):
                raise FileNotFoundError("Windows local system manager not found: {}".format(script))
            command = (
                'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{}" {}'
                .format(script.replace('"', '""'), operation))
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 300.0) or 300.0)
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
