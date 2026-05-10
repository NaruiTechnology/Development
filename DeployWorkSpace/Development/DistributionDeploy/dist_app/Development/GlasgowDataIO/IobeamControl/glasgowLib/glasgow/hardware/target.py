from glasgow.hardware.assembly import HardwareAssembly
from glasgow.legacy import DeprecatedTarget


class GlasgowHardwareTarget(DeprecatedTarget):
    def __init__(self, revision, multiplexer_cls=None):
        super().__init__(HardwareAssembly(revision=revision))

