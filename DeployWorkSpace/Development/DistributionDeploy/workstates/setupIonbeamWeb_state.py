#-------------------------------------------------------------------------------
# setupIonbeamWeb_state.py
#
# Prepare the ionbeam-web Node backend and Vite frontend before launching their
# long-running dev servers.
#-------------------------------------------------------------------------------
import asyncio
import json
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
            stateConfig = self.resolvedStateConfig(stateConfig)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            webRoot = actionData.get(
                "webRoot",
                os.path.join(self.deployRoot(), "Development", "ionbeam-web"))
            webRoot = self.resolveDeployPath(webRoot)
            webRoot = self._resolveWebRoot(webRoot)
            backendDir = actionData.get("backendDir")
            backendDir = (self.resolveDeployPath(backendDir)
                          if backendDir else os.path.join(webRoot, "backend"))
            frontendDir = actionData.get("frontendDir")
            frontendDir = (self.resolveDeployPath(frontendDir)
                           if frontendDir else os.path.join(webRoot, "frontend"))
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
                envFile = os.path.join(backendDir, ".env")
                self._writeBackendEnv(envFile, backendDir, actionData)

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

    def _writeBackendEnv(self, envFile, backendDir, actionData):
        deployRoot = self.resolveDeployPath(".")
        deployment = self.deploymentConfig()
        token = os.environ.get("GLASGOW_TOKEN", "").strip()
        backendHost = str(
            deployment.get("BackendHost")
            or actionData.get("backendHost")
            or "127.0.0.1"
        ).strip()
        proxyTargetHttp = str(
            deployment.get("ProxyTargetHttp")
            or actionData.get("proxyTargetHttp")
            or "http://127.0.0.1:8765"
        ).strip()
        proxyTargetWs = str(
            deployment.get("ProxyTargetWs")
            or actionData.get("proxyTargetWs")
            or "ws://127.0.0.1:8765"
        ).strip()
        dbConfig = self._readAdminDbConfig(actionData)
        dbHost = str(
            deployment.get("DatabaseHost")
            or actionData.get("adminDbHost")
            or dbConfig.get("Host")
            or "localhost"
        ).strip()
        dbPort = int(
            deployment.get("DatabasePort")
            or actionData.get("adminDbPort")
            or dbConfig.get("Port")
            or 5432
        )
        dbName = str(
            deployment.get("DatabaseName")
            or actionData.get("adminDbName")
            or dbConfig.get("DatabaseName")
            or "iobeam_admin"
        ).strip()
        dbUser = str(
            deployment.get("DatabaseUser")
            or actionData.get("adminDbUser")
            or dbConfig.get("User")
            or "iobeam_admin_app"
        ).strip()
        dbPassword = str(
            deployment.get("DatabasePassword")
            or actionData.get("adminDbPassword")
            or dbConfig.get("Password")
            or ""
        ).strip()
        dbSslMode = str(
            deployment.get("DatabaseSslMode")
            or actionData.get("adminDbSslMode")
            or dbConfig.get("SslMode")
            or ""
        ).strip()
        dbTimeout = int(
            deployment.get("DatabaseCommandTimeoutMs")
            or actionData.get("adminDbCommandTimeoutMs")
            or dbConfig.get("CommandTimeoutMs")
            or 30000
        )
        opDbHost = str(
            actionData.get("operationDbHost")
            or dbConfig.get("Host")
            or dbHost
        ).strip()
        opDbPort = int(
            actionData.get("operationDbPort")
            or dbConfig.get("Port")
            or dbPort
        )
        opDbName = str(
            actionData.get("operationDbName")
            or "operation_data"
        ).strip()
        opDbUser = str(
            actionData.get("operationDbUser")
            or dbConfig.get("User")
            or dbUser
        ).strip()
        opDbPassword = str(
            actionData.get("operationDbPassword")
            or dbConfig.get("Password")
            or dbPassword
        ).strip()
        opDbSslMode = str(
            actionData.get("operationDbSslMode")
            or dbConfig.get("SslMode")
            or dbSslMode
        ).strip()
        opDbTimeout = int(
            actionData.get("operationDbCommandTimeoutMs")
            or dbConfig.get("CommandTimeoutMs")
            or dbTimeout
        )
        lines = [
            "PROXY_TARGET_HTTP={}".format(proxyTargetHttp),
            "PROXY_TARGET_WS={}".format(proxyTargetWs),
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
            "IOBEAM_ADMIN_DB_PORT={}".format(dbPort),
            "IOBEAM_ADMIN_DB_NAME={}".format(dbName),
            "IOBEAM_ADMIN_DB_USER={}".format(dbUser),
        ]
        if dbPassword:
            lines.append("IOBEAM_ADMIN_DB_PASSWORD={}".format(dbPassword))
        if dbSslMode:
            lines.append("IOBEAM_ADMIN_DB_SSLMODE={}".format(dbSslMode))
        lines.append("IOBEAM_ADMIN_DB_COMMAND_TIMEOUT_MS={}".format(dbTimeout))
        lines.extend([
            "IOBEAM_OPERATION_DB_HOST={}".format(opDbHost),
            "IOBEAM_OPERATION_DB_PORT={}".format(opDbPort),
            "IOBEAM_OPERATION_DB_NAME={}".format(opDbName),
            "IOBEAM_OPERATION_DB_USER={}".format(opDbUser),
        ])
        if opDbPassword:
            lines.append("IOBEAM_OPERATION_DB_PASSWORD={}".format(opDbPassword))
        if opDbSslMode:
            lines.append("IOBEAM_OPERATION_DB_SSLMODE={}".format(opDbSslMode))
        lines.append("IOBEAM_OPERATION_DB_COMMAND_TIMEOUT_MS={}".format(opDbTimeout))
        lines.extend([
            "GLASGOW_RESTART_CMD={}".format(
                os.path.join(backendDir, "scripts", "restart-glasgow-service.sh")),
            "IONBEAM_BACKEND_RESTART_CMD={}".format(
                os.path.join(backendDir, "scripts", "restart-ionbeam-backend.sh")),
            "IONBEAM_MOBILITY_ONLY={}".format(
                "1" if self.deploymentValue("MobilityOnly", False) else "0"),
            "GLASGOW_PROJECT_ROOT={}".format(deployRoot),
            "GLASGOW_CONFIG_STRICT=0",
            "",
        ])
        with open(envFile, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        self.info("[{}] wrote deployment backend env: {}"
                  .format(type(self).__name__, envFile))

    def _readAdminDbConfig(self, actionData):
        configFile = actionData.get(
            "adminDbConfigFile", "Development/IobeamAdmin/Json/IobeamAdminDb.json")
        configPath = self.resolveDeployPath(configFile)
        try:
            with open(configPath, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return {}
            db = data.get("Database")
            return db if isinstance(db, dict) else data
        except Exception as e:
            self.warn("[{}] could not read DB config from {}: {}"
                      .format(type(self).__name__, configPath, e))
            return {}

    def _wrapNodeCommand(self, cmd, useNvm):
        if not useNvm:
            return cmd
        return (
            "bash -lc 'export NVM_DIR=\"$HOME/.nvm\" && "
            "if [ -s \"$NVM_DIR/nvm.sh\" ]; then . \"$NVM_DIR/nvm.sh\"; fi; {}'"
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
