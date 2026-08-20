"""Control the complete local Windows Ionbeam stack with PowerShell."""
import asyncio
import os
import subprocess

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class manageLocalSystem_state(distributionDeploy_state):
    def __init__(self, parent):
        super(manageLocalSystem_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        if self.isProduction():
            self.info("[{}] production deployment: local process manager skipped"
                      .format(type(self).__name__))
            self._success = True
            return
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = self.resolvedActionData(stateConfig)
            operation = str(actionData.get("operation", "restart")).strip().lower()
            if operation not in {"install", "start", "restart", "stop", "status", "logs"}:
                raise ValueError("unsupported local-system operation: {}".format(operation))
            script = self.resolveDeployPath(actionData.get(
                "script", r"Development\Scripts\manage-local-system.ps1"))
            if not os.path.isfile(script):
                raise FileNotFoundError("Windows local system manager not found: {}".format(script))
            args = [
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", script, operation,
            ]
            command = subprocess.list2cmdline(args)
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 300.0) or 300.0)
            self.info("[{}] >> {}".format(type(self).__name__, command))
            self._success = await self._runManager(args, timeout)
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))

    async def _runManager(self, args, timeout):
        logDir = os.path.join(self.deployRoot(), "Logs")
        os.makedirs(logDir, exist_ok=True)
        logPath = os.path.join(logDir, "manage-local-system.log")
        header = "\r\n===== {} =====\r\n{}\r\n".format(
            type(self).__name__, subprocess.list2cmdline(args))

        # Never capture this process with asyncio PIPEs. The manager launches
        # long-lived services, and descendants can inherit pipe handles even
        # after PowerShell exits, causing communicate() to wait forever.
        with open(logPath, "ab", buffering=0) as logFile:
            logFile.write(header.encode("utf-8", errors="replace"))
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=self.deployRoot(),
                stdout=logFile,
                stderr=asyncio.subprocess.STDOUT,
                env=os.environ.copy(),
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
            try:
                returncode = await asyncio.wait_for(proc.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                await self._terminateManager(proc)
                self.error("[{}] timed out after {}s; output: {}"
                           .format(type(self).__name__, timeout, logPath))
                return False

        if returncode != 0:
            self.error("[{}] failed with exit code {}; output: {}"
                       .format(type(self).__name__, returncode, logPath))
            return False
        self.info("[{}] completed; output: {}"
                  .format(type(self).__name__, logPath))
        return True

    @staticmethod
    async def _terminateManager(proc):
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=10.0)
        except (ProcessLookupError, asyncio.TimeoutError, OSError):
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
            self._success = False
