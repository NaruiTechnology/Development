"""Install Docker Engine on a supported target VM the first time only."""
import asyncio
import platform
import os
import shlex
import shutil
import subprocess
import time

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installDockerRuntime_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installDockerRuntime_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self) or {}
            timeout = float(stateConfig.get(Consts.TIMEOUT, 900.0) or 900.0)
            os_name = platform.system().lower()
            self.info("[{}] detected target operating system: {}"
                      .format(type(self).__name__, platform.platform()))
            if os_name == "linux":
                command = self._linuxInstallCommand()
                self._success = await asyncio.wait_for(
                    self.commandAsyncio(command, self.deployRoot(), verbose=True),
                    timeout=timeout)
            elif os_name == "windows":
                self._success = await asyncio.wait_for(
                    asyncio.to_thread(self._installWindowsDockerDesktop, timeout),
                    timeout=timeout)
            elif os_name == "darwin":
                self._success = await asyncio.wait_for(
                    asyncio.to_thread(self._installMacDockerDesktop, timeout),
                    timeout=timeout)
            else:
                raise RuntimeError("unsupported target operating system: {}".format(os_name))
            if not self._success:
                stderr = self._stderr.decode(errors="replace") if self._stderr else ""
                self.error("[{}] Docker installation failed: {}"
                           .format(type(self).__name__, stderr))
        except (asyncio.TimeoutError, Exception) as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    @staticmethod
    def _linuxInstallCommand():
        # Docker's convenience installer performs distro detection for Debian,
        # Ubuntu, Fedora, RHEL derivatives, and other supported Linux targets.
        url = shlex.quote("https://get.docker.com")
        return (
            "command -v curl >/dev/null 2>&1 || "
            "(sudo apt-get update && sudo apt-get install -y curl) || "
            "(sudo dnf install -y curl) || (sudo yum install -y curl); "
            "curl -fsSL {url} -o /tmp/get-docker.sh && "
            "sudo sh /tmp/get-docker.sh && "
            "sudo systemctl enable --now docker 2>/dev/null || true; "
            "docker --version"
        ).format(url=url)

    @classmethod
    def _installWindowsDockerDesktop(cls, timeout):
        if not cls._dockerReady():
            if not shutil.which("docker"):
                if not shutil.which("winget"):
                    raise RuntimeError(
                        "winget is required to install Docker Desktop on Windows")
                subprocess.run([
                    "winget", "install", "--exact", "--id",
                    "Docker.DockerDesktop", "--accept-package-agreements",
                    "--accept-source-agreements", "--silent"], check=True)
            desktop = os.path.join(
                os.environ.get("ProgramFiles", r"C:\Program Files"),
                "Docker", "Docker", "Docker Desktop.exe")
            if os.path.isfile(desktop):
                subprocess.Popen([desktop], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        return cls._waitForDocker(timeout)

    @classmethod
    def _installMacDockerDesktop(cls, timeout):
        if not shutil.which("docker"):
            subprocess.run(["brew", "install", "--cask", "docker"], check=True)
        subprocess.run(["open", "-a", "Docker"], check=False)
        return cls._waitForDocker(timeout)

    @staticmethod
    def _dockerReady():
        try:
            return subprocess.run(
                ["docker", "info"], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=15).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    @classmethod
    def _waitForDocker(cls, timeout):
        deadline = time.monotonic() + max(1.0, timeout)
        while time.monotonic() < deadline:
            if cls._dockerReady():
                return True
            time.sleep(2)
        return False
