import asyncio
import os
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from .executeCommandLine_state import executeCommandLine_state
from .asyncioCommand_state import asyncioCommand_state

class buildFPGAImage_state(asyncioCommand_state):
    def __init__(self,  parent):
        super(buildFPGAImage_state, self).__init__(parent)