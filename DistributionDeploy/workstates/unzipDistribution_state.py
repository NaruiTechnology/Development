#-------------------------------------------------------------------------------
# unzipDistribution_state.py
#
# Unpack dist_app.zip into the deploy root on the target host.
# Driven by `unzip -o {zip} -d {dest}` in the JSON template.
#-------------------------------------------------------------------------------
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
 
            # 2. Find a usable .zip inside that folder.
            preferred = os.path.basename(zipHint)
            zipPath = self._findZipFile(searchFolder, preferred)
            if not zipPath:
                self.error("[{}] no .zip file found in {}"
                           .format(type(self).__name__, searchFolder))
                self._success = False
                return
 
            if preferred and os.path.basename(zipPath) != preferred:
                self.warn("[{}] expected '{}' in {}, using '{}' instead"
                          .format(type(self).__name__, preferred,
                                  searchFolder, os.path.basename(zipPath)))
 
            self.info("[{}] using zip: {}"
                      .format(type(self).__name__, zipPath))
 
            # 3. Build and run the unzip command.
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
    def _findZipFile(folder, preferredName):
        """
        Pick a .zip from `folder`:
          1. exact match on `preferredName` (if it exists), else
          2. the most recently modified .zip in `folder`.
        Returns an absolute path, or None if no .zip is present.
        """
        if preferredName:
            candidate = os.path.join(folder, preferredName)
            if (os.path.isfile(candidate)
                    and candidate.lower().endswith(".zip")):
                return os.path.abspath(candidate)
 
        zips = []
        for name in os.listdir(folder):
            full = os.path.join(folder, name)
            if name.lower().endswith(".zip") and os.path.isfile(full):
                zips.append(full)
        if not zips:
            return None
        zips.sort(key=os.path.getmtime, reverse=True)
        return os.path.abspath(zips[0])
