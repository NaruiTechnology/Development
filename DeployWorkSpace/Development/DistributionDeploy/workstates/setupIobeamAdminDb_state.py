import asyncio
import os
import shutil

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
            dbRole = (actionData.get("databaseRole") or
                      os.environ.get("USER") or
                      os.environ.get("LOGNAME") or
                      "postgres")
            schemaFile = self._resolveSqlFile(actionData.get(
                "schemaFile", "Development/IobeamAdmin/Sql/001_schema.sql"))
            seedFile = self._resolveSqlFile(actionData.get(
                "seedFile", "Development/IobeamAdmin/Sql/002_seed_root_user.sql"))
            dbSettings = self._dbSettings(actionData)

            if not await self._ensureDatabase(dbName, dbSettings, timeout):
                self._success = False
                return

            if not await self._loadSchema(dbName, dbSettings, schemaFile, seedFile, timeout):
                self._success = False
                return

            if not await self._ensureRoleAndGrants(dbName, dbRole, timeout):
                self._success = False
                return

            self._success = True
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    async def _ensureDatabase(self, dbName, dbSettings, timeout):
        sql = "SELECT 1 FROM pg_database WHERE datname = '{}'".format(
            dbName.replace("'", "''"))
        query = self._psqlCommand("postgres", dbSettings) + ["-Atqc", sql]
        self.info("[{}][ensure-db] >> {}".format(type(self).__name__, " ".join(query)))
        ok, stdout, stderr = await self._runExec(query, timeout, env=dbSettings["env"])
        if not ok:
            self.error("[{}][ensure-db] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False

        if stdout.strip() == "1":
            self.info("[{}][ensure-db] '{}' already exists.".format(
                type(self).__name__, dbName))
            return True

        createSql = "CREATE DATABASE {};".format(self._quoteIdentifier(dbName))
        createDb = self._psqlCommand("postgres", dbSettings) + ["-v", "ON_ERROR_STOP=1", "-c", createSql]
        self.info("[{}][ensure-db] >> {}".format(type(self).__name__, " ".join(createDb)))
        ok, _, stderr = await self._runExec(createDb, timeout, env=dbSettings["env"])
        if not ok:
            self.error("[{}][ensure-db] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False

        self.info("[{}][ensure-db] created '{}'.".format(type(self).__name__, dbName))
        return True

    async def _loadSchema(self, dbName, dbSettings, schemaFile, seedFile, timeout):
        try:
            with open(schemaFile, "r", encoding="utf-8") as f:
                schemaSql = f.read()
            with open(seedFile, "r", encoding="utf-8") as f:
                seedSql = f.read()
        except OSError as e:
            self.error("[{}][load-schema] cannot read SQL file: {}".format(
                type(self).__name__, e))
            return False

        loadSchema = self._psqlCommand(dbName, dbSettings) + ["-v", "ON_ERROR_STOP=1"]
        self.info("[{}][load-schema] >> {} < {} + {}".format(
            type(self).__name__, " ".join(loadSchema), schemaFile, seedFile))
        ok, _, stderr = await self._runExec(
            loadSchema,
            timeout,
            "{}\n{}".format(schemaSql, seedSql),
            env=dbSettings["env"],
        )
        if not ok:
            self.error("[{}][load-schema] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False
        self.info("[{}][load-schema] OK".format(type(self).__name__))
        return True

    async def _ensureRoleAndGrants(self, dbName, roleName, timeout):
        roleName = str(roleName or "").strip()
        if not roleName:
            self.error("[{}][ensure-role] no database role name available".format(
                type(self).__name__))
            return False

        sql = self._roleGrantSql(dbName, roleName)
        grantRole = ["sudo", "-u", "postgres", "psql", "-d", dbName, "-v", "ON_ERROR_STOP=1"]
        self.info("[{}][ensure-role] >> {} < SQL".format(
            type(self).__name__, " ".join(grantRole)))
        ok, _, stderr = await self._runExec(grantRole, timeout, sql)
        if not ok:
            self.error("[{}][ensure-role] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False

        self.info("[{}][ensure-role] ensured PostgreSQL role '{}' and grants.".format(
            type(self).__name__, roleName))
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

    def _dbSettings(self, actionData):
        env = os.environ.copy()
        password = str(actionData.get("dbPassword") or env.get("IOBEAM_ADMIN_DB_PASSWORD") or "")
        if password:
            env["PGPASSWORD"] = password
        return {
            "host": str(actionData.get("dbHost") or env.get("IOBEAM_ADMIN_DB_HOST") or "localhost"),
            "port": str(actionData.get("dbPort") or env.get("IOBEAM_ADMIN_DB_PORT") or "5432"),
            "user": str(actionData.get("dbUser") or env.get("IOBEAM_ADMIN_DB_USER") or "postgres"),
            "env": env,
        }

    def _psqlCommand(self, database, dbSettings):
        return [
            self._resolvePsql(),
            "-h", dbSettings["host"],
            "-p", dbSettings["port"],
            "-U", dbSettings["user"],
            "-d", database,
        ]

    def _resolvePsql(self):
        found = shutil.which("psql")
        if found:
            return found
        if os.name == "nt":
            roots = [
                os.environ.get("ProgramFiles"),
                os.environ.get("ProgramFiles(x86)"),
            ]
            for root in [r for r in roots if r]:
                pgRoot = os.path.join(root, "PostgreSQL")
                if not os.path.isdir(pgRoot):
                    continue
                for version in sorted(os.listdir(pgRoot), key=self._versionKey, reverse=True):
                    candidate = os.path.join(pgRoot, version, "bin", "psql.exe")
                    if os.path.isfile(candidate):
                        return candidate
        return "psql"

    @staticmethod
    def _versionKey(value):
        parts = []
        for part in str(value).replace("-", ".").split("."):
            parts.append(int(part) if part.isdigit() else part)
        return parts

    @staticmethod
    def _quoteIdentifier(value):
        return '"{}"'.format(str(value).replace('"', '""'))

    async def _runExec(self, argv, timeout, stdin=None, env=None):
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=self.resolveDeployPath("."),
            env=env,
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

    def _roleGrantSql(self, dbName, roleName):
        dbIdent = self._quoteIdent(dbName)
        roleIdent = self._quoteIdent(roleName)
        roleLiteral = self._quoteLiteral(roleName)
        return "\n".join([
            "DO $$",
            "BEGIN",
            f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {roleLiteral}) THEN",
            f"    EXECUTE 'CREATE ROLE ' || quote_ident({roleLiteral}) || ' LOGIN';",
            "  ELSE",
            f"    EXECUTE 'ALTER ROLE ' || quote_ident({roleLiteral}) || ' LOGIN';",
            "  END IF;",
            "END",
            "$$;",
            f"GRANT CONNECT ON DATABASE {dbIdent} TO {roleIdent};",
            f"GRANT USAGE, CREATE ON SCHEMA public TO {roleIdent};",
            f"GRANT USAGE, CREATE ON SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA iobeam_admin TO {roleIdent};",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {roleIdent};",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {roleIdent};",
        ])

    def _quoteIdent(self, value):
        return '"' + str(value).replace('"', '""') + '"'

    def _quoteLiteral(self, value):
        return "'" + str(value).replace("'", "''") + "'"
