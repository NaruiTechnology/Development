"""Prepare WSL 2 before spending time on application dependency installation."""
from .installRedisSentinel_state import installRedisSentinel_state


class prepareDockerWsl_state(installRedisSentinel_state):
    async def DoWork(self):
        self._success = False
        try:
            if self.isProduction():
                self.info('[prepareDockerWsl_state] external Redis/Sentinel configured; local Docker preparation skipped.')
                self._success = True
                return
            config = self.ParentWorkThread.GetStateConfig(self) or {}
            timeout = float(config.get('timeout', 600) or 600)
            docker = self._findDocker('docker.exe')
            if docker:
                ready, _, _ = await self._runExec([docker, 'info'], 15)
                if ready:
                    self.info('[prepareDockerWsl_state] Docker engine is already running.')
                    self._success = True
                    return
            self.info('[prepareDockerWsl_state] preparing Windows features and WSL 2 runtime.')
            await self._prepareBackend(timeout)
            self.ParentWorkThread._dockerWslPrepared = True
            self._success = True
        except Exception as error:
            self.error('[prepareDockerWsl_state] ' + str(error))
