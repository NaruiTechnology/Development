
from Development.AutomationPy.buildingblocks.decorators import overrides
from .LoadFPGAState import LoadFPGAImageState

class ConnectDeviceState(LoadFPGAImageState):
    def __init__(self, context, parent):
        self.context = context
        super(ConnectDeviceState, self).__init__(parent)

    @overrides(LoadFPGAImageState)
    async def DoWork(self):
        voltage = 3.3 # 1.8 
        await self._device.set_voltage("AB", voltage)
