import asyncio
import json
import os

from .distributionDeploy_state import distributionDeploy_state


class setupIobeamAdminDb_state(distributionDeploy_state):
    """Configure and verify an existing remote database; never provision one."""

    async def DoWork(self):
        self._success = False
        try:
            config = self.ParentWorkThread.GetStateConfig(self) or {}
            data = self.resolvedActionData(config)
            deployment = self.deploymentConfig()
            host = str(deployment.get('DatabaseHost') or '').strip()
            name = str(deployment.get('DatabaseName') or '').strip()
            user = str(deployment.get('DatabaseUser') or '').strip()
            password = deployment.get('DatabasePassword') or ''
            if host.lower() in ('', 'localhost', '127.0.0.1', '::1', '/var/run/postgresql'):
                raise RuntimeError('An existing remote DatabaseHost is required. Local database setup has been removed.')
            if not name or not user or not password:
                raise RuntimeError('Remote DatabaseName, DatabaseUser and DatabasePassword are required; credentials are imported by provisionSecrets.')
            timeout = float(config.get('timeout', 60) or 60)
            if not await self._verifyRuntimeRoleCanConnect(name, host, user, password, timeout, data):
                return
            config_file = self.resolveDeployPath(data.get('adminDbConfigFile', 'Development/IobeamAdmin/Json/IobeamAdminDb.json'))
            self._success = self._writeDbConfig(config_file, name, host, user, password, data)
        except Exception as error:
            self.error('[setupIobeamAdminDb_state] ' + str(error))

    async def _verifyRuntimeRoleCanConnect(self, dbName, dbHost, dbRole, dbPassword, timeout, actionData):
        deployment = self.deploymentConfig()
        env = dict(os.environ, PGHOST=dbHost, PGDATABASE=dbName, PGUSER=dbRole, PGPASSWORD=dbPassword,
                   PGPORT=str(deployment.get('DatabasePort') or actionData.get('databasePort') or 5432),
                   PGSSLMODE=str(deployment.get('DatabaseSslMode') or actionData.get('adminDbSslMode') or 'prefer'))
        venv = self.resolveDeployPath(deployment.get('VenvDir') or '.venv')
        python = os.path.join(venv, 'Scripts', 'python.exe') if os.name == 'nt' else os.path.join(venv, 'bin', 'python')
        # Only SELECT is issued. Credentials stay in the child environment.
        script = """
import os, ssl, sys
import pg8000.native
import scramp
if not callable(getattr(scramp, 'make_channel_binding', None)):
    sys.exit('Incompatible pg8000/Scramp installation: pg8000 1.31.5 requires '
             'scramp.make_channel_binding. Install scramp==1.4.18 in the deployment '
             'venv and rerun deployment.')
mode = os.environ['PGSSLMODE']
context = None
if mode == 'disable':
    context = False
elif mode in ('require', 'verify-ca', 'verify-full'):
    context = ssl.create_default_context()
    if mode == 'verify-ca':
        context.check_hostname = False
    elif mode == 'require':
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
elif mode not in ('prefer', 'allow'):
    sys.exit('Unsupported DatabaseSslMode: ' + mode)
connection = None
try:
    connection = pg8000.native.Connection(user=os.environ['PGUSER'], host=os.environ['PGHOST'],
        database=os.environ['PGDATABASE'], port=int(os.environ['PGPORT']),
        password=os.environ['PGPASSWORD'], timeout=30, ssl_context=context)
    print(connection.run("SELECT current_user || ':' || current_database()")[0][0])
except Exception as error:
    print(str(error).replace(os.environ['PGPASSWORD'], '[redacted]'), file=sys.stderr)
    sys.exit(1)
finally:
    if connection is not None:
        connection.close()
"""
        self.info('[setupIobeamAdminDb_state] verifying remote database {}:{}/{} as {}'.format(
            dbHost, env['PGPORT'], dbName, dbRole))
        ok, stdout, stderr = await self._runExec([python, '-c', script], min(timeout, 60), env=env)
        if not ok:
            self.error('[setupIobeamAdminDb_state] remote connection failed: ' + (stderr or '<no details>').replace(dbPassword, '[redacted]'))
        return ok

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
        # Credentials go to the owner-only secrets file; the JSON keeps
        # ${VAR} references (the backend's existing IOBEAM_ADMIN_DB_* names).
        store = self.secretStore()
        try:
            store.write({
                "IOBEAM_ADMIN_DB_HOST": host,
                "IOBEAM_ADMIN_DB_USER": dbRole,
                "IOBEAM_ADMIN_DB_PASSWORD": dbPassword,
            })
            store.load_into_environ()
            for name, value in (("IOBEAM_ADMIN_DB_HOST", host), ("IOBEAM_ADMIN_DB_USER", dbRole),
                                ("IOBEAM_ADMIN_DB_PASSWORD", dbPassword)):
                os.environ[name] = value
        except Exception as e:
            self.error("[{}][db-config] cannot update secrets file {}: {}"
                       .format(type(self).__name__, store.default_secrets_path(), e))
            return False
        data = {
            "Provider": "PostgreSQL",
            "DatabaseName": dbName,
            "Schema": "iobeam_admin",
            "Host": "${IOBEAM_ADMIN_DB_HOST}",
            "Port": dbPort,
            "User": "${IOBEAM_ADMIN_DB_USER}",
            "Password": "${IOBEAM_ADMIN_DB_PASSWORD}",
            "ConnectionString": "${IOBEAM_ADMIN_DB_URL:-}",
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


    def _readDbPassword(self, configFile):
        try:
            with open(configFile, "r", encoding="utf-8") as f:
                data = json.load(f)
            db = data.get("Database") if isinstance(data.get("Database"), dict) else data
            db = self.expandSecrets(db)
            return str(db.get("Password") or db.get("password") or "").strip()
        except Exception:
            return ""


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
            if os.name == "nt" and "password authentication failed" in stderrText:
                stderrText += (
                    "\nPostgreSQL is installed, but database authentication failed. "
                    "For administrator setup, supply the actual postgres password "
                    "in IOBEAM_POSTGRES_PASSWORD (or PGPASSWORD). "
                    "IOBEAM_ADMIN_DB_PASSWORD belongs to the application role "
                    "and is not an administrator-password fallback.\n")
            return False, stdoutText, stderrText
        return True, stdoutText, stderrText


