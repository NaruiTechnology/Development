import queue, asyncio
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from workstates.streamData_state import streamData_state
from .dataIOThread import dataIOThread
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import GlasgowDevice
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.assembly import HardwareAssembly

class streamDataThread(dataIOThread):
    def __init__(self, config, deviceId=None, waveForm=None, data=None, conn=None):
        super(streamDataThread, self).__init__(config, deviceId)
        self._waveForm = waveForm
        self._data = data
        self._conn = conn

    @overrides(dataIOThread)
    def IntialWork(self):
        state = None
        self._queue = queue.Queue()

        instance = streamData_state(self, waveForm=self._waveForm, data=self._data)
        instance.Conn = self._conn
        instance.Logger = self._logger
        
        self._queue.put(instance)

        if self._queue.qsize() > 0:
            state = self._queue.get_nowait()

        return state
