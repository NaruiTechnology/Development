#-------------------------------------------------------------------------------
# exportEnv_state.py
#
# Persist environment variables (e.g. GLASGOW_CONFIG) into ~/.bashrc so future
# interactive shells inherit them, AND set them on os.environ so the remaining
# states in this run inherit them via commandAsyncio's env=os.environ.copy().
#
# We only append a given export line if it isn't already present, so re-runs
# of the workflow don't keep growing ~/.bashrc.
#
# Action data fields recognised:
#   bashrcPath   target rc file (default: ~/.bashrc)
#   exports      dict { ENV_VAR_NAME: value }
#-------------------------------------------------------------------------------
import os

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class exportEnv_state(distributionDeploy_state):
    def __init__(self, parent):
        super(exportEnv_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}

            bashrcPath = os.path.expanduser(actionData.get("bashrcPath", "~/.bashrc"))
            exports = actionData.get("exports", {}) or {}

            if not exports:
                self.info("[{}] no exports declared.".format(type(self).__name__))
                self.Success = True
                return

            # 1. Update os.environ for the rest of this run.
            for k, v in exports.items():
                resolved = self.resolveEnvValue(v)
                os.environ[str(k)] = str(resolved)
                self.info("[{}] os.environ[{}] = {}"
                          .format(type(self).__name__, k, resolved))

            # 2. Append to ~/.bashrc, idempotently.
            existing = ""
            if os.path.isfile(bashrcPath):
                try:
                    with open(bashrcPath, "r") as f:
                        existing = f.read()
                except OSError as e:
                    self.warn("[{}] could not read '{}': {}"
                              .format(type(self).__name__, bashrcPath, e))

            appended = []
            with open(bashrcPath, "a") as f:
                f.write("\n# --- DistributionDeploy exports ---\n")
                for k, v in exports.items():
                    line = "export {}={}".format(k, _shquote(self.resolveEnvValue(v)))
                    if line in existing:
                        self.info("[{}] '{}' already present in {}, skipping."
                                  .format(type(self).__name__, k, bashrcPath))
                        continue
                    f.write(line + "\n")
                    appended.append(line)

            if appended:
                self.info("[{}] appended {} export(s) to {}"
                          .format(type(self).__name__, len(appended), bashrcPath))

            self._success = True
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False


def _shquote(value):
    """Minimal single-quote shell quoting -- safe for path values."""
    s = str(value)
    if not s:
        return "''"
    if all(c.isalnum() or c in "@%+=:,./-_~" for c in s):
        return s
    return "'" + s.replace("'", "'\"'\"'") + "'"
