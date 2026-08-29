"""Launch and manage the Docker-hosted Glasgow service."""
import asyncio
import os
import shlex
import sys

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts
from .distributionDeploy_state import distributionDeploy_state


class manageLocalSystemDocker_state(distributionDeploy_state):
    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            cfg = self.ParentWorkThread.GetStateConfig(self) or {}
            data = self.resolvedActionData(cfg)
            script = self.resolveDeployPath(data.get(
                "script", "Development/Scripts/manage-local-system-docker.py"))
            if not os.path.isfile(script):
                raise FileNotFoundError("Docker manager not found: {}".format(script))
            operation = str(data.get("operation", "restart"))
            if operation not in {"start", "restart", "stop", "status", "logs"}:
                raise ValueError("unsupported Docker manager operation: {}".format(operation))
            cmd = "{} {} {}".format(
                shlex.quote(sys.executable), shlex.quote(script), shlex.quote(operation))
            self._success = await asyncio.wait_for(
                self.commandAsyncio(cmd, self.deployRoot(), verbose=True),
                timeout=float(cfg.get(Consts.TIMEOUT, 300.0) or 300.0))
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False
