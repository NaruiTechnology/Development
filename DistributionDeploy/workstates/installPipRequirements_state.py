#-------------------------------------------------------------------------------
# installPipRequirements_state.py
#
# Walks the deploy root (post-unzip) looking for every requirements.txt, and
# pip-installs each of them. The example dist contains glasgow_service/
# requirements.txt, but the project may grow more, so we discover them
# dynamically rather than hard-coding the list.
#
# Action data fields recognised:
#   root                    deploy root to walk (defaults to thread.deployRoot)
#   requirementsName        filename to match (default: requirements.txt)
#   skipDirs                directories never descended into
#   stopOnError             if True, the first failing pip aborts the workflow
#   useBreakSystemPackages  if True, append --break-system-packages (Ubuntu 24.04
#                           PEP-668-protected system Python defaults to refusing
#                           pip install -- this flag opts back in)
#-------------------------------------------------------------------------------
import asyncio
import os

from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


DEFAULT_SKIP_DIRS = {
    "node_modules", ".venv", "__pycache__", ".git", "dist_app",
}


class installPipRequirements_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installPipRequirements_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}

            root = actionData.get("root") or self.deployRoot()
            reqName = actionData.get("requirementsName", "requirements.txt")
            skipDirs = set(actionData.get("skipDirs", []) or []) or DEFAULT_SKIP_DIRS
            stopOnError = bool(actionData.get("stopOnError", False))
            breakSys = bool(actionData.get("useBreakSystemPackages", True))
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            if not os.path.isdir(root):
                self.warn("[{}] deploy root '{}' does not exist; nothing to do."
                          .format(type(self).__name__, root))
                self.Success = True
                return

            # Discover all requirements.txt
            found = []
            for r, dirs, files in os.walk(root):
                dirs[:] = [d for d in dirs if d not in skipDirs]
                if reqName in files:
                    found.append(os.path.join(r, reqName))

            if not found:
                self.info("[{}] no '{}' files under '{}'; nothing to install."
                          .format(type(self).__name__, reqName, root))
                self.Success = True
                return

            self.info("[{}] found {} requirement file(s):"
                      .format(type(self).__name__, len(found)))
            for f in found:
                self.info("   - {}".format(f))

            allOk = True
            for reqFile in found:
                cmd = "python3 -m pip install -r {}".format(reqFile)
                if breakSys:
                    cmd += " --break-system-packages"
                self.info("[{}] >> {}".format(type(self).__name__, cmd))
                ok = await self._runWithTimeout(cmd, root, timeout)
                if not ok:
                    self.error("[{}] pip install failed for {}\n{}".format(
                        type(self).__name__, reqFile,
                        self._stderr.decode(errors="replace") if self._stderr else "<no stderr>"))
                    allOk = False
                    if stopOnError:
                        break

            self.Success = allOk
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self.Success = False

    async def _runWithTimeout(self, cmd, runDir, timeout):
        if timeout and timeout > 0:
            try:
                return await asyncio.wait_for(
                    self.commandAsyncio(cmd, runDir, verbose=True),
                    timeout=timeout)
            except asyncio.TimeoutError:
                self.error("[{}] timed out after {}s on: {}"
                           .format(type(self).__name__, timeout, cmd))
                return False
        return await self.commandAsyncio(cmd, runDir, verbose=True)
