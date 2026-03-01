import asyncio
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from .loadFpgaImage_state import loadFpgaImage_state
from .executeCommandLine_state import executeCommandLine_state
from .asyncioCommand_state import asyncioCommand_state

class bitsStreamPackage_state(asyncioCommand_state):
    def __init__(self, parent):
        super(bitsStreamPackage_state, self).__init__(parent)            