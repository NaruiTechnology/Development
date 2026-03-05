from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from .dataIO_state import dataIO_state

class writeData_state(dataIO_state):
    def __init__(self, parent):
        super(writeData_state, self).__init__(parent)

    @overrides(dataIO_state)
    def formatCommand(self, stateConfig):
        if stateConfig is not None and Consts.ACTION_DATA in stateConfig:
            action = stateConfig.get(Consts.ACTION_DATA) 
            if action is not None:
                port = action.get('port')
                if self._bitsList is not None:   
                    pins = ""
                    val = ""
                    args = []
                    args.append(action.get('voltage'))
                    for x in range(0, action.get('length')): #self._bitsList:
                        pins =f"{pins}{port}{x},"
                        val = f"{val}{port}{x}={self._bitsList[x]} "
                    args.append(pins[:-1])                  
                    args.append(val[:-1])
                    cmdFormat = action.get(Consts.COMMAND_FORMAT)
                    return cmdFormat.format(*args)
            