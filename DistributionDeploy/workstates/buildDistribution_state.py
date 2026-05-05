#-------------------------------------------------------------------------------
# buildDistribution_state.py
#
# First action: invoke buidCompiledDist.py to produce dist_app.zip.
# Pure template state -- the JSON drives the command.
#-------------------------------------------------------------------------------
from .executeShellCommand_state import executeShellCommand_state


class buildDistribution_state(executeShellCommand_state):
    def __init__(self, parent):
        super(buildDistribution_state, self).__init__(parent)
