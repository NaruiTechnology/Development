#-------------------------------------------------------------------------------
# distributionDeploy_state.py
#
# Abstract base class for all DistributionDeploy work-states.
# Mirrors LoadFPGAImage/workstates/loadFpgaImage_state.py.
#
# Concrete states either:
#   1. Subclass executeShellCommand_state (which itself derives from this) and
#      drive the action purely off the JSON 'commandFormat' template, OR
#   2. Subclass this base directly and override DoWork() when the step
#      requires custom branching, iteration, or in-process logic that can't
#      be captured by a single shell template.
#-------------------------------------------------------------------------------
from abc import abstractmethod
import os

from buildingblocks.workflow.workstate import WorkState


@abstractmethod
class distributionDeploy_state(WorkState):
    """Abstract base for every DistributionDeploy work-state."""

    def __init__(self, parent):
        super(distributionDeploy_state, self).__init__(parent)
        # populated by the thread's IntialWork() right after construction
        self._config = None
        self._logger = None

    # ---- attributes assigned by the parent thread ------------------------
    @property
    def Config(self):
        return self._config

    @Config.setter
    def Config(self, val):
        self._config = val

    @property
    def Logger(self):
        return self._logger

    @Logger.setter
    def Logger(self, val):
        self._logger = val

    # ---- helpers used by every concrete state ----------------------------
    def deployRoot(self):
        """Return the deploy root directory configured for this run."""
        thread = self.ParentWorkThread
        if thread is not None and hasattr(thread, "deployRoot"):
            return thread.deployRoot
        return "."

    def workRoot(self):
        """Return the DistributionDeploy working directory for this run."""
        thread = self.ParentWorkThread
        if thread is not None and hasattr(thread, "workRoot"):
            return thread.workRoot
        return os.getcwd()

    def resolveWorkPath(self, path):
        """Resolve a JSON path relative to the DistributionDeploy folder."""
        if not path:
            return path
        expanded = os.path.expanduser(str(path))
        if os.path.isabs(expanded):
            return os.path.abspath(expanded)
        return os.path.abspath(os.path.join(self.workRoot(), expanded))

    def resolveDeployPath(self, path):
        """Resolve a JSON path relative to the configured deploy root."""
        if not path:
            return path
        expanded = os.path.expanduser(str(path))
        if os.path.isabs(expanded):
            return os.path.abspath(expanded)
        return os.path.abspath(os.path.join(self.deployRoot(), expanded))

    def resolveEnvValue(self, value):
        """Resolve path-like env values; lists become os.pathsep-separated."""
        if isinstance(value, dict):
            raw = value.get("value", "")
            if value.get("resolve", True):
                return self.resolveEnvValue(raw)
            return raw
        if isinstance(value, (list, tuple)):
            return os.pathsep.join(self.resolveDeployPath(v) for v in value)
        if isinstance(value, str) and value and not value.startswith(("http://", "https://")):
            return self.resolveDeployPath(value)
        return value

    def info(self, msg):
        if self._logger is not None:
            self._logger.info(msg)
        else:
            print(msg)

    def warn(self, msg):
        if self._logger is not None:
            self._logger.warning(msg)
        else:
            print("WARN: " + msg)

    def error(self, msg):
        if self._logger is not None:
            self._logger.error(msg)
        else:
            print("ERROR: " + msg)
