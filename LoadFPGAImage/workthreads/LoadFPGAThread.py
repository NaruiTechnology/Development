from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from AutomationPy.buildingblocks.workflow.work_thread import WorkThread
from AutomationPy.buildingblocks.automation_log import AutomationLog
import AutomationPy.buildingblocks.utils as util
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import GlasgowDevice

try:
    import queue
except ImportError:
    import Queue as queue

class LoadFPGAThread(WorkThread):
    def __init__(self, config, deviceId=None):
        super(LoadFPGAThread, self).__init__()
        self._config = config
        if config.LogName is not None:
            self._logName = config.LogName
        else:
            self._logName = type(self).__name__
        logInstance = AutomationLog(self._logName)
        self._logger = logInstance.GetLogger(self._logName)     
        AutomationLog.TryAddConsole(self._logName) 
        self._queue = None
        self._device = GlasgowDevice(deviceId) 
        self._fpgaBuildPlan = None
        
    @property
    def device(self):
        """Get the glasgow device instance."""
        return self._device

    @property
    def fpgaBuildPlan(self):
        """Get the FPGA build plan."""
        return self._fpgaBuildPlan

    @fpgaBuildPlan.setter
    def fpgaBuildPlan(self, value):
        """Set the FPGA build plan."""
        self._fpgaBuildPlan = value

    @overrides(WorkThread)
    def StateFactory(self, workState = None):
        state = None
        if workState is None:
            state = self.IntialWork()
        elif workState._success:
            if self._queue.qsize() > 0:
                state = self._queue.get_nowait()
            else:
                self._logger.info(Consts.COMPLETED_MSG_FORMAT.format(type(self).__name__))
        else:
            state = None
            #self._logger.error(Consts.FAILED_MSG)
        if state is not None:
            self._logger.info('Calling {}'.format(type(state).__name__
                                                    .replace(Consts.STATE_OBJ_SUFFIX, '')))
        
        return state

    @overrides(WorkThread)
    def IntialWork(self):
        state = None
        self._queue = queue.Queue()
        for action in self._config.Actions:
            for key, val in action.items():
                actionConfig = val

                skip = actionConfig[Consts.SKIP]
                if not skip:
                    instance = util.CreateInstance("{}_state".format(key),self)
                    instance.Config = self._config
                    instance.Logger = self._logger
                    self._queue.put(instance)
        if self._queue.qsize() > 0:
            state = self._queue.get_nowait()

        return state