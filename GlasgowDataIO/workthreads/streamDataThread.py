import queue
from AutomationPy.buildingblocks.decorators import overrides
from ..workstates.streamData_state import streamData_state
from .dataIOThread import dataIOThread
from EsmBeamController.Software.lib.glasgow.hardware.multiplexer import DirectMultiplexer
from EsmBeamController.Software.lib.glasgow.hardware.device import GlasgowDevice
from EsmBeamController.Software.lib.glasgow.hardware.target import GlasgowHardwareTarget
from EsmBeamController.Software.lib.glasgow.hardware.assembly import HardwareAssembly
from EsmBeamController.Software.lib.glasgow.abstract import GlasgowPin
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

        self._initialGPIPInterface()

        instance = streamData_state(self, waveForm=self._waveForm, data=self._data)
        instance.Logger = self._logger
        instance._gpio_iface = self._iface
        
        self._queue.put(instance)

        if self._queue.qsize() > 0:
            state = self._queue.get_nowait()

        return state
    
    def _initialGPIPInterface(self):
        target = GlasgowHardwareTarget(revision=self._device.revision, multiplexer_cls=DirectMultiplexer)
        assembly = HardwareAssembly(revision=self._device.revision)
        applet = ControlGPIOApplet(assembly)       
        action_data = self._config["Actions"][0]["streamData"]["actionData"]        
        action_voltage = action_data.get("voltage", 2.5)
        voltages_map = {"A": action_voltage, "B": action_voltage}
        pin_list = []
        for p in action_data.get("ports", []):
            port_letter = p.get("port")
            for pin_num in p.get("pinList", []):
                pin_list.append(f"{port_letter}{pin_num}")
        
        # 'voltages' must be a Mapping[GlasgowPort, float] for assembly.py
        applet_args = SimpleNamespace(
            voltage=voltages_map,
            pins=GlasgowPin.parse(",".join(pin_list)) if pin_list else []
        )      
        try:
            # Standard Glasgow build requires (target, args)
            self._iface = applet.build(target, applet_args)
        except TypeError as e:
            if self._config.Verbose:
                self._logger.error(f'Failed on Glasgow applete build with two parameters, error: {str(e)}')
            self._iface = applet.build(applet_args)
