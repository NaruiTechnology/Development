#-------------------------------------------------------------------------------
# unzipDistribution_state.py
#
# Unpack dist_app.zip into the deploy root on the target host.
# Driven by `unzip -o {zip} -d {dest}` in the JSON template.
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
            # Optional list of additional acceptable zip filenames or glob
            # patterns. Lets one JSON cover both compiled and raw builds, e.g.
            # ["dist_app.zip", "dist_app_raw.zip", "dist_app*.zip"].
            acceptedNames = actionData.get("acceptedNames") or []
            if isinstance(acceptedNames, str):
                acceptedNames = [acceptedNames]
 
            if not zipHint or not dest:
                self.error("[{}] missing 'zip' or 'dest' in actionData."
                           .format(type(self).__name__))
                self._success = False
                return
 
            # 1. Resolve the folder we should search in.
            searchFolder = self._resolveSearchFolder(zipHint)
            if not os.path.isdir(searchFolder):
                self.error("[{}] zip search folder does not exist: {}"
                           .format(type(self).__name__, searchFolder))
                self._success = False
                return
 
            # 2. Build the preference list: hint basename first, then any
            #    extras from acceptedNames (de-duplicated, order preserved).
            preferred = os.path.basename(zipHint)
            preferredNames = []
            for name in [preferred] + list(acceptedNames):
                if name and name not in preferredNames:
                    preferredNames.append(name)
 
            # 3. Find a usable .zip inside that folder.
            zipPath = self._findZipFile(searchFolder, preferredNames)
            if not zipPath:
                self.error("[{}] no .zip file found in {}"
                           .format(type(self).__name__, searchFolder))
                self._success = False
                return
 
            chosenBase = os.path.basename(zipPath)
            if chosenBase == preferred:
                pass  # primary match — no message needed.
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
 
            self.info("[{}] using zip: {}"
                      .format(type(self).__name__, zipPath))
 
            # 4. Build and run the unzip command.
            cmd = commandFormat.format(zipPath, dest)
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
 
    # ---- helpers ---------------------------------------------------------
    @staticmethod
    def _resolveSearchFolder(zipHint):
        """
        actionData['zip'] may be either:
          - a directory path -> used as-is, or
          - a path to a zip file (existing or not) -> parent directory used.
        Returns an absolute path.
        """
        path = os.path.expanduser(str(zipHint))
        if os.path.isdir(path):
            return os.path.abspath(path)
        parent = os.path.dirname(path)
        return os.path.abspath(parent) if parent else os.path.abspath(".")
 
    @staticmethod
    def _findZipFile(folder, preferredNames):
        """
        Pick a .zip from `folder` using a preference order:
          1. exact filename match against each literal name in `preferredNames`
             (in the order given), then
          2. glob match against each pattern in `preferredNames`
             (fnmatch syntax, e.g. 'dist_app*.zip'); newest match wins, then
          3. most recently modified .zip in `folder` (last-resort fallback).
        `preferredNames` may be a string or list of strings. Returns an
        absolute path, or None if no .zip is present.
        """
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
 
        def _isGlob(s):
            return any(ch in s for ch in "*?[")
 
        # Pass 1: exact filename matches, in caller's order.
        for pref in preferredNames:
            if not pref or _isGlob(pref):
                continue
            candidate = os.path.join(folder, pref)
            if (os.path.isfile(candidate)
                    and candidate.lower().endswith(".zip")):
                return os.path.abspath(candidate)
 
        # Pass 2: glob matches, in caller's order; newest match per pattern.
        for pref in preferredNames:
            if not pref or not _isGlob(pref):
                continue
            matches = [z for z in allZips
                       if fnmatch.fnmatch(os.path.basename(z), pref)]
            if matches:
                matches.sort(key=os.path.getmtime, reverse=True)
                return os.path.abspath(matches[0])
 
        # Pass 3: newest .zip in the folder.
        allZips.sort(key=os.path.getmtime, reverse=True)
        return os.path.abspath(allZips[0])
 
    @staticmethod
    def _matchesAnyName(filename, names):
        """True if `filename` exactly matches a literal name in `names`
        or fnmatches a glob pattern in `names`."""
        for n in names or []:
            if not n:
                continue
            if any(ch in n for ch in "*?["):
                if fnmatch.fnmatch(filename, n):
                    return True
            elif filename == n:
                return True
        return False
