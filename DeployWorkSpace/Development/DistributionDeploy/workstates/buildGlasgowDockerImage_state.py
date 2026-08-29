"""Build the local Glasgow service container image."""
import asyncio
import os
import shlex
import sys

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts
from .distributionDeploy_state import distributionDeploy_state


class buildGlasgowDockerImage_state(distributionDeploy_state):
    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            cfg = self.ParentWorkThread.GetStateConfig(self) or {}
            data = self.resolvedActionData(cfg)
            script = self.resolveDeployPath(data.get(
                "script", "Development/Scripts/build-glasgow-service-docker.py"))
            if not os.path.isfile(script):
                raise FileNotFoundError("Docker build script not found: {}".format(script))
            cmd = "{} {} {}".format(shlex.quote(sys.executable), shlex.quote(script), shlex.quote(
                str(data.get("image", "glasgow-service:local"))))
            self._success = await asyncio.wait_for(
                self.commandAsyncio(cmd, self.deployRoot(), verbose=True),
                timeout=float(cfg.get(Consts.TIMEOUT, 1800.0) or 1800.0))
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False
