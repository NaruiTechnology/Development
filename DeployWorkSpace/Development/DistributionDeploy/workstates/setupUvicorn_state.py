#-------------------------------------------------------------------------------
# setupUvicorn_state.py
#
# Explicitly install and verify the Python ASGI runtime used by
# launchGlasgowService_state.
#-------------------------------------------------------------------------------
from .installToolchain_state import installToolchain_state


class setupUvicorn_state(installToolchain_state):
    def __init__(self, parent):
        super(setupUvicorn_state, self).__init__(parent)
