import asyncio
import os

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class setupIobeamAdminDb_state(distributionDeploy_state):
    def __init__(self, parent):
        super(setupIobeamAdminDb_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            dbName = actionData.get("databaseName", "iobeam_admin")
            schemaFile = self._resolveSqlFile(actionData.get(
                "schemaFile", "Development/IobeamAdmin/Sql/001_schema.sql"))
            seedFile = self._resolveSqlFile(actionData.get(
                "seedFile", "Development/IobeamAdmin/Sql/002_seed_root_user.sql"))

            if not await self._ensureDatabase(dbName, timeout):
                self._success = False
                return

            if not await self._loadSchema(dbName, schemaFile, seedFile, timeout):
                self._success = False
                return

            self._success = True
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    async def _ensureDatabase(self, dbName, timeout):
        sql = "SELECT 1 FROM pg_database WHERE datname = '{}'".format(
            dbName.replace("'", "''"))
        query = ["sudo", "-u", "postgres", "psql", "-d", "postgres", "-Atqc", sql]
        self.info("[{}][ensure-db] >> {}".format(type(self).__name__, " ".join(query)))
        ok, stdout, stderr = await self._runExec(query, timeout)
        if not ok:
            self.error("[{}][ensure-db] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False

        if stdout.strip() == "1":
            self.info("[{}][ensure-db] '{}' already exists.".format(
                type(self).__name__, dbName))
            return True

        createDb = ["sudo", "-u", "postgres", "createdb", dbName]
        self.info("[{}][ensure-db] >> {}".format(type(self).__name__, " ".join(createDb)))
        ok, _, stderr = await self._runExec(createDb, timeout)
        if not ok:
            self.error("[{}][ensure-db] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False

        self.info("[{}][ensure-db] created '{}'.".format(type(self).__name__, dbName))
        return True

    async def _loadSchema(self, dbName, schemaFile, seedFile, timeout):
        try:
            with open(schemaFile, "r", encoding="utf-8") as f:
                schemaSql = f.read()
            with open(seedFile, "r", encoding="utf-8") as f:
                seedSql = f.read()
        except OSError as e:
            self.error("[{}][load-schema] cannot read SQL file: {}".format(
                type(self).__name__, e))
            return False

        loadSchema = [
            "sudo", "-u", "postgres", "psql",
            "-d", dbName,
            "-v", "ON_ERROR_STOP=1",
        ]
        self.info("[{}][load-schema] >> {} < {} + {}".format(
            type(self).__name__, " ".join(loadSchema), schemaFile, seedFile))
        ok, _, stderr = await self._runExec(
            loadSchema,
            timeout,
            "{}\n{}".format(schemaSql, seedSql),
        )
        if not ok:
            self.error("[{}][load-schema] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False
        self.info("[{}][load-schema] OK".format(type(self).__name__))
        return True

    def _resolveSqlFile(self, configuredPath):
        path = self.resolveDeployPath(configuredPath)
        if os.path.isfile(path):
            return path

        expanded = str(configuredPath or "")
        if not expanded.startswith("Development/"):
            fallback = self.resolveDeployPath(
                os.path.join("Development", expanded))
            if os.path.isfile(fallback):
                self.warn("[{}][load-schema] using SQL file under Development/: {}"
                          .format(type(self).__name__, fallback))
                return fallback
        return path

    async def _runExec(self, argv, timeout, stdin=None):
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=self.resolveDeployPath("."),
            stdin=asyncio.subprocess.PIPE if stdin is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        if timeout and timeout > 0:
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(stdin.encode("utf-8") if stdin is not None else None),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.communicate()
                self.error("[{}] timed out after {}s on: {}"
                           .format(type(self).__name__, timeout, " ".join(argv)))
                return False, "", "timeout"
        else:
            stdout, stderr = await proc.communicate(
                stdin.encode("utf-8") if stdin is not None else None)

        stdoutText = stdout.decode(errors="replace")
        stderrText = stderr.decode(errors="replace")
        if proc.returncode != 0:
            return False, stdoutText, stderrText
        return True, stdoutText, stderrText
