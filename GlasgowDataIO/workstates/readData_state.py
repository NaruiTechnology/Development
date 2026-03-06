from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from .dataIO_state import dataIO_state

class readData_state(dataIO_state):
    def __init__(self, parent):
        super(readData_state, self).__init__(parent)

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
        if self._stdout is not None:
            print(self._stdout.decode()) #force to print out the read results