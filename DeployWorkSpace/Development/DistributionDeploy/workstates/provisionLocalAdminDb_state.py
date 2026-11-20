"""Provision the optional local admin DB and refresh it from the remote DB."""
import json
import os
import tempfile
from urllib.parse import parse_qs, unquote, urlsplit

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .setupIobeamAdminDb_state import setupIobeamAdminDb_state


class provisionLocalAdminDb_state(setupIobeamAdminDb_state):
    """Create the local fallback database without blocking the deployment."""

    def deploymentConfig(self):
        # Reuse the provisioning implementation, but pin its target to the
        # local PostgreSQL service even when the primary admin DB is remote.
        deployment = dict(super(provisionLocalAdminDb_state, self).deploymentConfig())
        stateConfig = self.ParentWorkThread.GetStateConfig(self) or {}
        actionData = stateConfig.get(Consts.ACTION_DATA, {}) or {}
        deployment["DatabaseHost"] = "localhost"
        deployment["DatabaseName"] = actionData.get("localDatabaseName", "iobeam_admin")
        deployment["DatabaseUser"] = actionData.get("databaseRole", "iobeam_admin_app")
        deployment.pop("DatabasePassword", None)
        return deployment

    @overrides(setupIobeamAdminDb_state)
    async def DoWork(self):
        stateConfig = self.ParentWorkThread.GetStateConfig(self)
        actionData = dict(stateConfig.get(Consts.ACTION_DATA, {}) or {})
        self._localFallbackProvisioned = False
        await super(provisionLocalAdminDb_state, self).DoWork()

        if not self._success:
            return
        if not self._localFallbackProvisioned:
            self.warn("[{}] local admin DB is unavailable; continuing the remaining installation steps."
                      .format(type(self).__name__))
            return
        try:
            await self._syncFromRemote(actionData, float(stateConfig.get(Consts.TIMEOUT, 0) or 0))
        except Exception as exc:
            self.warn("[{}][sync] remote refresh failed; keeping the local fallback and continuing: {}"
                      .format(type(self).__name__, exc))

    async def _provisionLocalDatabase(self, dbName, dbRole, dbPassword, ownerRole,
                                      memberRoles, readRoles, schemaFile, seedFile,
                                      timeout, actionData):
        """Attempt local setup, but let the installer continue if it fails."""
        try:
            self._localFallbackProvisioned = await super(
                provisionLocalAdminDb_state, self
            )._provisionLocalDatabase(
                dbName, dbRole, dbPassword, ownerRole, memberRoles, readRoles,
                schemaFile, seedFile, timeout, actionData,
            )
        except Exception as exc:
            self._localFallbackProvisioned = False
            self.warn("[{}] local admin DB provisioning failed; continuing installation: {}"
                      .format(type(self).__name__, exc))
        if not self._localFallbackProvisioned:
            self.warn("[{}] local admin DB provisioning did not complete; continuing installation."
                      .format(type(self).__name__))
        return True

    async def _provisionLocalDatabase(self, dbName, dbRole, dbPassword, ownerRole,
                                      memberRoles, readRoles, schemaFile, seedFile,
                                      timeout, actionData):
        """Install PostgreSQL if needed, then provision the local fallback."""
        if not await self._ensurePostgreSQLInstalled(timeout, actionData):
            return False
        if not await self._ensureDatabase(dbName, timeout):
            return False
        if not await self._ensureOwnerRoleAndMembership(dbName, ownerRole, memberRoles, timeout):
            return False
        if not await self._ensureDatabaseAccess(dbName, ownerRole, memberRoles + readRoles, timeout):
            return False
        for roleName in memberRoles:
            rolePassword = dbPassword if roleName == dbRole else None
            if not await self._ensureRoleAndGrants(
                    dbName, roleName, timeout, ownerRole, rolePassword):
                return False
        if not await self._assignAdminOwnership(dbName, ownerRole, timeout):
            return False
        if not await self._loadSchema(dbName, schemaFile, seedFile, timeout):
            return False
        if not await self._assignAdminOwnership(dbName, ownerRole, timeout):
            return False
        for roleName in memberRoles:
            rolePassword = dbPassword if roleName == dbRole else None
            if not await self._ensureRoleAndGrants(
                    dbName, roleName, timeout, ownerRole, rolePassword):
                return False
        for roleName in readRoles:
            if not await self._ensureReadRoleAndGrants(dbName, roleName, timeout):
                return False
        return True

    async def _syncFromRemote(self, actionData, timeout):
        if not actionData.get("syncFromRemote", True):
            self.info("[{}] remote database sync disabled.".format(type(self).__name__))
            return

        configPath = self.resolveDeployPath(actionData.get(
            "adminConfigFile", "Development/IobeamAdmin/Json/IobeamAdmin.json"))
        try:
            with open(configPath, "r", encoding="utf-8") as stream:
                config = json.load(stream)
            remote = self.expandSecrets(config.get("Database", {}))
        except Exception as exc:
            self.warn("[{}] cannot read remote DB settings; keeping the local seed: {}"
                      .format(type(self).__name__, exc))
            return

        connectionString = str(remote.get("ConnectionString") or "").strip()
        parsed = urlsplit(connectionString) if connectionString else None
        if parsed and parsed.scheme not in ("postgres", "postgresql"):
            self.warn("[{}] remote DB connection string has an unsupported scheme; keeping local seed."
                      .format(type(self).__name__))
            return
        query = parse_qs(parsed.query) if parsed else {}
        host = str(remote.get("Host") or (parsed.hostname if parsed else "") or "").strip()
        user = str(remote.get("User") or (unquote(parsed.username) if parsed and parsed.username else "")).strip()
        password = str(remote.get("Password") or (unquote(parsed.password) if parsed and parsed.password else ""))
        database = str(remote.get("DatabaseName") or
                       (unquote(parsed.path.lstrip("/")) if parsed else "")).strip()
        if not host or self._isLocalHost(host) or not user or not database:
            self.info("[{}] no remote database configured; keeping the local seed."
                      .format(type(self).__name__))
            return

        port = str(remote.get("Port") or (parsed.port if parsed and parsed.port else 5432))
        sslMode = str(remote.get("SslMode") or next(iter(query.get("sslmode", [])), "")).strip()
        local = self.deploymentConfig()
        localDb = str(local.get("DatabaseName") or "iobeam_admin")
        dumpPath = None
        try:
            fd, dumpPath = tempfile.mkstemp(prefix="iobeam-admin-", suffix=".dump")
            os.fchmod(fd, 0o600)
            os.close(fd)
            env = os.environ.copy()
            env["PGPASSWORD"] = password
            env["PGCONNECT_TIMEOUT"] = str(max(1, min(60, int(timeout or 60))))
            if sslMode:
                env["PGSSLMODE"] = sslMode
            command = [
                "pg_dump", "--no-password", "--format=custom", "--no-owner", "--no-acl",
                "--file", dumpPath, "-h", host, "-p", port, "-U", user, "-d", database,
            ]
            self.info("[{}][sync] exporting remote database {}:{} / {}"
                      .format(type(self).__name__, host, port, database))
            ok, _, stderr = await self._runExec(command, timeout, env=env)
            if not ok:
                self.warn("[{}][sync] remote export failed; keeping the local database: {}"
                          .format(type(self).__name__, stderr or "pg_dump failed"))
                await self._grantLocalAuditorAdminAccess(
                    localDb,
                    str(actionData.get("databaseOwnerRole") or "iobeam_admin_owner"),
                    timeout,
                )
                return

            restore = [
                "sudo", "-u", "postgres", "pg_restore", "--single-transaction",
                "--exit-on-error", "--clean", "--if-exists",
                "--no-owner", "--no-acl", "--dbname", localDb, dumpPath,
            ]
            self.info("[{}][sync] loading remote content into local database '{}'"
                      .format(type(self).__name__, localDb))
            ok, _, stderr = await self._runExec(restore, timeout)
            if not ok:
                self.error("[{}][sync] restore failed: {}".format(
                    type(self).__name__, stderr or "pg_restore failed"))
                self._success = False
                return

            ownerRole = str(actionData.get("databaseOwnerRole") or "iobeam_admin_owner")
            dbRole = str(local.get("DatabaseUser") or "iobeam_admin_app")
            dbPassword = self._readDbPassword(self.resolveDeployPath(actionData.get(
                "adminDbConfigFile", "Development/IobeamAdmin/Json/IobeamAdminDb.json")))
            if not await self._assignAdminOwnership(localDb, ownerRole, timeout):
                self._success = False
                return
            if not await self._ensureDatabaseAccess(localDb, ownerRole, [dbRole], timeout):
                self._success = False
                return
            if not await self._ensureRoleAndGrants(
                    localDb, dbRole, timeout, ownerRole, dbPassword):
                self._success = False
                return
            memberRoles = self._databaseOwnerMembers(actionData, dbRole)
            for roleName in self._databaseReadMembers(actionData, memberRoles):
                if not await self._ensureReadRoleAndGrants(localDb, roleName, timeout):
                    self._success = False
                    return
            if not await self._grantLocalAuditorAdminAccess(localDb, ownerRole, timeout):
                self.warn("[{}][local-auditors] some active auditor accounts may lack local owner access."
                          .format(type(self).__name__))
            self.info("[{}][sync] local database refreshed from remote."
                      .format(type(self).__name__))
        finally:
            if dumpPath and os.path.exists(dumpPath):
                os.remove(dumpPath)

    async def _grantLocalAuditorAdminAccess(self, dbName, ownerRole, timeout):
        """Give active auditor accounts owner-role access to the local fallback."""
        query = [
            "sudo", "-u", "postgres", "psql", "-d", dbName, "-Atq",
            "-v", "ON_ERROR_STOP=1",
            "-c", "SELECT DISTINCT btrim(email) FROM iobeam_admin.auditor "
                  "WHERE is_active IS TRUE AND btrim(email) <> '' ORDER BY 1",
        ]
        try:
            ok, stdout, stderr = await self._runExec(query, timeout)
        except Exception as exc:
            self.warn("[{}][local-auditors] could not query auditor accounts: {}"
                      .format(type(self).__name__, exc))
            return False
        if not ok:
            self.warn("[{}][local-auditors] could not read local auditor accounts: {}"
                      .format(type(self).__name__, stderr or "psql failed"))
            return False

        accounts = list(dict.fromkeys(line.strip() for line in stdout.splitlines() if line.strip()))
        if not accounts:
            self.info("[{}][local-auditors] no active auditor accounts to grant.".format(type(self).__name__))
            return True

        if not await self._ensureDatabaseAccess(dbName, ownerRole, accounts, timeout):
            return False
        if not await self._ensureOwnerRoleAndMembership(dbName, ownerRole, accounts, timeout):
            return False
        for account in accounts:
            if not await self._ensureRoleAndGrants(dbName, account, timeout, ownerRole):
                return False
        self.info("[{}][local-auditors] granted local admin DB owner access to {} active auditor accounts."
                  .format(type(self).__name__, len(accounts)))
        return True
