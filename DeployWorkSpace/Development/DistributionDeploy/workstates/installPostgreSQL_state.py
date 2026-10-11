
import glob
import os
import shutil
import sys

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
            timeout = float(stateConfig.get("timeout", 900.0) or 900.0)
            psql = self._findPsql()
            if psql:
                self._addPsqlToPath(psql)
                self.info("[{}] PostgreSQL client already installed: {}"
                          .format(type(self).__name__, psql))
                self._success = True
                return

            winget = shutil.which("winget.exe") or shutil.which("winget")
            if not winget:
                raise RuntimeError(
                    "PostgreSQL is not installed and winget.exe was not found")
            package = str(actionData.get(
                "windowsPackage", "PostgreSQL.PostgreSQL"))
            command = [
                winget, "install", "--id", package, "--exact", "--silent",
                "--accept-source-agreements", "--accept-package-agreements",
            ]
            self.info("[{}] installing {} with winget"
                      .format(type(self).__name__, package))
            if not await self.runArguments(command, timeout):
                self.error("[{}] PostgreSQL installation failed: {}"
                           .format(type(self).__name__,
                                   self._stderr.decode(errors="replace")
                                   if self._stderr else "<no stderr>"))
                self._success = False
                return

            psql = self._findPsql()
            if not psql:
                raise RuntimeError(
                    "PostgreSQL installed, but psql.exe is not available. "
                    "Open a new terminal and rerun the workflow.")
            self._addPsqlToPath(psql)
            self._success = True
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    @staticmethod
    def _findPsql():
        found = shutil.which("psql.exe") or shutil.which("psql")
        if found:
            return found
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        candidates = glob.glob(os.path.join(
            program_files, "PostgreSQL", "*", "bin", "psql.exe"))
        return sorted(candidates)[-1] if candidates else None

    @staticmethod
    def _addPsqlToPath(psql):
        bin_dir = os.path.dirname(psql)
        entries = os.environ.get("PATH", "").split(os.pathsep)
        if not any(os.path.normcase(entry) == os.path.normcase(bin_dir)
                   for entry in entries if entry):
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
