"""Stage-specific STEP/DIR/EN FPGA subtarget.

The stage protocol intentionally inherits the proven command encoding from
ControlStepperSubtarget while retaining the axis identity in the gateware
object graph and build diagnostics.
"""
from .controlStepperSubtarget import ControlStepperSubtarget


class SampleStageSubtarget(ControlStepperSubtarget):
    def __init__(self, axis, ports, out_fifo, pulse_high_us=5):
        axis = str(axis).upper()
        if axis not in {"X", "Y"}:
            raise ValueError("sample-stage axis must be X or Y")
        self.axis = axis
        super().__init__(ports, out_fifo, pulse_high_us=pulse_high_us)
