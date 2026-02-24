from AutomationPy.buildingblocks.decorators import overrides
from .loadFpgaImage_state import loadFpgaImage_state

class connectDevice_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(connectDevice_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        voltage = 3.3 # 1.8 
        await self._device.set_voltage("AB", voltage)