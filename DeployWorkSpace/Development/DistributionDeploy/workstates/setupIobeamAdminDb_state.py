import asyncio
import json
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
            dbRole = (actionData.get("databaseRole") or
                      os.environ.get("SUDO_USER") or
                      os.environ.get("USER") or
                      os.environ.get("LOGNAME") or
                      "postgres")
            dbOwnerRole = str(actionData.get("databaseOwnerRole", "iobeam_admin_owner") or
                              "iobeam_admin_owner").strip()
            dbMemberRoles = self._databaseOwnerMembers(actionData, dbRole)
            schemaFile = self._resolveSqlFile(actionData.get(
                "schemaFile", "Development/IobeamAdmin/Sql/001_schema.sql"))
            seedFile = self._resolveSqlFile(actionData.get(
                "seedFile", "Development/IobeamAdmin/Sql/002_seed_root_user.sql"))

            if not await self._ensureDatabase(dbName, timeout):
                self._success = False
                return

            if not await self._ensureOwnerRoleAndMembership(dbName, dbOwnerRole, dbMemberRoles, timeout):
                self._success = False
                return

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
                if not await self._ensureRoleAndGrants(dbName, roleName, timeout, dbOwnerRole):
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

    async def _ensureRoleAndGrants(self, dbName, roleName, timeout, ownerRole=None):
        roleName = str(roleName or "").strip()
        if not roleName:
            self.error("[{}][ensure-role] no database role name available".format(
                type(self).__name__))
            return False

        sql = self._roleGrantSql(dbName, roleName, ownerRole)
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

    def _roleGrantSql(self, dbName, roleName, ownerRole=None):
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
            f"GRANT CONNECT ON DATABASE {dbIdent} TO {roleIdent};",
            f"GRANT USAGE, CREATE ON SCHEMA public TO {roleIdent};",
            f"GRANT USAGE, CREATE ON SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA iobeam_admin TO {roleIdent};",
            f"GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA iobeam_admin TO {roleIdent};",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {roleIdent};",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA iobeam_admin GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {roleIdent};",
        ]
        if ownerRole:
            lines.append(f"GRANT {self._quoteIdent(ownerRole)} TO {roleIdent};")
        return "\n".join(lines)

    def _quoteIdent(self, value):
        return '"' + str(value).replace('"', '""') + '"'

    def _quoteLiteral(self, value):
        return "'" + str(value).replace("'", "''") + "'"
