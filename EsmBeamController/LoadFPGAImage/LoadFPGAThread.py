import os, json

from Development.AutomationPy.buildingblocks.decorators import overrides, initializer
from Development.AutomationPy.buildingblocks.workflow.work_thread import WorkThread
from Development.AutomationPy.buildingblocks.automation_config import AutomationConfig
from Development.AutomationPy.buildingblocks.automation_log import AutomationLog
from Software.lib.glasgow.hardware.device import GlasgowDevice

try:
    import queue
except ImportError:
    import Queue as queue

class LoadFPGAThread(WorkThread):
    def __init__(self, config, deviceId=None):
        super(LoadFPGAThread, self).__init__()
        self._config = config
        logName = type(self).__name__
        self._logger = AutomationLog.GetLogger(logName)    
        AutomationLog.TryAddConsole(logName) 
        self._device = GlasgowDevice()
        if deviceId is not None:
            self._device.open(deviceId)
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
def IntialWork(self):
    self._queue = queue.Queue()
    return self._initialWork()

@overrides(WorkThread)
def StateFactory(self, workState = None):
    pass