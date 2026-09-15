"""Shared conversion-relative timing for scan and isolated ADC capture.

Phases are 48 MHz clock intervals after the logical falling ADC clock edge
(physical rising edge with the production pin inversion). Scan owns the bus
only during its read window; isolated acquisition holds OE active throughout.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class AdcTiming:
    half_period: int = 3
    settle_cycles: int = 1
    latch_cycles: int = 1
    bus_turnaround_cycles: int = 0
    dac_data_setup_cycles: int = 1
    dac_latch_cycles: int = 1

    def __post_init__(self):
        if self.half_period < 2:
            raise ValueError("adcHalfPeriod must be at least 2")
        if self.settle_cycles < 1:
            raise ValueError("adcSettleCycles must be at least 1")
        if self.latch_cycles < 1:
            raise ValueError("adcLatchCycles must be at least 1")
        if self.bus_turnaround_cycles < 0:
            raise ValueError("busTurnaroundCycles must be nonnegative")
        if self.dac_data_setup_cycles < 1:
            raise ValueError("dacDataSetupCycles must be at least 1")
        if self.dac_latch_cycles < 1:
            raise ValueError("dacLatchCycles must be at least 1")

    @property
    def period(self):
        return 2 * self.half_period

    @property
    def latch_phase(self):
        # OBI latches at logical rising / physical falling ADC clock.
        return self.half_period

    @property
    def sample_phase(self):
        # Capture on the final ADC settle/read cycle.  The OBI profile uses
        # one latch cycle followed by one read cycle, hence phases 3 and 4.
        return self.latch_phase + self.latch_cycles + self.settle_cycles - 1

    def validate_scan(self):
        if self.latch_cycles + self.settle_cycles > self.half_period:
            raise ValueError(
                "ADC latch and settle windows must fit within one half-period")
        if self.period < self.scan_required_cycles:
            raise ValueError(
                "ADC period must contain latch, settle, turnaround, and DAC states")

    @property
    def scan_required_cycles(self):
        return (self.latch_cycles + self.settle_cycles +
                self.bus_turnaround_cycles +
                2 * (self.dac_data_setup_cycles + self.dac_latch_cycles))

    def capture_phases(self, latch_phase=None, sample_phase=None):
        latch = self.latch_phase if latch_phase is None else int(latch_phase)
        sample = self.sample_phase if sample_phase is None else int(sample_phase)
        for name, phase in (("adcLatchPhase", latch), ("adcSamplePhase", sample)):
            if not 0 <= phase < self.period:
                raise ValueError(f"{name} must be within one ADC period")
        if latch + self.latch_cycles > self.period:
            raise ValueError("ADC latch pulse must fit within one ADC period")
        # Explicit phases remain diagnostic overrides, including phase zero.
        return latch, sample

    @classmethod
    def from_action(cls, action):
        return cls(int(action.get("adcHalfPeriod", 3)),
                   int(action.get("adcSettleCycles", 1)),
                   int(action.get("adcLatchCycles", 1)),
                   int(action.get("busTurnaroundCycles", 0)),
                   int(action.get("dacDataSetupCycles", 1)),
                   int(action.get("dacLatchCycles", 1)))
