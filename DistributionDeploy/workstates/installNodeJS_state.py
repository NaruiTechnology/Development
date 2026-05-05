#-------------------------------------------------------------------------------
# installNodeJS_state.py
#
# Install Node.js via nvm. The canonical one-liner -- 
#   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# -- only writes nvm config into ~/.bashrc; it does NOT install Node itself.
# So this state runs a 3-stage bash script:
#
#   1. Download + run the nvm installer.
#   2. Source ~/.bashrc (or the nvm.sh stub directly) inside the same bash
#      process so `nvm` is on PATH.
#   3. nvm install <nodeVersion> (default --lts) and `nvm alias default ...`.
#
# Reading nvm.sh directly is the more reliable path -- ~/.bashrc on a fresh
# Ubuntu shell early-exits for non-interactive shells, which would silently
# drop the nvm export.
#
# Action data fields recognised:
#   nvmInstaller     URL of the nvm install.sh
#   nodeVersion      version arg passed to `nvm install` (default '--lts')
#-------------------------------------------------------------------------------
import asyncio

from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


_DEFAULT_NVM_URL = "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"


class installNodeJS_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installNodeJS_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            nvmUrl = actionData.get("nvmInstaller", _DEFAULT_NVM_URL)
            nodeVer = actionData.get("nodeVersion", "--lts")
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            # Single bash -c so all three steps share one shell, one $NVM_DIR,
            # and one PATH. We deliberately source nvm.sh directly rather than
            # ~/.bashrc to dodge the non-interactive early-exit.
            script = (
                "set -e; "
                "curl -fsSL -o- {url} | bash; "
                "export NVM_DIR=\"$HOME/.nvm\"; "
                "[ -s \"$NVM_DIR/nvm.sh\" ] && \\. \"$NVM_DIR/nvm.sh\"; "
                "nvm install {ver}; "
                "nvm alias default {ver}; "
                "node --version; "
                "npm --version"
            ).format(url=nvmUrl, ver=nodeVer)

            cmd = "bash -lc '{}'".format(script.replace("'", "'\"'\"'"))
            self.info("[{}] installing Node.js via nvm ({})..."
                      .format(type(self).__name__, nodeVer))

            ok = await self._runWithTimeout(cmd, self.deployRoot(), timeout)
            self.Success = ok
            if not ok:
                self.error("[{}] nvm/node install failed.\n{}".format(
                    type(self).__name__,
                    self._stderr.decode(errors="replace") if self._stderr else "<no stderr>"))
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
                self.error("[{}] timed out after {}s"
                           .format(type(self).__name__, timeout))
                return False
        return await self.commandAsyncio(cmd, runDir, verbose=True)
