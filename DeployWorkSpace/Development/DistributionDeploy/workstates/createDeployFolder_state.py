#-------------------------------------------------------------------------------
# createDeployFolder_state.py
#
# Recreate the configured deploy root before unpacking the distribution.
#-------------------------------------------------------------------------------
import os

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .executeShellCommand_state import executeShellCommand_state
from .unzipDistribution_state import unzipDistribution_state


class createDeployFolder_state(executeShellCommand_state):
    def __init__(self, parent):
        super(createDeployFolder_state, self).__init__(parent)

    @overrides(executeShellCommand_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            deployRoot = self.resolveDeployPath(
                actionData.get("deployRoot") or ".")

            if not unzipDistribution_state._isSafeDeployRoot(deployRoot):
                self.error("[{}] refusing to recreate unsafe deploy root: {}"
                           .format(type(self).__name__, deployRoot))
                self._success = False
                return

            commandFormat = actionData.get(Consts.COMMAND_FORMAT)
            if not commandFormat:
                if os.name == "nt":
                    commandFormat = (
                        "powershell -NoProfile -ExecutionPolicy Bypass "
                        "-Command \"$root='$1'; "
                        "if (Test-Path -LiteralPath $root) { "
                        "Remove-Item -LiteralPath $root -Recurse -Force }; "
                        "New-Item -ItemType Directory -Path $root -Force | Out-Null\""
                    )
                else:
                    commandFormat = "rm -rf '$1' && mkdir -p '$1'"
            safeDeployRoot = (deployRoot.replace("'", "''")
                              if os.name == "nt"
                              else deployRoot.replace("'", "'\"'\"'"))
            cmd = commandFormat.replace("$1", safeDeployRoot)

            self.info("[{}] >> {}".format(type(self).__name__, cmd))
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)
            self._success = await self._run(cmd, timeout)

            if self._success:
                self.info("[{}] OK".format(type(self).__name__))
            else:
                self.error("[{}] FAILED. stderr:\n{}"
                           .format(type(self).__name__,
                                   self._stderr.decode(errors='replace')
                                   if self._stderr else "<none>"))
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False
