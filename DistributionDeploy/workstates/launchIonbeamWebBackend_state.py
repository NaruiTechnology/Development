#-------------------------------------------------------------------------------
# launchIonbeamWebBackend_state.py
#
# Start `npm run dev` in ionbeam-web/backend, detached.
#-------------------------------------------------------------------------------
from .detachedShellLaunch_state import detachedShellLaunch_state


class launchIonbeamWebBackend_state(detachedShellLaunch_state):
    def __init__(self, parent):
        super(launchIonbeamWebBackend_state, self).__init__(parent)
