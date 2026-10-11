"""Ensure PostgreSQL server and client packages are installed and running."""
import asyncio

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installPostgreSQL_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installPostgreSQL_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 900.0) or 900.0)
            workflow = getattr(self.ParentWorkThread, "_config", None)
            actions = getattr(workflow, "Actions", []) if workflow is not None else []
            local_action = next((entry.get("provisionLocalAdminDb") for entry in actions
                                 if isinstance(entry, dict) and "provisionLocalAdminDb" in entry), {})
            installServer = not bool(local_action.get(Consts.SKIP, True))
            verify = "command -v psql >/dev/null"
            if installServer:
                verify += (
                    " && dpkg-query -W -f='${Status}' postgresql 2>/dev/null | "
                    "grep -qx 'install ok installed' && systemctl is-active --quiet postgresql.service"
                )
            if await self._run(verify, 30.0):
                self.info("[{}] PostgreSQL requirement is already met; skipping apt"
                          .format(type(self).__name__))
                self._success = True
                return

            packages = "postgresql postgresql-contrib postgresql-client" if installServer else "postgresql-client"
            start_server = " && sudo systemctl enable --now postgresql.service" if installServer else ""
            command = (
                # Single braces: this string is not passed through str.format(), and
                # doubled braces made the shell exit 1 on every fresh install.
                "sudo -n true || { echo 'workflow sudo credential is unavailable' >&2; exit 1; }; "
                "sudo DEBIAN_FRONTEND=noninteractive apt-get "
                "-o DPkg::Lock::Timeout=600 update && "
                "sudo DEBIAN_FRONTEND=noninteractive apt-get "
                "-o DPkg::Lock::Timeout=600 install -y --no-install-recommends " + packages +
                start_server + " && command -v psql >/dev/null"
            )
            self.info("[{}] installing PostgreSQL {}".format(
                type(self).__name__, "server and client" if installServer else "client only"))
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
