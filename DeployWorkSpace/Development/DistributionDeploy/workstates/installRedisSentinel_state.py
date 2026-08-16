"""Verify Docker Desktop for the Windows Redis/Sentinel development topology."""
import asyncio
import os
import shutil

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installRedisSentinel_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installRedisSentinel_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        if self.isProduction():
            self.info("[{}] production deployment: external Redis/Sentinel is required"
                      .format(type(self).__name__))
            self._success = True
            return
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = self.resolvedActionData(stateConfig)
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 900.0) or 900.0)
            executable = str(actionData.get("requiredExecutable", "docker.exe"))
            docker = self._findDocker(executable)
            if not docker:
                packageId = str(actionData.get(
                    "packageId", "Docker.DockerDesktop")).strip()
                winget = shutil.which("winget.exe") or shutil.which("winget")
                if not winget:
                    raise RuntimeError(
                        "Docker Desktop is required. Install it or make docker.exe available on PATH.")
                command = [
                    winget, "install", "--id", packageId, "--exact", "--silent",
                    "--accept-package-agreements", "--accept-source-agreements",
                ]
                self.info("[{}] installing {} with winget".format(
                    type(self).__name__, packageId))
                ok, _, stderr = await self._runExec(command, timeout)
                if not ok:
                    raise RuntimeError("Docker Desktop installation failed: {}".format(stderr))
                docker = self._findDocker(executable)
                if not docker:
                    raise RuntimeError(
                        "Docker Desktop installed, but docker.exe is not available yet. "
                        "Start Docker Desktop and rerun the workflow.")

            ok, _, stderr = await self._runExec([docker, "info"], 60.0)
            if not ok:
                raise RuntimeError(
                    "Docker Desktop is installed but its engine is not ready: {}".format(stderr))
            self.info("[{}] Docker Desktop is ready for Redis/Sentinel"
                      .format(type(self).__name__))
            self._success = True
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    @staticmethod
    def _findDocker(executable):
        found = shutil.which(executable)
        if found:
            return found
        programFiles = os.environ.get("ProgramFiles", r"C:\Program Files")
        candidate = os.path.join(
            programFiles, "Docker", "Docker", "resources", "bin", "docker.exe")
        return candidate if os.path.isfile(candidate) else None

    async def _runExec(self, argv, timeout):
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=self.deployRoot(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            return False, "", "timeout"
        return (
            proc.returncode == 0,
            stdout.decode(errors="replace"),
            stderr.decode(errors="replace"),
        )
