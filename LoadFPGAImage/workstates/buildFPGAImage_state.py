from AutomationPy.buildingblocks.definitions import Consts

from .asyncioCommand_state import asyncioCommand_state

class buildFPGAImage_state(asyncioCommand_state):
    def __init__(self,  parent):
        super(buildFPGAImage_state, self).__init__(parent)