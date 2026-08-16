"""Create and upgrade the Windows deployment virtual environment."""
import asyncio
import os
import shutil
import sys

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class setupVirtualEnv_state(distributionDeploy_state):
    def __init__(self, parent):
        super(setupVirtualEnv_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 300.0) or 300.0)
            root = self.resolveDeployPath(actionData.get("root") or ".")
            venvDir = self.resolveDeployPath(actionData.get("venv", ".venv"))
            launcher = shutil.which("py.exe") or shutil.which("python.exe") or sys.executable
            launcherArgs = ["-3"] if os.path.basename(launcher).lower() == "py.exe" else []
            create = [launcher] + launcherArgs + ["-m", "venv", venvDir]
            if not await self._run(create, root, timeout):
                self._success = False
                return
            pythonExe = os.path.join(venvDir, "Scripts", "python.exe")
            self._success = await self._run(
                [pythonExe, "-m", "pip", "install", "--upgrade", "pip"],
                root, timeout)
            if self._success:
                self.ParentWorkThread._venvPath = venvDir
                self.info("[{}] virtual environment ready: {}"
                          .format(type(self).__name__, venvDir))
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    async def _run(self, argv, cwd, timeout):
        self.info("[{}] >> {}".format(type(self).__name__, " ".join(argv)))
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            return False
        self._stdout, self._stderr = stdout, stderr
        return proc.returncode == 0
