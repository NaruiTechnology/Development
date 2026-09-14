from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts
from buildingblocks.workflow.work_thread import WorkThread
from buildingblocks.automation_log import AutomationLog
import buildingblocks.utils as util
import os
import queue

TRANSACTION_COMPLETE = "transactionComplete"


class DistributionDeployThread(WorkThread):
    """Workflow driver for the project distribution deploy."""
            
    def __init__(self, config):
        super(DistributionDeployThread, self).__init__()
        self._config = config
        self._venvPath = None

        # Logger: mirror LoadFPGAThread
        self._logName = getattr(config, "LogName", None) or type(self).__name__
        logInstance = AutomationLog(self._logName)
        self._logger = logInstance.GetLogger(self._logName)
        AutomationLog.TryAddConsole(self._logName)

        self._queue = None

        # Pull deployment-wide settings out of the config so every state can
        # read them off the parent thread without re-walking the JSON.
        deployment = getattr(config, "Deployment", {}) or {}
        self._workRoot = self._resolveWorkRoot(config, deployment)
        self._deployRoot = self._resolveFromWorkRoot(
            deployment.get("DeployRoot", "."))
        self._sourceRoot = self._resolveFromWorkRoot(
            deployment.get("SourceRoot", "."))
        self._distZip = deployment.get("DistZip", "dist_app.zip")
        self._venvDir = deployment.get("VenvDir", ".venv")
        self._glasgowConfig = self._resolveFromDeployRoot(
            deployment.get("GlasgowConfig", ""))
        self._glasgowLog = deployment.get("GlasgowLog", "/tmp/glasgow.log")
        self._isProduction = self._truthy(deployment.get("IsProduction", False))
        self._workflowSucceeded = False
        self._workflowError = None

    # -- properties exposed to states ---------------------------------------
    @property
    def workRoot(self):
        return self._workRoot

    @property
    def deployRoot(self):
        return self._deployRoot

    @property
    def sourceRoot(self):
        return self._sourceRoot

    @property
    def distZip(self):
        return self._distZip

    @property
    def venvDir(self):
        return self._venvDir

    @property
    def glasgowConfig(self):
        return self._glasgowConfig

    @property
    def glasgowLog(self):
        return self._glasgowLog

    @property
    def logger(self):
        return self._logger

    # -- path helpers -------------------------------------------------------
    def _resolveWorkRoot(self, config, deployment):
        configured = deployment.get("WorkRoot")
        if configured:
            return os.path.abspath(os.path.expanduser(str(configured)))

        jsonFile = getattr(config, "_jsonFile", None)
        if jsonFile and os.path.isfile(jsonFile):
            jsonDir = os.path.dirname(os.path.abspath(jsonFile))
            if os.path.basename(jsonDir) == "Json":
                distributionDir = os.path.dirname(jsonDir)
                if os.path.basename(distributionDir) == "DistributionDeploy":
                    return os.path.abspath(os.path.join(distributionDir, "..", ".."))
                return distributionDir
            return jsonDir
        return os.getcwd()

    def _resolveFromWorkRoot(self, path):
        if not path:
            return path
        expanded = os.path.expanduser(str(path))
        if os.path.isabs(expanded):
            return os.path.abspath(expanded)
        return os.path.abspath(os.path.join(self._workRoot, expanded))

    def _resolveFromDeployRoot(self, path):
        if not path:
            return path
        expanded = os.path.expanduser(str(path))
        if os.path.isabs(expanded):
            return os.path.abspath(expanded)
        return os.path.abspath(os.path.join(self._deployRoot, expanded))

    # -- WorkThread overrides -----------------------------------------------
    @overrides(WorkThread)
    def StateFactory(self, workState=None):
        state = None
        if workState is None:
            # First invocation: prime the queue and return the first state
            state = self.IntialWork()
        elif workState._success:
            # Previous state succeeded -> mark its action as complete and pop
            self._markComplete(workState)
            if self._queue is not None and self._queue.qsize() > 0:
                state = self._queue.get_nowait()
            else:
                self._logger.info(
                    Consts.COMPLETED_MSG_FORMAT.format(type(self).__name__))
                self._workflowSucceeded = True
        else:
            # Previous state failed -> abort. We could surface a richer
            # error; mirroring LoadFPGAThread we just halt the queue.
            self._logger.error(
                "State '{}' did not succeed; aborting workflow.".format(
                    type(workState).__name__.replace(Consts.STATE_OBJ_SUFFIX, '')))
            self._workflowError = "state failed: {}".format(
                type(workState).__name__.replace(Consts.STATE_OBJ_SUFFIX, ''))
            state = None

            self._logger.info('Calling {}'.format(
                type(state).__name__.replace(Consts.STATE_OBJ_SUFFIX, '')))
        return state

    @overrides(WorkThread)
    def IntialWork(self):
        state = None
        self._queue = queue.Queue()
        actions = {key: value for action in self._config.Actions for key, value in action.items()}
        if "createDeployFolder" in actions:
            # Stopping the running installation and replacing it from the
            # validated archive are mandatory clean-deploy gates. FPGA
            # programming is hardware-dependent, so an explicit skip must be
            # honored for development/VM deployments where no Glasgow is
            # attached.
            required = ("stopLocalSystem", "createDeployFolder", "unzipDistribution")
            names = list(actions)
            if (any(name not in actions or actions[name].get(Consts.SKIP, False)
                    or actions[name].get(TRANSACTION_COMPLETE, False) for name in required)
                    or [names.index(name) for name in required] != sorted(names.index(name) for name in required)):
                self._workflowError = "clean deployment requires stop, recreate, and extract in order; reset completion flags for a new run"
                self._logger.error(self._workflowError)
                return None
            # A clean replacement invalidates every old installation receipt.
            if any(value.get(TRANSACTION_COMPLETE, False) and not value.get(Consts.SKIP, False)
                   for value in actions.values()):
                self._workflowError = "clean deployment cannot reuse completed installation states; reset completion flags"
                self._logger.error(self._workflowError)
                return None
            fpga_enabled = ("programFpgaRam" in actions
                            and not actions["programFpgaRam"].get(Consts.SKIP, False))
            for name in ("manageLocalSystem", "launchGlasgowService", "launchIonbeamWebBackend", "launchIonbeamWebFrontend"):
                if (fpga_enabled and name in actions
                        and not actions[name].get(Consts.SKIP, False)
                        and names.index(name) < names.index("programFpgaRam")):
                    self._workflowError = "FPGA verification must precede service startup"
                    self._logger.error(self._workflowError)
                    return None
        for action in self._config.Actions:
            for key, val in action.items():
                actionConfig = val

                # Honor both control flags
                skip = bool(actionConfig.get(Consts.SKIP, False))
                done = bool(actionConfig.get(TRANSACTION_COMPLETE, False))
                if skip:
                    self._logger.info("[skip=true] '{}' skipped.".format(key))
                    continue
                if done:
                    self._logger.info(
                        "[transactionComplete=true] '{}' already done.".format(key))
                    continue

                instance = util.CreateInstance("{}_state".format(key), self)
                if instance is None:
                    self._logger.error(
                        "Could not instantiate state '{0}_state' for action "
                        "'{0}'. Make sure 'workstates/{0}_state.py' exists "
                        "and is importable from the current working dir."
                        .format(key))
                    self._workflowError = "missing workstate: {}".format(key)
                    self._queue = queue.Queue()
                    return None
                instance.Config = self._config
                instance.Logger = self._logger
                self._queue.put(instance)

        if self._queue.qsize() > 0:
            state = self._queue.get_nowait()
        elif self._workflowError is None:
            self._workflowSucceeded = True
        return state

    # -- helpers ------------------------------------------------------------
    def _markComplete(self, workState):
        """Flip transactionComplete=True for the action that just succeeded.

        We only mutate the in-memory config; we don't persist back to disk
        automatically (a deploy run shouldn't silently rewrite its own
        config file). Persistence can be added by the caller via
        ``self._config.Save()`` once the workflow finishes.
        """
        if workState is None:
            return
        actionName = type(workState).__name__.replace(Consts.STATE_OBJ_SUFFIX, '')
        try:
            for action in self._config.Actions:
                if actionName in action:
                    action[actionName][TRANSACTION_COMPLETE] = True
                    return
        except Exception as e:
            self._logger.warning("Could not mark '{}' complete: {}"
                                 .format(actionName, e))

    @staticmethod
    def _truthy(value):
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if value is None:
            return False
        return str(value).strip().lower() in ("1", "true", "yes", "on")

    def activateVirtualEnv(self):
        """Ensure subprocesses use the deployment virtualenv by adjusting
        the current process environment (PATH and VIRTUAL_ENV). This is
        inherited by commands launched via the workstates.
        """
        try:
            if self._venvPath is None:
                # fallback to configured venv dir relative to deploy root
                candidate = os.path.join(self._deployRoot, self._venvDir)
                if os.path.isdir(candidate):
                    self._venvPath = candidate
            if self._venvPath is not None and os.path.isdir(self._venvPath):
                venv_bin = os.path.join(self._venvPath, "bin")
                old_path = os.environ.get('PATH', '')
                if not old_path.startswith(venv_bin):
                    os.environ['PATH'] = venv_bin + os.pathsep + old_path
                os.environ['VIRTUAL_ENV'] = self._venvPath
                self._logger.info(f"Activated virtualenv: {self._venvPath}")
            else:
                self._logger.info("No virtualenv path set; skipping activation")
        except Exception:
            self._logger.warning("Failed to activate virtualenv; continuing without it")
