
import glob
import asyncio
import ctypes
from datetime import datetime
import os
import shutil

from .distributionDeploy_state import distributionDeploy_state


class installPostgreSQL_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installPostgreSQL_state, self).__init__(parent)

    async def DoWork(self):
        try:
            if os.name != "nt":
                self.info("[{}] PostgreSQL installation is handled by setupIobeamAdminDb on Linux."
                          .format(type(self).__name__))
                self._success = True
                return

            stateConfig = self.ParentWorkThread.GetStateConfig(self) or {}
            actionData = self.resolvedActionData(stateConfig)
            timeout = float(stateConfig.get("timeout", 1800.0) or 1800.0)
            psql = self._findPsql()
            if psql:
                self._verifyServerBinary(psql)
                self._addPsqlToPath(psql)
                self.info("[{}] PostgreSQL client already installed: {}"
                          .format(type(self).__name__, psql))
                self._success = True
                return

            winget = shutil.which("winget.exe") or shutil.which("winget")
            if not winget:
                raise RuntimeError(
                    "PostgreSQL is not installed and winget.exe was not found. "
                    "Install/update Microsoft App Installer in the signed-in user session.")
            if not self._isAdministrator():
                raise RuntimeError("PostgreSQL service installation requires administrator "
                                   "rights. Run the install workflow from an Administrator terminal.")
            package = str(actionData.get(
                "windowsPackage", "PostgreSQL.PostgreSQL.17"))
            if package == "PostgreSQL.PostgreSQL":
                package = "PostgreSQL.PostgreSQL.17"
            logDir = self.resolveDeployPath(actionData.get("logDir", "Logs"))
            os.makedirs(logDir, exist_ok=True)
            logBase = os.path.join(logDir, "postgresql-install-" +
                                   datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
            installerLog, outputLog = logBase + ".installer.log", logBase + ".output.log"
            command = [
                winget, "install", "--id", package, "--exact", "--silent",
                "--accept-source-agreements", "--accept-package-agreements",
                "--source", "winget", "--disable-interactivity",
                "--verbose-logs", "--log", installerLog,
            ]
            if actionData.get("windowsVersion"):
                command.extend(["--version", str(actionData["windowsVersion"])])
            self.info("[{}] installing {} with winget"
                      .format(type(self).__name__, package))
            self._stdout, self._stderr, self._returncode = b"", b"", None
            timedOut = False
            try:
                installed = await self.runArguments(command, timeout)
            except asyncio.TimeoutError:
                installed, timedOut = False, True
            stdout = (self._stdout or b"").decode(errors="replace")
            stderr = (self._stderr or b"").decode(errors="replace")
            with open(outputLog, "w", encoding="utf-8") as handle:
                handle.write("package={}\nexit_code={}\ntimed_out={}\n"
                             "--- stdout ---\n{}\n--- stderr ---\n{}\n".format(
                                 package, self._returncode, timedOut, stdout, stderr))
            self.info("[{}] PostgreSQL output log: {}; installer log: {}"
                      .format(type(self).__name__, outputLog, installerLog))
            if not installed:
                reason = ("timeout after {} seconds; check for a still-running child "
                          "installer before retrying".format(timeout) if timedOut
                          else "exit code {}".format(self._returncode))
                raise RuntimeError("PostgreSQL installation failed ({}). Logs: {}; {}.\n{}\n{}"
                                   .format(reason, outputLog, installerLog,
                                           stdout[-4000:], stderr[-4000:]))

            psql = self._findPsql()
            if not psql:
                raise RuntimeError(
                    "PostgreSQL installed, but psql.exe is not available. "
                    "Inspect {} and {}.".format(outputLog, installerLog))
            self._verifyServerBinary(psql)
            self._addPsqlToPath(psql)
            self._success = True
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    @staticmethod
    def _isAdministrator():
        return bool(ctypes.windll.shell32.IsUserAnAdmin())

    @staticmethod
    def _verifyServerBinary(psql):
        server = os.path.join(os.path.dirname(psql), "postgres.exe")
        if not os.path.isfile(server):
            raise RuntimeError("Found client {}, but server binary {} is missing. "
                               "Install the PostgreSQL server component."
                               .format(psql, server))

    @staticmethod
    def _findPsql():
        found = shutil.which("psql.exe") or shutil.which("psql")
        if found:
            return found
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        candidates = glob.glob(os.path.join(
            program_files, "PostgreSQL", "*", "bin", "psql.exe"))
        def version(path):
            folder = os.path.basename(os.path.dirname(os.path.dirname(path)))
            return tuple(int(part) if part.isdigit() else 0 for part in folder.split('.'))
        return max(candidates, key=version) if candidates else None

    @staticmethod
    def _addPsqlToPath(psql):
        bin_dir = os.path.dirname(psql)
        entries = os.environ.get("PATH", "").split(os.pathsep)
        if not any(os.path.normcase(entry) == os.path.normcase(bin_dir)
                   for entry in entries if entry):
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
