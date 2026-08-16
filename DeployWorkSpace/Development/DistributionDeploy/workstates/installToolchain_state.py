"""Install and verify the Python-provided Glasgow toolchain on Windows."""
import asyncio
import os
import shlex
import sys

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installToolchain_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installToolchain_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 600.0) or 600.0)
            venvDir = self.resolveDeployPath(actionData.get("venvDir", ".venv"))
            pythonExe = os.path.join(venvDir, "Scripts", "python.exe")
            if not os.path.isfile(pythonExe):
                pythonExe = sys.executable

            aptPackages = actionData.get("aptPackages", []) or []
            pipxBootstrap = actionData.get("pipxBootstrap", []) or []
            if aptPackages:
                self.info("[{}] Windows host: ignoring Linux package list: {}"
                          .format(type(self).__name__, ", ".join(aptPackages)))
            if pipxBootstrap:
                self.info("[{}] Windows host: pipx bootstrap is not required"
                          .format(type(self).__name__))

            commands = []
            for spec in list(dict.fromkeys(actionData.get("pipPackages", []) or [])):
                commands.append([pythonExe, "-m", "pip", "install", str(spec)])
            for raw in actionData.get("verifyCommands", []) or []:
                if isinstance(raw, (list, tuple)):
                    commands.append([str(part) for part in raw])
                else:
                    commands.append(["cmd.exe", "/d", "/s", "/c", str(raw)])

            for argv in commands:
                if not await self._run(argv, timeout):
                    self._success = False
                    return
            self._success = True
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    async def _run(self, argv, timeout):
        self.info("[{}] >> {}".format(
            type(self).__name__, " ".join(shlex.quote(part) for part in argv)))
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
        if proc.returncode != 0:
            self.error("[{}] command failed\n{}".format(
                type(self).__name__,
                self._stderr.decode(errors="replace") if self._stderr else "<no stderr>"))
        return proc.returncode == 0
