from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from .dataIO_state import dataIO_state
import re

class readData_state(dataIO_state):
    def __init__(self, parent):
        super(readData_state, self).__init__(parent)
        self._port = 'A' #None
        self._pinList = [0,1,2,3,4,5,6,7] #None

    @overrides(dataIO_state)
    def formatCommand(self, stateConfig):
        if stateConfig is not None and Consts.ACTION_DATA in stateConfig:
            action = stateConfig.get(Consts.ACTION_DATA) 
            if action is not None:
                port = action.get('port')
                pinList = action.get('pinList')
                if pinList is not None:
                    pins = ""
                    pos = ""
                    args = []
                    args.append(action.get('voltage'))
                    for x in pinList:
                        pins = f"{pins}{port}{x},"
                        pos = f"{pos}{port}{x} "
                    args.append(pins[:-1])                  
                    args.append(pos[:-1])
                    cmdFormat = action.get(Consts.COMMAND_FORMAT)
                    return cmdFormat.format(*args)  
        return None
    
    @overrides(dataIO_state)
    async def DoWork(self):
        await super(readData_state, self).DoWork()
        self._extractData()
        
    def _extractData(self):
        if self._stdout is not None and self._pinList is not None:
            output = self._stdout.decode()
            print(output) 
            valstr = ''
            for x in self._pinList:
                pattern = rf'{self._port}{x}=([0-1])'
                match = re.search(pattern, output)
                if match:
                    digit = match.group(1)
                    valstr = f'{valstr}{digit}'
            self._data = int(valstr, 2)
            print(f'Read Glasgow data from port [{self._port}], pins {self._pinList}, raw data = [{valstr}], value = [{self._data}]')

