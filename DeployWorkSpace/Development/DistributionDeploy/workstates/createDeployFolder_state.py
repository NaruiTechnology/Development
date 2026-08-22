
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
    _STOP_DEPLOY_ROOT_PROCESSES = r"""
$ErrorActionPreference = "Stop"
$DeployRoot = $env:IOBEAM_DEPLOY_ROOT_TO_STOP
$separator = [IO.Path]::DirectorySeparatorChar
$rootPrefix = [IO.Path]::GetFullPath($DeployRoot).TrimEnd([char[]]"\/") + $separator
$targets = @(Get-Process | Where-Object {
    try {
        $imagePath = $_.Path
        $imagePath -and
            [IO.Path]::GetFullPath($imagePath).StartsWith(
                $rootPrefix, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        $false
    }
})

foreach ($target in $targets) {
    Write-Output ("Stopping deploy-root process {0} ({1})" -f
        $target.Id, $target.Path)
    & taskkill.exe /PID $target.Id /T /F | Out-Null
    if ($LASTEXITCODE -ne 0 -and
            (Get-Process -Id $target.Id -ErrorAction SilentlyContinue)) {
        throw "Could not stop deploy-root process $($target.Id)."
    }
}
"""

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
                      "checking for deploy-root processes"
                      .format(type(self).__name__))
        else:
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
            if not await self._waitForStopProcess(
                    proc, timeout, "existing Windows stack"):
                return False

        # The manager can only stop PIDs it recorded. Services launched by a
        # dedicated restart script still load native modules from .venv and
        # keep them locked on Windows, so stop any remaining process whose
        # executable is actually inside this guarded deploy root. taskkill /T
        # also terminates the base-Python child created by a venv launcher.
        return await self._stopDeployRootProcesses(deployRoot, timeout)

    async def _stopDeployRootProcesses(self, deployRoot, timeout):
        self.info("[{}] stopping remaining processes running from {}"
                  .format(type(self).__name__, deployRoot))
        processEnv = os.environ.copy()
        processEnv["IOBEAM_DEPLOY_ROOT_TO_STOP"] = deployRoot
        proc = await asyncio.create_subprocess_exec(
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-Command", self._STOP_DEPLOY_ROOT_PROCESSES,
            env=processEnv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return await self._waitForStopProcess(
            proc, timeout, "deploy-root processes")

    async def _waitForStopProcess(self, proc, timeout, description):
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            self.error("[{}] timed out after {}s while stopping {}"
                       .format(type(self).__name__, timeout, description))
            return False

        stdoutText = stdout.decode(errors="replace").strip()
        stderrText = stderr.decode(errors="replace").strip()
        if stdoutText:
            self.info("[{}] stop output:\n{}"
                      .format(type(self).__name__, stdoutText))
        if proc.returncode != 0:
            self.error("[{}] failed to stop {} (exit code {}):\n{}"
                       .format(type(self).__name__, description,
                               proc.returncode, stderrText or "<no stderr>"))
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
