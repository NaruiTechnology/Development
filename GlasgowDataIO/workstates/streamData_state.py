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
            commandFormat = action.get('commandFormat')
            resolution = 0
            pins = ''
            pinValueGroupFormat = ''
            ports = action.get('ports')

            if isinstance(ports, list):
                for item in list(ports):
                    pList = item.get('pinList')
                    if pList is not None and len(pList) > 0:
                        port = item.get('port')
                        for x in pList:                            
                            pins = f'{pins}{port}{x},'
                            pinValueGroupFormat = f"{pinValueGroupFormat}{port}{x}=" + '{} '
                            resolution += 1
                pins = pins[:-1]                 
                pinValueGroupFormat = pinValueGroupFormat[:-1]

            wave_type = action.get('waveform', 'sine')
            frequency = action.get('frequency', 1.0)
            point = action.get('point', 100)
            
            lut = self._generate_lut(wave_type, resolution, point)
            delay = 1.0 / (frequency * len(lut))

            """ if self._gpio_iface is None:
                await self._initialize_hardware() """

            for val in lut:
                bits = [int(bit) for bit in bin(val)[2:].zfill(resolution)]
                pinValueGroup = pinValueGroupFormat.format(*bits)
                if self._gpio_iface is not None: #TODO
                    #Hi speed Max Stream Throughput: ~100 kHz to 1 MHz 
                    await self._gpio_iface.set_pin(pins, pinValueGroup)
                    self._success = True
                else:
                    # Max reliable Frequecy: ~ 10 Hz to 100 Hz
                    cmd = commandFormat.format(voltage, pins, pinValueGroup)              
                    self._success = await self.commandAsyncio(cmd)
                if not self._success: 
                    break
                else:
                    if self.ParentWorkThread._config.Verbose:
                        print (f'Send DAC data success, wave type = [{wave_type}], frequency = [{frequency}], points = [{point}], delay = [{delay:.3f}], data = [{val}].')   
                await asyncio.sleep(delay)

        except Exception as e:
            self.Logger.error(f"Applet Error: {e}")
            self._success = False

    def _generate_lut(self, wave_type, resolution, points=75):
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
         
        