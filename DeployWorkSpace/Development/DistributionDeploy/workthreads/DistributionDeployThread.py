from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts
from buildingblocks.workflow.work_thread import WorkThread
from buildingblocks.automation_log import AutomationLog
import buildingblocks.utils as util
import queue

TRANSACTION_COMPLETE = "transactionComplete"


class DistributionDeployThread(WorkThread):
    """Workflow driver for the project distribution deploy."""

    def __init__(self, config):
        super(DistributionDeployThread, self).__init__()
        self._config = config

        # Logger: mirror LoadFPGAThread
        self._logName = getattr(config, "LogName", None) or type(self).__name__
        logInstance = AutomationLog(self._logName)
        self._logger = logInstance.GetLogger(self._logName)
        AutomationLog.TryAddConsole(self._logName)

        self._queue = None

        # Pull deployment-wide settings out of the config so every state can
        # read them off the parent thread without re-walking the JSON.
        deployment = getattr(config, "Deployment", {}) or {}
        self._deployRoot = deployment.get("DeployRoot", ".")
        self._sourceRoot = deployment.get("SourceRoot", ".")
        self._distZip = deployment.get("DistZip", "dist_app.zip")
        self._venvDir = deployment.get("VenvDir", ".venv")
        self._glasgowConfig = deployment.get("GlasgowConfig", "")
        self._glasgowLog = deployment.get("GlasgowLog", "/tmp/glasgow.log")

    # -- properties exposed to states ---------------------------------------
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
        else:
            # Previous state failed -> abort. We could surface a richer
            # error; mirroring LoadFPGAThread we just halt the queue.
            self._logger.error(
                "State '{}' did not succeed; aborting workflow.".format(
                    type(workState).__name__.replace(Consts.STATE_OBJ_SUFFIX, '')))
            state = None

            self._logger.info('Calling {}'.format(
                type(state).__name__.replace(Consts.STATE_OBJ_SUFFIX, '')))
        return state

    @overrides(WorkThread)
    def IntialWork(self):
        state = None
        self._queue = queue.Queue()
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
                    continue
                instance.Config = self._config
                instance.Logger = self._logger
                self._queue.put(instance)

        if self._queue.qsize() > 0:
            state = self._queue.get_nowait()
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
