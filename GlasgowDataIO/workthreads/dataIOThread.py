import queue
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from AutomationPy.buildingblocks.workflow.work_thread import WorkThread
from AutomationPy.buildingblocks.automation_log import AutomationLog

class dataIOThread(WorkThread):
    def __init__(self, config, deviceId=None, data=None):
        super(dataIOThread, self).__init__()
        self._config = config
        if config.LogName is not None:
            self._logName = config.LogName
        else:
            self._logName = type(self).__name__
        logInstance = AutomationLog(self._logName)
        self._logger = logInstance.GetLogger(self._logName)     
        AutomationLog.TryAddConsole(self._logName) 
        self._queue = None
        self._data = data
        self._deviceId = deviceId

    @overrides(WorkThread)
    def StateFactory(self, workState = None):
        state = None
        if workState is None:
            state = self.IntialWork()
        elif workState._success:
            if self._queue.qsize() > 0:
                state = self._queue.get_nowait()
            #else:
                #self._logger.info(Consts.GetStateConfig.format(type(self).__name__))
        else:
            state = None
        return state

    @overrides(WorkThread)
    def IntialWork(self):
        state = None
        self._queue = queue.Queue()

        stateName = type(self).__name__.replace('Thread', '')
        instance = util.CreateInstance(f"{stateName}_state", self)
        instance.data = self._data
        instance.Logger = self._logger
        self._queue.put(instance)


        if self._queue.qsize() > 0:
            state = self._queue.get_nowait()

        return state            
