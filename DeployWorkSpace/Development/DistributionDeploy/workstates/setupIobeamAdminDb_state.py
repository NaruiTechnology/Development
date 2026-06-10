import asyncio
import json
import os
import secrets
from urllib.parse import quote

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
            stateConfig = self.resolvedStateConfig(stateConfig)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)
            deployment = self.deploymentConfig()

            dbName = str(
                deployment.get("DatabaseName")
                or actionData.get("databaseName")
                or "iobeam_admin"
            ).strip()
            dbHost = str(
                deployment.get("DatabaseHost")
                or actionData.get("databaseHost")
                or "localhost"
            ).strip()
            dbRole = str(
                deployment.get("DatabaseUser")
                or actionData.get("databaseRole")
                or actionData.get("adminDbUser")
                or "iobeam_admin_app"
            ).strip()
            dbPassword = str(
                deployment.get("DatabasePassword")
                or actionData.get("adminDbPassword")
                or ""
            ).strip()
            dbOwnerRole = str(
                deployment.get("DatabaseOwnerRole")
                or actionData.get("databaseOwnerRole")
                or "iobeam_admin_owner"
            ).strip()
            dbConfigFile = self.resolveDeployPath(actionData.get(
                "adminDbConfigFile", "Development/IobeamAdmin/Json/IobeamAdminDb.json"))
            dbPassword = dbPassword or self._readDbPassword(dbConfigFile) or ""
            if not dbPassword and self._isLocalHost(dbHost):
                dbPassword = self._generatePassword()
            dbMemberRoles = self._databaseOwnerMembers(actionData, dbRole)
            dbReadRoles = self._databaseReadMembers(actionData, dbMemberRoles)
            schemaFile = self._resolveSqlFile(actionData.get(
                "schemaFile", "Development/IobeamAdmin/Sql/001_schema.sql"))
            seedFile = self._resolveSqlFile(actionData.get(
                "seedFile", "Development/IobeamAdmin/Sql/002_seed_root_user.sql"))

            if not await self._ensureVboxUser(timeout):
                self._success = False
                return

            isLocalDb = self._isLocalHost(dbHost)
            if isLocalDb:
                if not await self._ensurePostgreSQLInstalled(timeout, actionData):
                    self._success = False
                    return

            if isLocalDb:
                if not await self._ensureDatabase(dbName, timeout):
                    self._success = False
                    return

                if not await self._ensureOwnerRoleAndMembership(dbName, dbOwnerRole, dbMemberRoles, timeout):
                    self._success = False
                    return

                if not await self._ensureDatabaseAccess(dbName, dbOwnerRole, dbMemberRoles + dbReadRoles, timeout):
                    self._success = False
                    return

                for roleName in dbMemberRoles:
                    rolePassword = dbPassword if roleName == dbRole else None
                    if not await self._ensureRoleAndGrants(dbName, roleName, timeout, dbOwnerRole, rolePassword):
                        self._success = False
                        return

            if not self._writeDbConfig(dbConfigFile, dbName, dbHost, dbRole, dbPassword, actionData):
                self._success = False
                return

            if isLocalDb:
                if not await self._assignAdminOwnership(dbName, dbOwnerRole, timeout):
                    self._success = False
                    return

                if not await self._loadSchema(dbName, schemaFile, seedFile, timeout):
                    self._success = False
                    return

                if not await self._assignAdminOwnership(dbName, dbOwnerRole, timeout):
                    self._success = False
                    return

                for roleName in dbMemberRoles:
                    rolePassword = dbPassword if roleName == dbRole else None
                    if not await self._ensureRoleAndGrants(dbName, roleName, timeout, dbOwnerRole, rolePassword):
                        self._success = False
                        return

                for roleName in dbReadRoles:
                    if not await self._ensureReadRoleAndGrants(dbName, roleName, timeout):
                        self._success = False
                        return
            else:
                self.info("[{}] remote DB host detected; skipping local PostgreSQL provisioning and schema load."
                          .format(type(self).__name__))

            if not await self._verifyRuntimeRoleCanConnect(dbName, dbHost, dbRole, dbPassword, timeout, actionData):
                self._success = False
                return

            self._success = True
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    async def _ensureVboxUser(self, timeout):
        cmd = ["getent", "passwd"]
        self.info("[{}][ensure-vboxuser] >> {}".format(type(self).__name__, " ".join(cmd)))
        ok, stdout, stderr = await self._runExec(cmd, timeout)
        if not ok:
            self.error("[{}][ensure-vboxuser] failed to list local users.\n{}"
                       .format(type(self).__name__, stderr or "<no stderr>"))
            return False

        users = []
        for line in stdout.splitlines():
            name = line.split(":", 1)[0].strip()
            if name:
                users.append(name)
        self.info("[{}][ensure-vboxuser] local users: {}"
                  .format(type(self).__name__, ", ".join(users) or "<none>"))

        if "vboxuser" in users:
            self.info("[{}][ensure-vboxuser] user 'vboxuser' already exists."
                      .format(type(self).__name__))
            return True

        createCmd = (
            "sudo useradd -m -G sudo vboxuser && "
            "sudo usermod -a -G plugdev vboxuser"
        )
        self.info("[{}][ensure-vboxuser] >> {}".format(type(self).__name__, createCmd))
        ok, _, stderr = await self._runExec(["bash", "-lc", createCmd], timeout)
        if not ok:
            self.error("[{}][ensure-vboxuser] failed to create 'vboxuser'.\n{}"
                       .format(type(self).__name__, stderr or "<no stderr>"))
            return False

        self.info("[{}][ensure-vboxuser] created 'vboxuser' and added sudo/plugdev groups."
                  .format(type(self).__name__))
        return True

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

    async def _ensurePostgreSQLInstalled(self, timeout, actionData):
        check = ["bash", "-lc", "command -v psql >/dev/null 2>&1"]
        ok, _, _ = await self._runExec(check, timeout)
        if ok:
            self.info("[{}][install-db] PostgreSQL client already installed.".format(
                type(self).__name__))
            return True

        installCmd = actionData.get(
            "installCommand",
            "sudo apt-get update && sudo apt-get install -y postgresql postgresql-contrib postgresql-client dbeaver-ce || sudo apt-get install -y postgresql postgresql-contrib postgresql-client"
        )
        cmd = ["bash", "-lc", installCmd]
        self.info("[{}][install-db] >> {}".format(type(self).__name__, installCmd))
        ok, _, stderr = await self._runExec(cmd, timeout)
        if not ok:
            self.error("[{}][install-db] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False

        enableCmd = ["bash", "-lc", "sudo systemctl enable --now postgresql"]
        ok, _, stderr = await self._runExec(enableCmd, timeout)
        if not ok:
            self.error("[{}][install-db] service start FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False
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

    async def _ensureOwnerRoleAndMembership(self, dbName, ownerRole, memberRoles, timeout):
        if not ownerRole:
            self.error("[{}][ensure-owner] no database owner role name available".format(
                type(self).__name__))
            return False

        sql = self._ownerRoleSql(dbName, ownerRole, memberRoles)
        cmd = ["sudo", "-u", "postgres", "psql", "-d", dbName, "-v", "ON_ERROR_STOP=1"]
        self.info("[{}][ensure-owner] >> {} < SQL".format(type(self).__name__, " ".join(cmd)))
        ok, _, stderr = await self._runExec(cmd, timeout, sql)
        if not ok:
            self.error("[{}][ensure-owner] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False
        self.info("[{}][ensure-owner] ensured owner role '{}' for members: {}".format(
            type(self).__name__, ownerRole, ", ".join(memberRoles)))
        return True

    async def _ensureDatabaseAccess(self, dbName, ownerRole, roleNames, timeout):
        sql = self._databaseAccessSql(dbName, ownerRole, roleNames)
        cmd = ["sudo", "-u", "postgres", "psql", "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
        self.info("[{}][database-access] >> {} < SQL".format(type(self).__name__, " ".join(cmd)))
        ok, _, stderr = await self._runExec(cmd, timeout, sql)
        if not ok:
            self.error("[{}][database-access] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False
        self.info("[{}][database-access] ensured database owner and CONNECT grants for '{}'."
                  .format(type(self).__name__, dbName))
        return True

    async def _assignAdminOwnership(self, dbName, ownerRole, timeout):
        if not ownerRole:
            return True
        sql = self._assignOwnershipSql(ownerRole)
        cmd = ["sudo", "-u", "postgres", "psql", "-d", dbName, "-v", "ON_ERROR_STOP=1"]
        self.info("[{}][assign-owner] >> {} < SQL".format(type(self).__name__, " ".join(cmd)))
        ok, _, stderr = await self._runExec(cmd, timeout, sql)
        if not ok:
            self.error("[{}][assign-owner] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False
        self.info("[{}][assign-owner] transferred iobeam_admin object ownership to '{}'.".format(
            type(self).__name__, ownerRole))
        return True

    async def _ensureRoleAndGrants(self, dbName, roleName, timeout, ownerRole=None, password=None):
        roleName = str(roleName or "").strip()
        if not roleName:
            self.error("[{}][ensure-role] no database role name available".format(
                type(self).__name__))
            return False

        sql = self._roleGrantSql(dbName, roleName, ownerRole, password)
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

    async def _ensureReadRoleAndGrants(self, dbName, roleName, timeout):
        roleName = str(roleName or "").strip()
        if not roleName:
            return True

        sql = self._readRoleGrantSql(dbName, roleName)
        grantRole = ["sudo", "-u", "postgres", "psql", "-d", dbName, "-v", "ON_ERROR_STOP=1"]
        self.info("[{}][ensure-read-role] >> {} < SQL".format(
            type(self).__name__, " ".join(grantRole)))
        ok, _, stderr = await self._runExec(grantRole, timeout, sql)
        if not ok:
            self.error("[{}][ensure-read-role] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False

        self.info("[{}][ensure-read-role] ensured PostgreSQL role '{}' and read grants.".format(
            type(self).__name__, roleName))
        return True

    async def _verifyRuntimeRoleCanConnect(self, dbName, dbHost, dbRole, dbPassword, timeout, actionData):
        deployment = self.deploymentConfig()
        dbPort = int(
            deployment.get("DatabasePort")
            or actionData.get("databasePort")
            or actionData.get("adminDbPort")
            or 5432
        )
        sslMode = str(
            deployment.get("DatabaseSslMode")
            or actionData.get("adminDbSslMode")
            or ""
        ).strip()
        host = str(
            deployment.get("DatabaseHost")
            or actionData.get("adminDbHost")
            or dbHost
            or "localhost"
        ).strip()
        if host in ("", "/var/run/postgresql"):
            host = "localhost"

        command = (
            "{}{} psql -h {} -p {} -U {} -d {} -Atqc {}".format(
                "PGSSLMODE={} ".format(self._shellQuote(sslMode)) if sslMode else "",
                "PGPASSWORD={} ".format(self._shellQuote(dbPassword)),
                self._shellQuote(host),
                self._shellQuote(str(dbPort)),
                self._shellQuote(dbRole),
                self._shellQuote(dbName),
                self._shellQuote("SELECT current_user || ':' || current_database();"),
            )
        )
        cmd = ["bash", "-lc", command]
        self.info("[{}][verify-runtime-role] >> psql -h {} -p {} -U {} -d {}"
                  .format(type(self).__name__, host, dbPort, dbRole, dbName))
        ok, stdout, stderr = await self._runExec(cmd, timeout)
        if not ok:
            self.error("[{}][verify-runtime-role] FAILED.\n{}".format(
                type(self).__name__, stderr or "<no stderr>"))
            return False
        self.info("[{}][verify-runtime-role] OK: {}".format(
            type(self).__name__, stdout.strip() or "<connected>"))
        return True

    def _readDbPassword(self, configFile):
        try:
            with open(configFile, "r", encoding="utf-8") as f:
                data = json.load(f)
            db = data.get("Database") if isinstance(data.get("Database"), dict) else data
            return str(db.get("Password") or db.get("password") or "").strip()
        except Exception:
            return ""

    def _generatePassword(self):
        return secrets.token_urlsafe(32)

    def _writeDbConfig(self, configFile, dbName, dbHost, dbRole, dbPassword, actionData):
        deployment = self.deploymentConfig()
        dbPort = int(
            deployment.get("DatabasePort")
            or actionData.get("databasePort")
            or actionData.get("adminDbPort")
            or 5432
        )
        host = str(
            deployment.get("DatabaseHost")
            or actionData.get("adminDbHost")
            or dbHost
            or "localhost"
        ).strip()
        if host in ("", "/var/run/postgresql"):
            host = "localhost"
        sslMode = str(
            actionData.get("adminDbSslMode")
            or deployment.get("DatabaseSslMode")
            or ""
        ).strip()
        commandTimeoutMs = int(
            actionData.get("adminDbCommandTimeoutMs")
            or deployment.get("DatabaseCommandTimeoutMs")
            or 30000
        )
        connectionString = "postgresql://{}:{}@{}:{}/{}".format(
            quote(dbRole, safe=""),
            quote(dbPassword, safe=""),
            host,
            dbPort,
            quote(dbName, safe=""),
        )
        if sslMode:
            connectionString = "{}?sslmode={}".format(connectionString, quote(sslMode, safe=""))
        data = {
            "Provider": "PostgreSQL",
            "DatabaseName": dbName,
            "Schema": "iobeam_admin",
            "Host": host,
            "Port": dbPort,
            "User": dbRole,
            "Password": dbPassword,
            "ConnectionString": connectionString,
            "SslMode": sslMode,
            "CommandTimeoutMs": commandTimeoutMs,
        }
        try:
            os.makedirs(os.path.dirname(configFile), exist_ok=True)
            with open(configFile, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
                f.write("\n")
            self.info("[{}][db-config] wrote runtime DB config for role '{}' to {}"
                      .format(type(self).__name__, dbRole, configFile))
            return True
        except OSError as e:
            self.error("[{}][db-config] cannot write {}: {}"
                       .format(type(self).__name__, configFile, e))
            return False

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

    def _isLocalHost(self, host):
        return host in ("", "localhost", "127.0.0.1", "::1", "/var/run/postgresql")

    def _databaseOwnerMembers(self, actionData, installerRole):
        roles = []
        for roleName in [installerRole] + list(actionData.get("databaseOwnerMembers", []) or []):
            roleName = str(roleName or "").strip()
            if roleName and roleName not in roles:
                roles.append(roleName)

        adminConfigPath = actionData.get(
            "adminConfigFile", "Development/IobeamAdmin/Json/IobeamAdmin.json")
        adminConfigPath = self.resolveDeployPath(adminConfigPath)
        try:
            with open(adminConfigPath, "r", encoding="utf-8") as f:
                adminConfig = json.load(f)
            auditors = adminConfig.get("auditors")
            if not isinstance(auditors, list):
                auditor = adminConfig.get("auditor")
                auditors = [auditor] if isinstance(auditor, dict) else []
            for auditor in auditors:
                if not isinstance(auditor, dict) or auditor.get("is_active") is False:
                    continue
                roleName = str(auditor.get("db_role") or auditor.get("email") or "").strip()
                if roleName and roleName not in roles:
                    roles.append(roleName)
        except Exception as e:
            self.warn("[{}][ensure-owner] could not read auditor DB roles from {}: {}"
                      .format(type(self).__name__, adminConfigPath, e))

        return roles

    def _databaseReadMembers(self, actionData, fullGrantRoles):
        fullGrantRoles = set(str(roleName or "").strip() for roleName in fullGrantRoles)
        roles = []
        for roleName in list(actionData.get("databaseReadRoles", []) or []):
            roleName = str(roleName or "").strip()
            if roleName and roleName not in fullGrantRoles and roleName not in roles:
                roles.append(roleName)

        adminConfigPath = actionData.get(
            "adminConfigFile", "Development/IobeamAdmin/Json/IobeamAdmin.json")
        adminConfigPath = self.resolveDeployPath(adminConfigPath)
        try:
            with open(adminConfigPath, "r", encoding="utf-8") as f:
                adminConfig = json.load(f)
            users = adminConfig.get("users")
            if not isinstance(users, list):
                user = adminConfig.get("user")
                users = [user] if isinstance(user, dict) else []
            for user in users:
                if not isinstance(user, dict) or user.get("is_active") is False:
                    continue
                roleName = str(user.get("db_role") or user.get("login_name") or "").strip()
                if roleName and roleName not in fullGrantRoles and roleName not in roles:
                    roles.append(roleName)
        except Exception as e:
            self.warn("[{}][ensure-read-role] could not read user DB roles from {}: {}"
                      .format(type(self).__name__, adminConfigPath, e))

        return roles

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

    def _ownerRoleSql(self, dbName, ownerRole, memberRoles):
        ownerIdent = self._quoteIdent(ownerRole)
        ownerLiteral = self._quoteLiteral(ownerRole)
        lines = [
            "DO $$",
            "BEGIN",
            f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {ownerLiteral}) THEN",
            f"    EXECUTE 'CREATE ROLE ' || quote_ident({ownerLiteral}) || ' NOLOGIN';",
            "  END IF;",
            "END",
            "$$;",
            f"CREATE SCHEMA IF NOT EXISTS iobeam_admin AUTHORIZATION {ownerIdent};",
            f"ALTER SCHEMA iobeam_admin OWNER TO {ownerIdent};",
        ]
        for roleName in memberRoles:
            roleIdent = self._quoteIdent(roleName)
            roleLiteral = self._quoteLiteral(roleName)
            lines.extend([
                "DO $$",
                "BEGIN",
                f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {roleLiteral}) THEN",
                f"    EXECUTE 'CREATE ROLE ' || quote_ident({roleLiteral}) || ' LOGIN';",
                "  ELSE",
                f"    EXECUTE 'ALTER ROLE ' || quote_ident({roleLiteral}) || ' LOGIN';",
                "  END IF;",
                "END",
                "$$;",
                f"GRANT {ownerIdent} TO {roleIdent};",
            ])
        return "\n".join(lines)

    def _databaseAccessSql(self, dbName, ownerRole, roleNames):
        dbIdent = self._quoteIdent(dbName)
        ownerIdent = self._quoteIdent(ownerRole)
        lines = [
            f"ALTER DATABASE {dbIdent} OWNER TO {ownerIdent};",
            f"GRANT CONNECT, TEMPORARY ON DATABASE {dbIdent} TO {ownerIdent};",
        ]
        seen = set()
        for roleName in roleNames:
            roleName = str(roleName or "").strip()
            if not roleName or roleName in seen:
                continue
            seen.add(roleName)
            roleIdent = self._quoteIdent(roleName)
            roleLiteral = self._quoteLiteral(roleName)
            lines.extend([
                "DO $$",
                "BEGIN",
                f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {roleLiteral}) THEN",
                f"    EXECUTE 'CREATE ROLE ' || quote_ident({roleLiteral}) || ' LOGIN';",
                "  ELSE",
                f"    EXECUTE 'ALTER ROLE ' || quote_ident({roleLiteral}) || ' LOGIN';",
                "  END IF;",
                "END",
                "$$;",
                f"GRANT CONNECT, TEMPORARY ON DATABASE {dbIdent} TO {roleIdent};",
            ])
        return "\n".join(lines)

    def _assignOwnershipSql(self, ownerRole):
        ownerIdent = self._quoteIdent(ownerRole)
        ownerLiteral = self._quoteLiteral(ownerRole)
        return "\n".join([
            f"ALTER SCHEMA iobeam_admin OWNER TO {ownerIdent};",
            "DO $$",
            "DECLARE",
            "  obj record;",
            "BEGIN",
            "  FOR obj IN",
            "    SELECT format('%I.%I', schemaname, tablename) AS name",
            "      FROM pg_tables",
            "     WHERE schemaname = 'iobeam_admin'",
            "  LOOP",
            f"    EXECUTE 'ALTER TABLE ' || obj.name || ' OWNER TO ' || quote_ident({ownerLiteral});",
            "  END LOOP;",
            "",
            "  FOR obj IN",
            "    SELECT format('%I.%I', sequence_schema, sequence_name) AS name",
            "      FROM information_schema.sequences",
            "     WHERE sequence_schema = 'iobeam_admin'",
            "  LOOP",
            f"    EXECUTE 'ALTER SEQUENCE ' || obj.name || ' OWNER TO ' || quote_ident({ownerLiteral});",
            "  END LOOP;",
            "",
            "  FOR obj IN",
            "    SELECT p.prokind,",
            "           format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS signature",
            "      FROM pg_proc p",
            "      JOIN pg_namespace n ON n.oid = p.pronamespace",
            "     WHERE n.nspname = 'iobeam_admin'",
            "  LOOP",
            "    IF obj.prokind = 'p' THEN",
            f"      EXECUTE 'ALTER PROCEDURE ' || obj.signature || ' OWNER TO ' || quote_ident({ownerLiteral});",
            "    ELSE",
            f"      EXECUTE 'ALTER FUNCTION ' || obj.signature || ' OWNER TO ' || quote_ident({ownerLiteral});",
            "    END IF;",
            "  END LOOP;",
            "END",
            "$$;",
        ])

    def _roleGrantSql(self, dbName, roleName, ownerRole=None, password=None):
        dbIdent = self._quoteIdent(dbName)
        roleIdent = self._quoteIdent(roleName)
        roleLiteral = self._quoteLiteral(roleName)
        lines = [
            "DO $$",
            "BEGIN",
            f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {roleLiteral}) THEN",
            f"    EXECUTE 'CREATE ROLE ' || quote_ident({roleLiteral}) || ' LOGIN';",
            "  ELSE",
            f"    EXECUTE 'ALTER ROLE ' || quote_ident({roleLiteral}) || ' LOGIN';",
            "  END IF;",
            "END",
            "$$;",
        ]
        if password:
            lines.append(f"ALTER ROLE {roleIdent} PASSWORD {self._quoteLiteral(password)};")
        lines.extend([
            f"GRANT CONNECT ON DATABASE {dbIdent} TO {roleIdent};",
            f"GRANT USAGE, CREATE ON SCHEMA public TO {roleIdent};",
            f"GRANT USAGE, CREATE ON SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA iobeam_admin TO {roleIdent};",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {roleIdent};",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {roleIdent};",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT EXECUTE ON FUNCTIONS TO {roleIdent};",
        ])
        if ownerRole:
            lines.append(f"GRANT {self._quoteIdent(ownerRole)} TO {roleIdent};")
        return "\n".join(lines)

    def _readRoleGrantSql(self, dbName, roleName):
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
            f"GRANT USAGE ON SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT SELECT ON ALL TABLES IN SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA iobeam_admin TO {roleIdent};",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT SELECT ON TABLES TO {roleIdent};",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT USAGE, SELECT ON SEQUENCES TO {roleIdent};",
        ])

    def _quoteIdent(self, value):
        return '"' + str(value).replace('"', '""') + '"'

    def _quoteLiteral(self, value):
        return "'" + str(value).replace("'", "''") + "'"

    def _shellQuote(self, value):
        return "'" + str(value).replace("'", "'\"'\"'") + "'"
