#-------------------------------------------------------------------------------
# setupVirtualEnv_state.py
#
# Create the project virtualenv at <DeployRoot>/.venv and bootstrap pip.
# Pure template state.
#-------------------------------------------------------------------------------
from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .executeShellCommand_state import executeShellCommand_state

class setupVirtualEnv_state(executeShellCommand_state):
    def __init__(self, parent):
        super(setupVirtualEnv_state, self).__init__(parent)

    @overrides(executeShellCommand_state)
    async def DoWork(self):
        stateConfig = self.ParentWorkThread.GetStateConfig(self)
        actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}

        root = self.resolveDeployPath(actionData.get("root") or ".")
        venv = actionData.get("venv", ".venv")
        venvAct = actionData.get("venvAct", venv)
        commandFormat = actionData.get(
            Consts.COMMAND_FORMAT,
            "bash -c 'cd {} && python3 -m venv {} && . {}/bin/activate && python -m pip install --upgrade pip'")
        cmd = commandFormat.format(root, venv, venvAct)

        self.info("[{}] >> {}".format(type(self).__name__, cmd))
        timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)
        self._success = await self._run(cmd, timeout)
        if self._success:
            self.ParentWorkThread._venvPath = self.resolveDeployPath(venv)
            self.info("[{}] OK".format(type(self).__name__))
        else:
            self.error("[{}] FAILED. stderr:\n{}"
                       .format(type(self).__name__,
                               self._stderr.decode(errors='replace')
                               if self._stderr else "<none>"))
