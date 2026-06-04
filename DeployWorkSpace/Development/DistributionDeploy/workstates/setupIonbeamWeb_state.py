#-------------------------------------------------------------------------------
# setupIonbeamWeb_state.py
#
# Prepare the ionbeam-web Node backend and Vite frontend before launching their
# long-running dev servers.
#-------------------------------------------------------------------------------
import asyncio
import os

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

            webRoot = self.resolveDeployPath(actionData.get(
                "webRoot", os.path.join("Development", "ionbeam-web")))
            backendDir = actionData.get("backendDir")
            backendDir = (self.resolveDeployPath(backendDir)
                          if backendDir else os.path.join(webRoot, "backend"))
            frontendDir = actionData.get("frontendDir")
            frontendDir = (self.resolveDeployPath(frontendDir)
                           if frontendDir else os.path.join(webRoot, "frontend"))
            createEnv = bool(actionData.get("createBackendEnv", True))
            install = bool(actionData.get("npmInstall", True))
            useNvm = bool(actionData.get("useNvm", True))

            # Optional extra args appended to `npm install` per target.
            # e.g. "--legacy-peer-deps", "--force", "--no-audit --no-fund".
            backendInstallArgs = str(actionData.get("backendInstallArgs", "") or "").strip()
            frontendInstallArgs = str(actionData.get("frontendInstallArgs", "") or "").strip()

            # Layered check: report the highest missing level so the user
            # can tell stale-zip from missing-subdirs from missing-manifests.
            if not os.path.isdir(webRoot):
                self.error("[{}] webRoot does not exist: {}\n"
                           "  hint: dist_app.zip may have been built without "
                           "Development/ionbeam-web, or buildDistribution was "
                           "skipped with a stale zip."
                           .format(type(self).__name__, webRoot))
                self._success = False
                return

            try:
                webRootContents = sorted(os.listdir(webRoot))
            except OSError as e:
                webRootContents = []
                self.warn("[{}] could not list {}: {}"
                          .format(type(self).__name__, webRoot, e))

            required = [
                (backendDir, "backend directory"),
                (frontendDir, "frontend directory"),
                (os.path.join(backendDir, "package.json"), "backend package.json"),
                (os.path.join(frontendDir, "package.json"), "frontend package.json"),
            ]
            missing = [label + ": " + path for path, label in required
                       if not os.path.exists(path)]
            if missing:
                self.error(
                    "[{}] ionbeam-web is incomplete under {}\n"
                    "  webRoot contents: {}\n"
                    "  missing:\n    {}"
                    .format(type(self).__name__, webRoot,
                            webRootContents or "<empty>",
                            "\n    ".join(missing)))
                self._success = False
                return

            if createEnv:
                envFile = os.path.join(backendDir, ".env")
                self._writeBackendEnv(envFile, backendDir, actionData)

            if not install:
                self._success = True
                return

            def buildInstallCmd(extra):
                return "npm install" if not extra else "npm install {}".format(extra)

            commands = [
                ("backend", backendDir, buildInstallCmd(backendInstallArgs)),
                ("frontend", frontendDir, buildInstallCmd(frontendInstallArgs)),
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

    def _writeBackendEnv(self, envFile, backendDir, actionData):
        deployRoot = self.resolveDeployPath(".")
        token = os.environ.get("GLASGOW_TOKEN", "").strip()
        backendHost = str(actionData.get("backendHost", "127.0.0.1") or "127.0.0.1").strip()
        dbHost = str(actionData.get("adminDbHost", "/var/run/postgresql") or "/var/run/postgresql").strip()
        dbName = str(actionData.get("adminDbName", "iobeam_admin") or "iobeam_admin").strip()
        lines = [
            "PROXY_TARGET_HTTP=http://127.0.0.1:8765",
            "PROXY_TARGET_WS=ws://127.0.0.1:8765",
            "GLASGOW_TOKEN={}".format(token),
            "PORT=4000",
            "HOST={}".format(backendHost),
            "MOCK=0",
            "STATIC_DIR=../frontend/dist",
            "GLASGOW_CONFIG={}".format(
                self.resolveDeployPath(os.path.join("Development", "GlasgowDataIO", "Json", "streamData.json"))),
            "IOBEAM_ADMIN_CONFIG={}".format(
                self.resolveDeployPath(os.path.join("Development", "IobeamAdmin", "Json", "IobeamAdmin.json"))),
            "IOBEAM_ADMIN_DB_HOST={}".format(dbHost),
            "IOBEAM_ADMIN_DB_PORT=5432",
            "IOBEAM_ADMIN_DB_NAME={}".format(dbName),
            "GLASGOW_RESTART_CMD={}".format(
                os.path.join(backendDir, "scripts", "restart-glasgow-service.sh")),
            "IONBEAM_BACKEND_RESTART_CMD={}".format(
                os.path.join(backendDir, "scripts", "restart-ionbeam-backend.sh")),
            "GLASGOW_PROJECT_ROOT={}".format(deployRoot),
            "GLASGOW_CONFIG_STRICT=0",
            "",
        ]
        with open(envFile, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        self.info("[{}] wrote deployment backend env: {}"
                  .format(type(self).__name__, envFile))

    def _wrapNodeCommand(self, cmd, useNvm):
        if not useNvm:
            return cmd
        return (
            "bash -lc 'export NVM_DIR=\"$HOME/.nvm\" && "
            "if [ -s \"$NVM_DIR/nvm.sh\" ]; then . \"$NVM_DIR/nvm.sh\"; fi; {}'"
            .format(cmd)
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


def _current_login():
    return os.environ.get("USER") or os.environ.get("LOGNAME") or "postgres"
