#-------------------------------------------------------------------------------
# unzipDistribution_state.py
#
# Unpack the dist archive into the deploy root on the target host.
#-------------------------------------------------------------------------------
import fnmatch
import os

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .executeShellCommand_state import executeShellCommand_state


class unzipDistribution_state(executeShellCommand_state):
    def __init__(self, parent):
        super(unzipDistribution_state, self).__init__(parent)

    @overrides(executeShellCommand_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}

            zipHint = actionData.get("zip")
            dest = actionData.get("dest")
            commandFormat = actionData.get(
                Consts.COMMAND_FORMAT, "unzip -o {} -d {}")
            acceptedNames = actionData.get("acceptedNames") or []
            if isinstance(acceptedNames, str):
                acceptedNames = [acceptedNames]

            if not zipHint or not dest:
                self.error("[{}] missing 'zip' or 'dest' in actionData."
                           .format(type(self).__name__))
                self._success = False
                return

            searchFolder = self._resolveSearchFolder(zipHint)
            if not os.path.isdir(searchFolder):
                self.error("[{}] zip search folder does not exist: {}"
                           .format(type(self).__name__, searchFolder))
                self._success = False
                return

            preferred = os.path.basename(str(zipHint))
            preferredNames = []
            for name in [preferred] + list(acceptedNames):
                if name and name not in preferredNames:
                    preferredNames.append(name)

            zipPath = self._findZipFile(searchFolder, preferredNames)
            if not zipPath:
                self.error("[{}] no .zip file found in {}"
                           .format(type(self).__name__, searchFolder))
                self._success = False
                return

            chosenBase = os.path.basename(zipPath)
            if chosenBase == preferred:
                pass
            elif self._matchesAnyName(chosenBase, acceptedNames):
                self.info("[{}] '{}' not found in {}, using accepted "
                          "alternative '{}'"
                          .format(type(self).__name__, preferred,
                                  searchFolder, chosenBase))
            else:
                self.warn("[{}] no preferred name matched in {}; falling back "
                          "to newest zip '{}'"
                          .format(type(self).__name__, searchFolder,
                                  chosenBase))

            destPath = self.resolveDeployPath(dest)
            self.info("[{}] using zip: {}".format(type(self).__name__, zipPath))
            cmd = commandFormat.format(zipPath, destPath)
            self.info("[{}] >> {}".format(type(self).__name__, cmd))

            self.ParentWorkThread.activateVirtualEnv()

            timeout = float(stateConfig.get(Consts.TIMEOUT, 0.0) or 0.0)
            self._success = await self._run(cmd, timeout)

            if self._success:
                self.info("[{}] OK".format(type(self).__name__))
            else:
                self.error("[{}] FAILED. stderr:\n{}"
                           .format(type(self).__name__,
                                   self._stderr.decode(errors='replace')
                                   if self._stderr else "<none>"))
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    def _resolveSearchFolder(self, zipHint):
        """
        actionData['zip'] may be a directory, a file path, or a glob hint.
        Relative paths are resolved from the DistributionDeploy work root.
        """
        path = os.path.expanduser(str(zipHint))
        if not os.path.isabs(path):
            path = os.path.join(self.workRoot(), path)
        if os.path.isdir(path):
            return os.path.abspath(path)
        parent = os.path.dirname(path)
        return os.path.abspath(parent) if parent else os.path.abspath(".")

    @classmethod
    def _findZipFile(cls, folder, preferredNames):
        if preferredNames is None:
            preferredNames = []
        elif isinstance(preferredNames, str):
            preferredNames = [preferredNames]

        try:
            allEntries = os.listdir(folder)
        except OSError:
            return None

        allZips = []
        for name in allEntries:
            full = os.path.join(folder, name)
            if name.lower().endswith(".zip") and os.path.isfile(full):
                allZips.append(full)
        if not allZips:
            return None

        for pref in preferredNames:
            if not pref or cls._isGlob(pref):
                continue
            candidate = os.path.join(folder, pref)
            if (os.path.isfile(candidate)
                    and candidate.lower().endswith(".zip")):
                return os.path.abspath(candidate)

        for pref in preferredNames:
            if not pref or not cls._isGlob(pref):
                continue
            matches = [z for z in allZips
                       if fnmatch.fnmatch(os.path.basename(z), pref)]
            if matches:
                matches.sort(key=os.path.getmtime, reverse=True)
                return os.path.abspath(matches[0])

        allZips.sort(key=os.path.getmtime, reverse=True)
        return os.path.abspath(allZips[0])

    @staticmethod
    def _isGlob(name):
        return bool(name) and any(ch in name for ch in "*?[")

    @staticmethod
    def _matchesAnyName(filename, names):
        for name in names or []:
            if not name:
                continue
            if any(ch in name for ch in "*?["):
                if fnmatch.fnmatch(filename, name):
                    return True
            elif filename == name:
                return True
        return False

    @staticmethod
    def _isSafeDeployRoot(path):
        root = os.path.abspath(os.path.expanduser(str(path)))
        if not root or root == os.path.abspath(os.sep):
            return False
        drive, tail = os.path.splitdrive(root)
        parts = [p for p in tail.strip("\\/").replace("\\", "/").split("/") if p]
        if len(parts) < 2:
            return False
        return parts[-1].lower() in {"deploy", "iobeamplatform"}
