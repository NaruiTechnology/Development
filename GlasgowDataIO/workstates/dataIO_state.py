import asyncio
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.workflow.workstate import WorkState
from AutomationPy.buildingblocks.definitions import Consts

class dataIO_state(WorkState):
    def __init__(self, parent):
        super(dataIO_state, self).__init__(parent)
        self._data = None
        self._bitsList = None

    @property
    def data(self):
        return self._data
    
    @data.setter
    def data(self, val):
        self._data = val
        if self._data is None:
            return
        stateConfig = self.ParentWorkThread.GetStateConfig(self)
        if stateConfig is not None and Consts.ACTION_DATA in stateConfig:
            self._data = val
            if self._data is not None and isinstance(self._data, int):
                num_bits = self._data.bit_length()
                action = stateConfig.get(Consts.ACTION_DATA)
                allowedLength = action.get('length')
                if num_bits > allowedLength:
                    raise ValueError(f"The length [{num_bits}] of the data [{self._data}] is greater than the config value [{allowedLength}]")
                if num_bits == 0:
                    num_bits = 1 # Handle the case where number is 0
                self._bitsList = [(self._data >> x) & 1 for x in range(num_bits - 1, -1, -1)]
                self._bitsList = [0] * (action.get('length') - len(self._bitsList)) + self._bitsList

    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            if stateConfig is not None and Consts.ACTION_DATA in stateConfig:
                cmd = self.formatCommand(stateConfig)
                self._success = await self.commandAsyncio(cmd)
                if self._success is True:
                    if self.ParentWorkThread._config.Verbose: 
                        print(f"DoWork - {type(self).__name__} successfully.")
        except Exception as e:
            print(f"DoWork - {type(self).__name__} error: {e}")
            self.Success = False