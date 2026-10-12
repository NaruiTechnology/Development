from .distributionDeploy_state import distributionDeploy_state


class installPostgreSQL_state(distributionDeploy_state):
    async def DoWork(self):
        self.info('[installPostgreSQL_state] Local PostgreSQL installation has been removed; using the existing remote database.')
        self._success = True
