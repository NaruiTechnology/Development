from .distributionDeploy_state import distributionDeploy_state


class provisionLocalAdminDb_state(distributionDeploy_state):
    async def DoWork(self):
        self.error("Local database provisioning is unavailable on Windows; configure an existing remote database.")
        self._success = False
