import queue
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.decorators import overrides
from ..workstates.streamData_state import streamData_state
from .dataIOThread import dataIOThread

class streamDataThread(dataIOThread):
    def __init__(self, config, deviceId=None, waveForm=None, data=None):
        super(streamDataThread, self).__init__(config, deviceId)
        self._waveForm = waveForm
        self._data = data

    @overrides(dataIOThread)
    def IntialWork(self):
        state = None
        self._queue = queue.Queue()

        instance = streamData_state(self, waveForm=self._waveForm, data=self._data)
        instance.Logger = self._logger
        
        self._queue.put(instance)

        if self._queue.qsize() > 0:
            state = self._queue.get_nowait()

        return state