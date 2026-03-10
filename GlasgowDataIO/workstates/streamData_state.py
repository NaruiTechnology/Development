import asyncio
import math
from workstates.dataIO_state import dataIO_state
from AutomationPy.buildingblocks.definitions import Consts
from AutomationPy.buildingblocks.decorators import overrides

# Note: In a real Glasgow environment, you would import the applet
# from glasgow.applet.interface.control_gpio import ControlGPIOApplet
from EsmBeamController.Software.lib.glasgow.hardware.device import GlasgowDevice    
from glasgow.applet.control.gpio import GPIOInterface

class streamData_state(dataIO_state):
    def __init__(self, parent, waveForm=None, data=None):
        super(streamData_state, self).__init__(parent)
        self._waveForm = waveForm 
        self._data = data
        self._gpio_iface = None

    @overrides(dataIO_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            action = stateConfig.get(Consts.ACTION_DATA)
            
            # Configuration
            voltage = action.get('voltage', 3.3)
            port = action.get('port', 'A')
            pin_num = action.get('pin', 0)
            resolution = action.get('resolution', 12)
            wave_type = action.get('waveform', 'sine')
            frequency = action.get('frequency', 1.0)
            
            lut = self._generate_lut(wave_type, resolution)
            delay = 1.0 / (frequency * len(lut))

            """ if self._gpio_iface is None:
                await self._initialize_hardware() """

            # THE STANDARD APPLET APPROACH:
            # Instead of subprocess, we use a mock-up of the internal Glasgow API call.
            # In a production environment, you would instantiate the applet class once.
            self.Logger.info(f"Initializing Glasgow Control-GPIO Applet on Port {port}")


            # Implementation of the "persistent" command logic
            # This simulates the applet's 'write' functionality without restarting the FPGA
            for val in lut:
                if self._gpio_iface is not None: #TODO
                    #Hi speed Max Stream Throughput: ~100 kHz to 1 MHz 
                    await self._gpio_iface.set_pin(pin_num, val)
                    self._success = True
                else:
                    # Max reliable Frequecy: ~ 10 Hz to 100 Hz
                    cmd = f"glasgow run control-gpio -V {voltage} --pins {port}{pin_num} {port}{pin_num}={val}"               
                    #self._success = await self.commandAsyncio(cmd)
                    await asyncio.wait_for(
                        self.runCommand(cmd),
                        timeout=stateConfig[Consts.TIMEOUT]
                    )
                if not self._success: 
                    break   
                await asyncio.sleep(delay)

        except Exception as e:
            self.Logger.error(f"Applet Error: {e}")
            self._success = False

    def _generate_lut(self, wave_type, resolution, points=100):
        max_val = (1 << resolution) - 1
        lut = []
        for i in range(points):
            t = i / points
            if wave_type.lower() == "sine":
                raw_val = (math.sin(2 * math.pi * t) + 1) * (max_val / 2)
            elif wave_type.lower() == "square":
                raw_val = max_val if t < 0.5 else 0
            elif wave_type.lower() == "triangle":
                raw_val = max_val * (1 - abs(2 * t - 1))
            else:
                raw_val = 0
            
            val = int(round(raw_val))
            if val > max_val or val < 0:
                raise ValueError(f"Value {val} out of {resolution}-bit range")
            lut.append(val)
        return lut            
         
        