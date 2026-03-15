import queue
from AutomationPy.buildingblocks.decorators import overrides
from ..workstates.streamData_state import streamData_state
from .dataIOThread import dataIOThread
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import GlasgowDevice
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.assembly import HardwareAssembly
from glasgow.applet.control.gpio import ControlGPIOApplet 
from types import SimpleNamespace

class streamDataThread(dataIOThread):
    def __init__(self, config, deviceId=None, waveForm=None, data=None):
        super(streamDataThread, self).__init__(config, deviceId)
        self._waveForm = waveForm
        self._data = data
        self._device = GlasgowDevice(deviceId)
        self._iface = None

    @overrides(dataIOThread)
    def IntialWork(self):
        state = None
        self._queue = queue.Queue()

        instance = streamData_state(self, waveForm=self._waveForm, data=self._data)
        instance.Logger = self._logger
        instance._gpio_iface = self._iface
        
        self._queue.put(instance)

        if self._queue.qsize() > 0:
            state = self._queue.get_nowait()

        return state
