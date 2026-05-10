#-------------------------------------------------------------------------------
# installNodeJS_state.py
#
# Install or verify Node.js for the ionbeam-web backend/frontend.
#
# On Windows:
#   - If node/npm already exist on PATH, verify their versions and return.
#   - Otherwise, optionally install Node.js LTS through winget.
#
# On Linux:
#   - Install Node.js through nvm, then verify node/npm.
#
# Action data fields recognised:
#   nvmInstaller      URL of the nvm install.sh
#   nodeVersion       version arg passed to `nvm install` (default '--lts')
#   windowsPackage    winget package id (default OpenJS.NodeJS.LTS)
#   installOnWindows  bool, run winget if node/npm are missing (default True)
#-------------------------------------------------------------------------------
import asyncio
import os
import shutil
import stat
import tempfile

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


_DEFAULT_NVM_URL = "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"
_SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class installNodeJS_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installNodeJS_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        script_path = None
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            if os.name == "nt":
                self.Success = await self._setupWindows(actionData, timeout)
                return

            nvmUrl = actionData.get("nvmInstaller", _DEFAULT_NVM_URL)
            nodeVer = actionData.get("nodeVersion", "--lts")
            script_lines = [
                "#!/usr/bin/env bash",
                "set -e",
                "export PATH={safe}:$PATH".format(safe=_SAFE_PATH),
                "command -v curl >/dev/null 2>&1 || { "
                    "sudo apt-get update -qq && "
                    "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl; "
                "}",
                "curl -fsSL -o- {url} | bash".format(url=nvmUrl),
                'export NVM_DIR="$HOME/.nvm"',
                '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
                "nvm install {ver}".format(ver=nodeVer),
                "nvm alias default $(nvm current)",
                "node --version",
                "npm --version",
            ]

            with tempfile.NamedTemporaryFile(
                    mode="w", suffix=".sh", delete=False) as f:
                f.write("\n".join(script_lines) + "\n")
                script_path = f.name

            os.chmod(script_path, stat.S_IRWXU)

            cmd = "bash {}".format(script_path)
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
        finally:
            if script_path and os.path.exists(script_path):
                os.unlink(script_path)

    async def _setupWindows(self, actionData, timeout):
        node = shutil.which("node")
        npm = shutil.which("npm") or shutil.which("npm.cmd")
        if node and npm:
            self.info("[{}] Node.js already available: node={}, npm={}"
                      .format(type(self).__name__, node, npm))
            ok_node = await self._runWithTimeout("node --version", self.deployRoot(), timeout)
            ok_npm = await self._runWithTimeout("npm --version", self.deployRoot(), timeout)
            return ok_node and ok_npm

        if not bool(actionData.get("installOnWindows", True)):
            self.error("[{}] node/npm not found on PATH and installOnWindows=false."
                       .format(type(self).__name__))
            return False

        winget = shutil.which("winget")
        if not winget:
            self.error("[{}] node/npm not found and winget is not available. "
                       "Install Node.js LTS and rerun the deploy."
                       .format(type(self).__name__))
            return False

        package = actionData.get("windowsPackage", "OpenJS.NodeJS.LTS")
        cmd = (
            'winget install --id {} --exact --accept-package-agreements '
            '--accept-source-agreements'
        ).format(package)
        self.info("[{}] installing Node.js on Windows via winget: {}"
                  .format(type(self).__name__, package))
        if not await self._runWithTimeout(cmd, self.deployRoot(), timeout):
            return False

        return (
            await self._runWithTimeout("node --version", self.deployRoot(), timeout)
            and await self._runWithTimeout("npm --version", self.deployRoot(), timeout)
        )

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
