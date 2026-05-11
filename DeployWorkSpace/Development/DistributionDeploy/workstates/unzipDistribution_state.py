#-------------------------------------------------------------------------------
# unzipDistribution_state.py
#
# Unpack the dist archive into the deploy root on the target host.
# Driven by `unzip -o {zip} -d {dest}` in the JSON template.
#
# actionData['zip'] is a hint, not a fixed path:
#   - its parent directory is the search folder, and
#   - its basename is either an exact filename or a glob pattern.
# Glob patterns (containing * ? or []) let a single template match
# both compiled and raw builds -- e.g. "dist_app*.zip" matches both
# dist_app.zip and dist_app_raw.zip. When multiple .zip files match,
# the most recently modified one wins. If nothing matches, the code
# still falls back to the newest .zip in the folder so the deploy
# isn't blocked by a stale or unusual filename.
#-------------------------------------------------------------------------------
import os
import fnmatch

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

            # 2. Find a usable .zip inside that folder. The basename of
            #    zipHint is either an exact filename or a glob pattern;
            #    _findZipFile handles both and falls back to the newest
            #    .zip in the folder when nothing matches.
            preferred = os.path.basename(zipHint)
            zipPath = self._findZipFile(searchFolder, preferred)
            if not zipPath:
                self.error("[{}] no .zip file found in {}"
                           .format(type(self).__name__, searchFolder))
                self._success = False
                return

            # Warn only when an exact name was requested and we had to
            # fall back to something else. A glob hint matching multiple
            # names (e.g. dist_app*.zip) is intentional, not a mismatch.
            if (preferred
                    and not self._isGlob(preferred)
                    and os.path.basename(zipPath) != preferred):
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
          - a path to a zip file (existing or not), or
          - a path containing a glob pattern (e.g. dist_app*.zip).
        In all cases the parent directory is returned (or the path
        itself when it is already a directory). Returns an absolute path.
        """
        path = os.path.expanduser(str(zipHint))
        if os.path.isdir(path):
            return os.path.abspath(path)
        parent = os.path.dirname(path)
        return os.path.abspath(parent) if parent else os.path.abspath(".")

    @staticmethod
    def _isGlob(name):
        """True if `name` contains any glob wildcard character."""
        return bool(name) and any(ch in name for ch in "*?[")

    @classmethod
    def _findZipFile(cls, folder, preferredName):
        """
        Pick a .zip from `folder`:
          1. If preferredName is a glob (e.g. 'dist_app*.zip'),
             match against names in the folder and return the newest match.
          2. Else, exact match on preferredName if that file exists.
          3. Fallback: the newest .zip anywhere in `folder`.
        Returns an absolute path, or None if no .zip is present.
        """
        try:
            entries = os.listdir(folder)
        except OSError:
            return None

        def _newestAbs(paths):
            if not paths:
                return None
            paths = sorted(paths, key=os.path.getmtime, reverse=True)
            return os.path.abspath(paths[0])

        # Case 1: glob pattern.
        if preferredName and cls._isGlob(preferredName):
            matches = []
            for name in entries:
                if (name.lower().endswith(".zip")
                        and fnmatch.fnmatch(name, preferredName)):
                    full = os.path.join(folder, name)
                    if os.path.isfile(full):
                        matches.append(full)
            if matches:
                return _newestAbs(matches)
            # Glob missed -- fall through so the generic fallback can
            # still rescue the deploy with whatever .zip is present.

        # Case 2: exact preferred filename.
        if preferredName and not cls._isGlob(preferredName):
            candidate = os.path.join(folder, preferredName)
            if (os.path.isfile(candidate)
                    and candidate.lower().endswith(".zip")):
                return os.path.abspath(candidate)

        # Case 3: newest .zip anywhere in the folder.
        zips = []
        for name in entries:
            full = os.path.join(folder, name)
            if name.lower().endswith(".zip") and os.path.isfile(full):
                zips.append(full)
        return _newestAbs(zips)
