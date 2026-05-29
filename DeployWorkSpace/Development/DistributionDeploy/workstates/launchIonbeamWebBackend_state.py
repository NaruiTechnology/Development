#-------------------------------------------------------------------------------
# launchIonbeamWebBackend_state.py
#
# Start the compiled backend server in ionbeam-web/backend, detached.
#-------------------------------------------------------------------------------
from .longRunShellLaunch_state import longRunShellLaunch_state


class launchIonbeamWebBackend_state(longRunShellLaunch_state):
    def __init__(self, parent):
        super(launchIonbeamWebBackend_state, self).__init__(parent)
