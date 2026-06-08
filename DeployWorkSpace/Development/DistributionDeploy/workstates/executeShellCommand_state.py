#-------------------------------------------------------------------------------
# executeShellCommand_state.py
#
# Generic shell-command runner. Analog of LoadFPGAImage's asyncioCommand_state.
#
# Behavior:
#   - Pulls this state's action node from config.Actions via
#     ParentWorkThread.GetStateConfig(self).
#   - Builds a single shell command from actionData['commandFormat'] using the
#     remaining actionData entries as positional values (the framework's
#     standard formatCommand contract).
#   - Runs it via WorkState.commandAsyncio (asyncio.create_subprocess_shell)
#     from the deploy root directory.
#   - Honors the action's 'timeout' field; timeout <= 0 means "no timeout".
#-------------------------------------------------------------------------------
import asyncio

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class executeShellCommand_state(distributionDeploy_state):
    """Run one shell command described by the action's commandFormat."""

    def __init__(self, parent):
        super(executeShellCommand_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            stateConfig = self.resolvedStateConfig(stateConfig)
            if stateConfig is None or Consts.ACTION_DATA not in stateConfig:
                self.error("[{}] no actionData; nothing to run."
                           .format(type(self).__name__))
                self.Success = False
                return

            cmd = self.formatCommand(stateConfig)
            if not cmd:
                self.error("[{}] could not format command."
                           .format(type(self).__name__))
                self.Success = False
                return

            self.info("[{}] >> {}".format(type(self).__name__, cmd))

            self.ParentWorkThread.activateVirtualEnv()
            
            timeout = float(stateConfig.get(Consts.TIMEOUT, 0.0) or 0.0)
            self._success = await self._run(cmd, timeout)
            
            if self._success:
                self.info("[{}] OK".format(type(self).__name__))
                from .setupVirtualEnv_state import setupVirtualEnv_state
                if isinstance(self, setupVirtualEnv_state):
                    actionData = stateConfig.get(Consts.ACTION_DATA, {})
                    self.ParentWorkThread._venvPath = f'{actionData.get("venvPath", ".venv")}/{actionData.get("venvAct", ".venv")}'
            else:
                self.error("[{}] FAILED. stderr:\n{}"
                           .format(type(self).__name__,
                                   self._stderr.decode(errors='replace') if self._stderr else "<none>"))
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self.Success = False

    async def _run(self, cmd, timeout):
        runDir = getattr(self.ParentWorkThread, "sourceRoot", self.workRoot())
        if timeout and timeout > 0:
            try:
                return await asyncio.wait_for(
                    self.commandAsyncio(cmd, runDir, verbose=True),
                    timeout=timeout)
            except asyncio.TimeoutError:
                self.error("[{}] TIMEOUT after {}s"
                           .format(type(self).__name__, timeout))
                return False
        return await self.commandAsyncio(cmd, runDir, verbose=True)
