"""Install the Redis master, Sentinel, and CLI packages for local deployment."""
import asyncio
import re
import shlex

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
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 600.0) or 600.0)
            packages = actionData.get("aptPackages", [
                "redis-server", "redis-sentinel", "redis-tools"
            ]) or []
            invalid = [
                package for package in packages
                if not re.fullmatch(r"[A-Za-z0-9.+-]+", str(package))
            ]
            if not packages or invalid:
                raise ValueError("invalid Redis apt package list: {}".format(packages))

            packageArgs = " ".join(shlex.quote(str(package)) for package in packages)
            verify = (
                "for package in {packages}; do "
                "dpkg-query -W -f='${{Status}}' \"$package\" 2>/dev/null | "
                "grep -qx 'install ok installed' || exit 1; "
                "done"
            ).format(packages=packageArgs)
            if await self._run(verify, 30.0):
                self.info("[{}] Redis/Sentinel packages are already installed; skipping apt"
                          .format(type(self).__name__))
                self._success = True
                return

            command = (
                "sudo -n true || {{ echo 'workflow sudo credential is unavailable' >&2; exit 1; }}; "
                "sudo apt-get -o DPkg::Lock::Timeout=600 update && "
                "sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 "
                "-o Dpkg::Options::=--force-confold "
                "--fix-broken install -y && "
                "sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 "
                "-o Dpkg::Options::=--force-confold "
                "install -y --no-install-recommends {packages} && "
                "{verify}"
            ).format(packages=packageArgs, verify=verify)
            self.info("[{}] installing local Redis/Sentinel packages: {}"
                      .format(type(self).__name__, ", ".join(packages)))
            self._success = await self._run(command, timeout)
            if not self._success:
                stderr = (self._stderr.decode(errors="replace")
                          if self._stderr else "<no stderr>")
                self.error("[{}] package installation failed\n{}"
                           .format(type(self).__name__, stderr))
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    async def _run(self, command, timeout):
        try:
            return await asyncio.wait_for(
                self.commandAsyncio(command, self.deployRoot(), verbose=True),
                timeout=timeout)
        except asyncio.TimeoutError:
            self.error("[{}] timed out after {}s"
                       .format(type(self).__name__, timeout))
            return False
