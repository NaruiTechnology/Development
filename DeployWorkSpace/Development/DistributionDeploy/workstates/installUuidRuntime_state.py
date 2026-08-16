"""Verify Windows UUID support through the active Python runtime."""
import asyncio
import os
import sys

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installUuidRuntime_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installUuidRuntime_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        stateConfig = self.ParentWorkThread.GetStateConfig(self)
        actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
        timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 60.0) or 60.0)
        venvDir = self.resolveDeployPath(actionData.get("venvDir", ".venv"))
        pythonExe = os.path.join(venvDir, "Scripts", "python.exe")
        if not os.path.isfile(pythonExe):
            pythonExe = sys.executable
        command = '"{}" -c "import uuid; print(uuid.uuid4())"'.format(pythonExe)
        try:
            self._success = await asyncio.wait_for(
                self.commandAsyncio(command, self.deployRoot(), verbose=True),
                timeout=timeout)
        except asyncio.TimeoutError:
            self.error("[{}] UUID verification timed out".format(type(self).__name__))
            self._success = False
