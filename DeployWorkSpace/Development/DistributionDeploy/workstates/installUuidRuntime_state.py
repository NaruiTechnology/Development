"""Ensure the uuid-runtime package and uuidgen executable are available."""
import asyncio
import shlex

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installUuidRuntime_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installUuidRuntime_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 600.0) or 600.0)
            package = str(actionData.get("package", "uuid-runtime"))
            if package != "uuid-runtime":
                raise ValueError("unsupported UUID runtime package: {}".format(package))

            verify = "command -v uuidgen >/dev/null && uuidgen --version"
            if await self._run(verify, 30.0):
                self.info("[{}] uuidgen is already installed; skipping apt"
                          .format(type(self).__name__))
                self._success = True
                return

            command = (
                "sudo -n true || {{ "
                "echo 'sudo credentials are required; run sudo -v before deployment' >&2; "
                "exit 1; }}; "
                "sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update && "
                "sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y "
                "--no-install-recommends {package} && {verify}"
            ).format(package=shlex.quote(package), verify=verify)
            self.info("[{}] installing {}".format(type(self).__name__, package))
            self._success = await self._run(command, timeout)
            if not self._success:
                stderr = (self._stderr.decode(errors="replace")
                          if self._stderr else "<no stderr>")
                self.error("[{}] installation failed\n{}"
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
            self.error("[{}] TIMEOUT after {}s"
                       .format(type(self).__name__, timeout))
            return False
