"""Stage-specific Amaranth SPI subtarget for one TMC5160 axis."""
from ...glasgowLib.glasgow.applet.interface.spi_controller import SPIControllerSubtarget


class SampleStageSubtarget(SPIControllerSubtarget):
    """A named TMC5160 SPI channel embedded in the combined stage bitstream."""

    def __init__(self, axis, *args, **kwargs):
        axis = str(axis).upper()
        if axis not in {"X", "Y"}:
            raise ValueError("sample-stage axis must be X or Y")
        self.axis = axis
        super().__init__(*args, **kwargs)
