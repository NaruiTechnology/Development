
#-------------------------------------------------------------------------------
# createDeployFolder_state.py
#
# Recreate the configured deploy root before unpacking the distribution.
#-------------------------------------------------------------------------------
import asyncio
import os

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts
from .distributionDeploy_state import distributionDeploy_state
from .unzipDistribution_state import unzipDistribution_state


class createDeployFolder_state(distributionDeploy_state):
    def __init__(self, parent):
        super(createDeployFolder_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            deployRoot = self.deployRoot()

            if not unzipDistribution_state._isSafeDeployRoot(deployRoot):
                self.error("[{}] refusing to recreate unsafe deploy root: {}"
                           .format(type(self).__name__, deployRoot))
                self._success = False
                return

            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 30.0) or 30.0)
            if not await self._stopManagedWindowsStack(deployRoot, timeout):
                self.error("[{}] could not stop the Windows deployment stack; "
                           "refusing to clear {}"
                           .format(type(self).__name__, deployRoot))
                self._success = False
                return

            # Use the guarded, current-user implementation. Never interpolate
            # a deployment path into a recursive shell deletion command.
            helper = unzipDistribution_state(self.ParentWorkThread)
            helper.Config = self.Config
            helper.Logger = self.Logger
            self._success = helper._prepareDeployRoot(deployRoot)
            if self._success:
                self.info("[{}] safely prepared {}".format(
                    type(self).__name__, deployRoot))
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    async def _stopManagedWindowsStack(self, deployRoot, timeout):
        """Stop processes launched from the deploy tree before replacing it."""
        if os.name != "nt":
            return True

        script = self._findLocalSystemManager(deployRoot)
        if script is None:
            self.info("[{}] no prior Windows local-system manager found; "
                      "continuing with a fresh deploy"
                      .format(type(self).__name__))
            return True

        self.info("[{}] stopping the existing Windows deployment stack via {}"
                  .format(type(self).__name__, script))
        proc = await asyncio.create_subprocess_exec(
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", script,
            "stop",
            cwd=deployRoot,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            self.error("[{}] timed out after {}s while stopping the existing stack"
                       .format(type(self).__name__, timeout))
            return False

        stdoutText = stdout.decode(errors="replace").strip()
        stderrText = stderr.decode(errors="replace").strip()
        if stdoutText:
            self.info("[{}] stop output:\n{}"
                      .format(type(self).__name__, stdoutText))
        if proc.returncode != 0:
            self.error("[{}] Windows stack stop failed with exit code {}:\n{}"
                       .format(type(self).__name__, proc.returncode,
                               stderrText or "<no stderr>"))
            return False
        if stderrText:
            self.warn("[{}] Windows stack stop stderr:\n{}"
                      .format(type(self).__name__, stderrText))
        return True

    @staticmethod
    def _findLocalSystemManager(deployRoot):
        candidates = [
            os.path.join(deployRoot, "Development", "Scripts",
                         "manage-local-system.ps1"),
            os.path.join(deployRoot, "Scripts", "manage-local-system.ps1"),
        ]
        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate
        return None
