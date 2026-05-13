#-------------------------------------------------------------------------------
# setupIonbeamWeb_state.py
#
# Prepare the ionbeam-web Node backend and Vite frontend before launching their
# long-running dev servers.
#-------------------------------------------------------------------------------
import asyncio
import os
import shutil

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class setupIonbeamWeb_state(distributionDeploy_state):
    def __init__(self, parent):
        super(setupIonbeamWeb_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            webRoot = actionData.get(
                "webRoot",
                os.path.join(self.deployRoot(), "Development", "ionbeam-web"))
            webRoot = self._resolveWebRoot(webRoot)
            backendDir = actionData.get("backendDir", os.path.join(webRoot, "backend"))
            frontendDir = actionData.get("frontendDir", os.path.join(webRoot, "frontend"))
            if not os.path.isdir(backendDir) or not os.path.isdir(frontendDir):
                backendDir = os.path.join(webRoot, "backend")
                frontendDir = os.path.join(webRoot, "frontend")
            createEnv = bool(actionData.get("createBackendEnv", True))
            install = bool(actionData.get("npmInstall", True))
            useNvm = bool(actionData.get("useNvm", True))

            required = [
                (backendDir, "backend directory"),
                (frontendDir, "frontend directory"),
                (os.path.join(backendDir, "package.json"), "backend package.json"),
                (os.path.join(frontendDir, "package.json"), "frontend package.json"),
            ]
            missing = [label + ": " + path for path, label in required
                       if not os.path.exists(path)]
            if missing:
                self.error("[{}] ionbeam-web is incomplete:\n{}"
                           .format(type(self).__name__, "\n".join(missing)))
                self._success = False
                return

            if createEnv:
                envExample = os.path.join(backendDir, ".env.example")
                envFile = os.path.join(backendDir, ".env")
                if os.path.isfile(envExample) and not os.path.exists(envFile):
                    shutil.copy2(envExample, envFile)
                    self.info("[{}] created {}".format(type(self).__name__, envFile))
                elif os.path.exists(envFile):
                    self.info("[{}] {} already exists".format(type(self).__name__, envFile))
                else:
                    self.warn("[{}] backend .env.example not found; skipping .env creation"
                              .format(type(self).__name__))

            if not install:
                self._success = True
                return

            npm = "npm.cmd" if os.name == "nt" else "npm"
            commands = [
                ("backend", backendDir, "{} install".format(npm)),
                ("frontend", frontendDir, "{} install".format(npm)),
            ]

            allOk = True
            for label, runDir, rawCmd in commands:
                cmd = self._wrapNodeCommand(rawCmd, useNvm)
                self.info("[{}][{}] >> {}".format(type(self).__name__, label, rawCmd))
                ok = await self._runWithTimeout(cmd, runDir, timeout)
                if not ok:
                    self.error("[{}][{}] FAILED\n{}"
                               .format(type(self).__name__, label,
                                       self._stderr.decode(errors="replace")
                                       if self._stderr else "<no stderr>"))
                    allOk = False
                    break

            self._success = allOk
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    def _wrapNodeCommand(self, cmd, useNvm):
        if not useNvm:
            return cmd
        return (
            "bash -lc 'export NVM_DIR=\"$HOME/.nvm\" && "
            "[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && {}'"
            .format(cmd)
        )

    def _resolveWebRoot(self, configuredRoot):
        candidates = [
            configuredRoot,
            os.path.join(self.deployRoot(), "ionbeam-web"),
            os.path.join(self.deployRoot(), "Development", "ionbeam-web"),
        ]
        for candidate in candidates:
            if self._hasNodeProjects(candidate):
                if candidate != configuredRoot:
                    self.info("[{}] using detected ionbeam-web root: {}"
                              .format(type(self).__name__, candidate))
                return candidate
        return configuredRoot

    def _hasNodeProjects(self, webRoot):
        return (
            os.path.isfile(os.path.join(webRoot, "backend", "package.json")) and
            os.path.isfile(os.path.join(webRoot, "frontend", "package.json"))
        )

    async def _runWithTimeout(self, cmd, runDir, timeout):
        if timeout and timeout > 0:
            try:
                return await asyncio.wait_for(
                    self.commandAsyncio(cmd, runDir, verbose=True),
                    timeout=timeout)
            except asyncio.TimeoutError:
                self.error("[{}] timed out after {}s on: {}"
                           .format(type(self).__name__, timeout, cmd))
                return False
        return await self.commandAsyncio(cmd, runDir, verbose=True)
