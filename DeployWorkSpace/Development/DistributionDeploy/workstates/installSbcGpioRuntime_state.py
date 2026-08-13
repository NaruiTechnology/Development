"""Install Raspberry Pi OS GPIO packages only on Raspberry Pi targets."""
import asyncio
import os
import re
import shlex

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installSbcGpioRuntime_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installSbcGpioRuntime_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)
            requirePi = bool(actionData.get("requireRaspberryPi", True))

            model = self._raspberryPiModel()
            if requirePi and model is None:
                self.info("[{}] non-Raspberry-Pi target; skipping SBC GPIO OS packages"
                          .format(type(self).__name__))
                self._success = True
                return

            packages = actionData.get("aptPackages", []) or []
            invalid = [p for p in packages if not re.fullmatch(r"[A-Za-z0-9.+-]+", str(p))]
            if invalid:
                raise ValueError("invalid SBC apt package names: {}".format(invalid))

            self.info("[{}] Raspberry Pi detected: {}"
                      .format(type(self).__name__, model or "forced install"))
            command = ("sudo apt-get -o DPkg::Lock::Timeout=600 update && "
                       "sudo DEBIAN_FRONTEND=noninteractive apt-get "
                       "-o DPkg::Lock::Timeout=600 install -y --no-install-recommends {}").format(
                " ".join(shlex.quote(str(p)) for p in packages))
            if not await self._run(command, timeout):
                self._success = False
                return

            venvDir = self.resolveDeployPath(actionData.get("venvDir", ".venv"))
            pythonExe = os.path.join(venvDir, "bin", "python")
            if not os.path.isfile(pythonExe):
                pythonExe = "python3"
            imports = actionData.get("verifyImports", []) or []
            verify = ", ".join(str(name) for name in imports)
            command = "{} -c {}".format(
                shlex.quote(pythonExe),
                shlex.quote("import {}; print('verified SBC GPIO runtime: {}')".format(verify, verify)))
            self._success = await self._run(command, timeout)
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    @staticmethod
    def _raspberryPiModel():
        path = "/proc/device-tree/model"
        try:
            with open(path, "rb") as stream:
                model = stream.read().rstrip(b"\x00").decode(errors="replace")
        except OSError:
            return None
        return model if "raspberry pi" in model.lower() else None

    async def _run(self, command, timeout):
        try:
            if timeout > 0:
                return await asyncio.wait_for(
                    self.commandAsyncio(command, self.deployRoot(), verbose=True),
                    timeout=timeout)
            return await self.commandAsyncio(command, self.deployRoot(), verbose=True)
        except asyncio.TimeoutError:
            self.error("[{}] timed out on: {}".format(type(self).__name__, command))
            return False
