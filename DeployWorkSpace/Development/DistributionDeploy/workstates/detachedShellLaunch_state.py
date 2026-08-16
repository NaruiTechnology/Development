"""Launch a long-running Windows command and track its process ID."""
import os
import socket
import subprocess
import time

from buildingblocks.decorators import overrides
from .distributionDeploy_state import distributionDeploy_state


class detachedShellLaunch_state(distributionDeploy_state):
    def __init__(self, parent):
        super(detachedShellLaunch_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = self.resolvedActionData(stateConfig)
            runDir = self.resolveDeployPath(
                actionData.get("dir") or actionData.get("root") or ".")
            command = str(actionData.get("command") or "").strip()
            logPath = self.resolveDeployPath(
                actionData.get("log") or os.path.join("Logs", "service.log"))
            pidPath = self.resolveDeployPath(
                actionData.get("pid") or os.path.join(
                    "Runtime", type(self).__name__ + ".pid"))
            port = actionData.get("port")
            if not command:
                raise ValueError("actionData.command is required")
            if not os.path.isdir(runDir):
                raise FileNotFoundError("run directory does not exist: {}".format(runDir))

            self._stopTrackedProcess(pidPath)
            env = os.environ.copy()
            for key, value in (actionData.get("exports", {}) or {}).items():
                env[str(key)] = str(self.resolveEnvValue(value))
            venvActivate = actionData.get("venvActivate")
            if venvActivate:
                activatePath = self.resolveDeployPath(venvActivate)
                scriptsDir = os.path.dirname(activatePath)
                env["VIRTUAL_ENV"] = os.path.dirname(scriptsDir)
                env["PATH"] = scriptsDir + os.pathsep + env.get("PATH", "")
            if (self.deploymentValue("MobilityOnly", False)
                    and type(self).__name__ == "launchIonbeamWebFrontend_state"):
                env["VITE_MOBILITY_ONLY"] = "1"

            os.makedirs(os.path.dirname(logPath), exist_ok=True)
            os.makedirs(os.path.dirname(pidPath), exist_ok=True)
            logFile = open(logPath, "ab", buffering=0)
            flags = (
                getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
            proc = subprocess.Popen(
                ["cmd.exe", "/d", "/s", "/c", command],
                cwd=runDir,
                stdin=subprocess.DEVNULL,
                stdout=logFile,
                stderr=subprocess.STDOUT,
                env=env,
                creationflags=flags)
            with open(pidPath, "w", encoding="ascii") as stream:
                stream.write("{}\n".format(proc.pid))

            if port and not self._waitForPort(int(port), float(
                    actionData.get("readinessTimeout", 20.0))):
                self._stopTrackedProcess(pidPath)
                raise RuntimeError(
                    "service did not listen on port {}; log={}".format(port, logPath))
            self.info("[{}] launched Windows process PID {}; log={}"
                      .format(type(self).__name__, proc.pid, logPath))
            self._success = True
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    @staticmethod
    def _stopTrackedProcess(pidPath):
        if not os.path.isfile(pidPath):
            return
        try:
            with open(pidPath, "r", encoding="ascii") as stream:
                pid = int(stream.read().strip())
            subprocess.run(
                ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False)
        except (OSError, ValueError):
            pass
        try:
            os.remove(pidPath)
        except OSError:
            pass

    @staticmethod
    def _waitForPort(port, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
                client.settimeout(0.5)
                if client.connect_ex(("127.0.0.1", port)) == 0:
                    return True
            time.sleep(0.25)
        return False
