"""Install or verify Node.js LTS on Windows."""
import asyncio
import os
import shutil

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installNodeJS_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installNodeJS_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 600.0) or 600.0)
            node = shutil.which("node.exe") or shutil.which("node")
            npm = shutil.which("npm.cmd") or shutil.which("npm")
            if not node or not npm:
                if not bool(actionData.get("installOnWindows", True)):
                    raise RuntimeError("Node.js/npm are missing and installOnWindows is false")
                winget = shutil.which("winget.exe") or shutil.which("winget")
                if not winget:
                    raise RuntimeError("winget.exe is required to install Node.js LTS")
                package = str(actionData.get(
                    "windowsPackage", "OpenJS.NodeJS.LTS"))
                command = [
                    winget, "install", "--id", package, "--exact", "--silent",
                    "--accept-source-agreements", "--accept-package-agreements",
                ]
                if not await self._run(command, timeout):
                    self._success = False
                    return
                node = shutil.which("node.exe") or shutil.which("node")
                npm = shutil.which("npm.cmd") or shutil.which("npm")
            if not node or not npm:
                raise RuntimeError(
                    "Node.js installed, but node/npm are not visible yet. "
                    "Open a new terminal and rerun the workflow.")
            self._success = (
                await self._run([node, "--version"], timeout)
                and await self._run([npm, "--version"], timeout)
            )
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    async def _run(self, argv, timeout):
        self.info("[{}] >> {}".format(type(self).__name__, " ".join(argv)))
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=self.deployRoot(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        try:
            self._stdout, self._stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            return False
        return proc.returncode == 0
