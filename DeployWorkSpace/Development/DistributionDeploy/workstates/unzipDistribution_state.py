#-------------------------------------------------------------------------------
# unzipDistribution_state.py
#
# Unpack dist_app.zip into the deploy root on the target host.
# Driven by `unzip -o {zip} -d {dest}` in the JSON template.
#-------------------------------------------------------------------------------
from .executeShellCommand_state import executeShellCommand_state


class unzipDistribution_state(executeShellCommand_state):
    def __init__(self, parent):
        super(unzipDistribution_state, self).__init__(parent)
