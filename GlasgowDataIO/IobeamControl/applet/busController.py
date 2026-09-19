"""Configurable bus FSM with the upstream OBI sequence as its default.

Adapted from nanographs/Open-Beam-Interface modules/bus_controller.py.
Retains the application\'s 16-bit container for right-aligned 14-bit ADC data.
"""
from amaranth import *
from amaranth.lib import data, wiring
from amaranth.lib.wiring import In, Out, flipped
from GlasgowDataIO.IobeamControl.commands.structs import Transforms
from . import StreamSignature, SuperDACStream, BusSignature, BlankRequest
from .adcTiming import AdcTiming
from .skidBuffer import SkidBuffer
from .upstreamBusController import UpstreamBusController

class BusController(wiring.Component):
    # FPGA-side interface
    dac_stream: In(StreamSignature(SuperDACStream))

    adc_stream: Out(StreamSignature(data.StructLayout({
        "adc_code": 16,
        "last":     1,
    })))

    # IO-side interface
    bus: Out(BusSignature)
    inline_blank: Out(BlankRequest)

    def __init__(self, *, adc_half_period: int, adc_latency: int, transforms: Transforms = Transforms(False,False,False),
                 adc_settle_cycles=1, adc_latch_cycles=1,
                 bus_turnaround_cycles=0, dac_data_setup_cycles=1,
                 dac_latch_cycles=1):
        self.timing = AdcTiming(
            adc_half_period, adc_settle_cycles, adc_latch_cycles,
            bus_turnaround_cycles, dac_data_setup_cycles, dac_latch_cycles)
        self.timing.validate_scan()
        if adc_latency < 1:
            raise ValueError("adc_latency must be at least 1")
        self.adc_half_period = adc_half_period
        self.adc_latency     = adc_latency
        self.transforms = transforms or Transforms(False, False, False)

        super().__init__()

        self.dac_x_code_transformed = Signal.like(self.dac_stream.payload.dac_x_code)
        self.dac_y_code_transformed = Signal.like(self.dac_stream.payload.dac_y_code)

    def elaborate(self, platform):
        if self.timing.uses_upstream_sequence:
            # Execute the pinned upstream FSM itself. Diagnostic stretches
            # below are explicitly outside the reference path.
            return UpstreamBusController.elaborate(self, platform)
        m = Module()

        adc_cycles = Signal(range(self.adc_half_period))
        with m.If(adc_cycles == self.adc_half_period - 1):
            m.d.sync += adc_cycles.eq(0)
            m.d.sync += self.bus.adc_clk.eq(~self.bus.adc_clk)
        with m.Else():
            m.d.sync += adc_cycles.eq(adc_cycles + 1)
        # ADC and DAC share the bus and have to work in tandem. The ADC conversion starts simultaneously
        # with the DAC update, so the entire ADC period is available for DAC-scope-ADC propagation.
        m.d.comb += self.bus.dac_clk.eq(self.bus.adc_clk)


        # Queue; MSB = most recent sample, LSB = least recent sample
        accept_sample = Signal(self.adc_latency)
        # Queue; as above
        last_sample = Signal(self.adc_latency)

        m.submodules.skid_buffer = skid_buffer = \
            SkidBuffer(self.adc_stream.payload.shape(), depth=self.adc_latency)
        wiring.connect(m, flipped(self.adc_stream), skid_buffer.o)

        adc_stream_data = Signal.like(self.adc_stream.payload) # FIXME: will not be needed after FIFOs have shapes
        m.d.comb += [
            # Cat(adc_stream_data.adc_code,
            #     adc_stream_data.adc_ovf).eq(self.bus.i),
            adc_stream_data.last.eq(last_sample[self.adc_latency-1]),
            skid_buffer.i.payload.eq(adc_stream_data),
        ]

        dac_stream_data = Signal.like(self.dac_stream.payload)
        
        x = Signal.like(self.dac_x_code_transformed)
        y = Signal.like(self.dac_y_code_transformed)

        # The skid buffer captures this value at the end of the final ADC read
        # cycle, before the configurable shared-bus turnaround/DAC sequence.
        m.d.comb += adc_stream_data.adc_code.eq(self.bus.data_i)

        latch_remaining = Signal(range(max(2, self.timing.latch_cycles + 1)))
        settle_remaining = Signal(range(max(2, self.timing.settle_cycles + 1)))
        turnaround_remaining = Signal(range(max(2, self.timing.bus_turnaround_cycles + 1)))
        dac_setup_remaining = Signal(range(max(2, self.timing.dac_data_setup_cycles + 1)))
        dac_latch_remaining = Signal(range(max(2, self.timing.dac_latch_cycles + 1)))

        def read_adc_and_accept_dac():
            """Emit the one-cycle OBI ADC_Read transaction."""
            m.d.comb += skid_buffer.i.valid.eq(accept_sample[self.adc_latency-1])
            with m.If(self.dac_stream.valid & skid_buffer.i.ready):
                m.d.comb += self.dac_stream.ready.eq(1)
                m.d.sync += dac_stream_data.eq(self.dac_stream.payload)
                if self.transforms.rotate90:
                    m.d.comb += [
                        x.eq(self.dac_stream.payload.dac_y_code),
                        y.eq(self.dac_stream.payload.dac_x_code),
                    ]
                else:
                    m.d.comb += [
                        x.eq(self.dac_stream.payload.dac_x_code),
                        y.eq(self.dac_stream.payload.dac_y_code),
                    ]
                if self.transforms.xflip:
                    m.d.sync += self.dac_x_code_transformed.eq(16383 - x)
                else:
                    m.d.sync += self.dac_x_code_transformed.eq(x)
                if self.transforms.yflip:
                    m.d.sync += self.dac_y_code_transformed.eq(16383 - y)
                else:
                    m.d.sync += self.dac_y_code_transformed.eq(y)
                m.d.comb += self.inline_blank.eq(self.dac_stream.payload.blank)
                m.d.sync += [
                    accept_sample.eq(Cat(1, accept_sample)),
                    last_sample.eq(Cat(self.dac_stream.payload.last, last_sample)),
                ]
            with m.Else():
                m.d.sync += [
                    accept_sample.eq(Cat(0, accept_sample)),
                    last_sample.eq(Cat(0, last_sample)),
                ]

        with m.FSM():
            with m.State("ADC_Wait"):
                with m.If(self.bus.adc_clk & (adc_cycles == 0)):
                    m.d.comb += [
                        self.bus.adc_le_clk.eq(1),
                        self.bus.adc_oe.eq(1),
                    ]
                    if self.timing.latch_cycles == 1:
                        m.d.sync += settle_remaining.eq(self.timing.settle_cycles)
                        m.next = "ADC_Read"
                    else:
                        m.d.sync += latch_remaining.eq(self.timing.latch_cycles - 1)
                        m.next = "ADC_Latch"

            with m.State("ADC_Latch"):
                m.d.comb += [
                    self.bus.adc_le_clk.eq(1),
                    self.bus.adc_oe.eq(1),
                ]
                with m.If(latch_remaining == 1):
                    m.d.sync += settle_remaining.eq(self.timing.settle_cycles)
                    m.next = "ADC_Read"
                with m.Else():
                    m.d.sync += latch_remaining.eq(latch_remaining - 1)

            with m.State("ADC_Read"):
                m.d.comb += self.bus.adc_oe.eq(1)
                with m.If(settle_remaining == 1):
                    read_adc_and_accept_dac()
                    if self.timing.bus_turnaround_cycles == 0:
                        m.d.sync += dac_setup_remaining.eq(
                            self.timing.dac_data_setup_cycles)
                        m.next = "X_DAC_Write"
                    else:
                        m.d.sync += turnaround_remaining.eq(
                            self.timing.bus_turnaround_cycles)
                        m.next = "Bus_Turnaround"
                with m.Else():
                    m.d.sync += settle_remaining.eq(settle_remaining - 1)

            with m.State("Bus_Turnaround"):
                with m.If(turnaround_remaining == 1):
                    m.d.sync += dac_setup_remaining.eq(
                        self.timing.dac_data_setup_cycles)
                    m.next = "X_DAC_Write"
                with m.Else():
                    m.d.sync += turnaround_remaining.eq(turnaround_remaining - 1)

            with m.State("X_DAC_Write"):
                m.d.comb += [
                    self.bus.data_o.eq(self.dac_x_code_transformed),
                    self.bus.data_oe.eq(1),
                ]
                with m.If(dac_setup_remaining == 1):
                    m.d.sync += dac_latch_remaining.eq(
                        self.timing.dac_latch_cycles)
                    m.next = "X_DAC_Write_2"
                with m.Else():
                    m.d.sync += dac_setup_remaining.eq(dac_setup_remaining - 1)

            with m.State("X_DAC_Write_2"):
                m.d.comb += [
                    self.bus.data_o.eq(self.dac_x_code_transformed),
                    self.bus.data_oe.eq(1),
                    self.bus.dac_x_le_clk.eq(1),
                ]
                with m.If(dac_latch_remaining == 1):
                    m.d.sync += dac_setup_remaining.eq(
                        self.timing.dac_data_setup_cycles)
                    m.next = "Y_DAC_Write"
                with m.Else():
                    m.d.sync += dac_latch_remaining.eq(dac_latch_remaining - 1)

            with m.State("Y_DAC_Write"):
                m.d.comb += [
                    self.bus.data_o.eq(self.dac_y_code_transformed),
                    self.bus.data_oe.eq(1),
                ]
                with m.If(dac_setup_remaining == 1):
                    m.d.sync += dac_latch_remaining.eq(
                        self.timing.dac_latch_cycles)
                    m.next = "Y_DAC_Write_2"
                with m.Else():
                    m.d.sync += dac_setup_remaining.eq(dac_setup_remaining - 1)

            with m.State("Y_DAC_Write_2"):
                m.d.comb += [
                    self.bus.data_o.eq(self.dac_y_code_transformed),
                    self.bus.data_oe.eq(1),
                    self.bus.dac_y_le_clk.eq(1),
                ]
                with m.If(dac_latch_remaining == 1):
                    m.next = "ADC_Wait"
                with m.Else():
                    m.d.sync += dac_latch_remaining.eq(dac_latch_remaining - 1)

        return m
