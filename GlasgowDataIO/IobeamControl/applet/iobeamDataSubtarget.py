from amaranth import *
from amaranth.build import *
from amaranth.lib import enum, data, io, wiring
from amaranth.lib.wiring import In, Out, flipped
from GlasgowDataIO.IobeamControl.commands.structs import CmdType, BeamType, OutputMode, Transforms
from GlasgowDataIO.IobeamControl.applet.commandParser import CommandParser
from ..glasgowLib.glasgow.legacy import DeprecatedFIFOReadPort, DeprecatedFIFOWritePort
from ..glasgowLib.glasgow.legacy import DeprecatedFIFOReadPort, DeprecatedFIFOWritePort
from .commandExecutor import CommandExecutor
from .imageSerializer import ImageSerializer
from .pipelinedLoopbackAdapter import PipelinedLoopbackAdapter
from . import iobeam_resources

class IobeamDataSubtarget(wiring.Component):
    def __init__(self, *, ports, out_fifo, in_fifo, led=None, control=None, data=None, 
                        ext_switch_delay=0, transforms: Transforms=None, 
                        benchmark_counters=None, loopback=False, out_only=False, **kwargs):
        self.ports            = ports
        self.out_fifo         = out_fifo
        self.in_fifo          = in_fifo
        self.led              = led
        self.control          = control
        self.data             = data
        self.ext_switch_delay = ext_switch_delay
        self.transforms = transforms
        self.loopback         = loopback
        self.out_only         = out_only

        if not benchmark_counters == None:
            self.benchmark = True
            out_stall_events, out_stall_cycles, stall_count_reset = benchmark_counters
            self.out_stall_events = out_stall_events
            self.out_stall_cycles = out_stall_cycles
            self.stall_count_reset = stall_count_reset
        else:
            self.benchmark = False

    def elaborate(self, platform):
        m = Module()

        ## core modules and interconnections
        m.submodules.parser     = parser     = CommandParser()
        m.submodules.executor   = executor   = CommandExecutor(out_only=self.out_only, ext_switch_delay=self.ext_switch_delay, transforms=self.transforms)
        m.submodules.serializer = serializer = ImageSerializer()

        wiring.connect(m, parser.cmd_stream, executor.cmd_stream)
        wiring.connect(m, executor.img_stream, serializer.img_stream)

        if isinstance(self.out_fifo, DeprecatedFIFOReadPort): # TODO: _FIFOReadPort):
            self.out_fifo.r_data = self.out_fifo.stream # TODO
        if isinstance(self.in_fifo, DeprecatedFIFOWritePort): # TODO: _FIFOWritePort):
            self.in_fifo.w_data = self.in_fifo.stream
        # wiring.connect(m, self.out_fifo.r_data, parser.usb_stream) # TODO
        # wiring.connect(m, self.in_fifo.w_data, serializer.usb_stream) # TODO

        m.d.comb += [
            self.in_fifo.flush.eq(executor.flush),
            serializer.output_mode.eq(executor.output_mode)
        ]


        ## Ports/resources ==========================================================
        platform.add_resources(iobeam_resources)

        if platform is not None:
            self.led            = platform.request("led", dir="-")
            self.control        = platform.request("control", dir={pin.name:"-" for pin in iobeam_resources[0].ios})
            self.data           = platform.request("data", dir="-")
        else: 
            self.led = io.SimulationPort("o",1)
            self.control = io.SimulationPort("io",7)
            self.control.x_latch  = io.SimulationPort("o",1,name="x_latch")
            self.control.y_latch  = io.SimulationPort("o",1,name="y_latch")
            self.control.a_latch  = io.SimulationPort("o",1,name="a_latch")
            self.control.a_enable = io.SimulationPort("o",1,name="a_enable")
            self.control.d_clock  = io.SimulationPort("o",1,name="d_clock")
            self.control.a_clock  = io.SimulationPort("o",1,name="a_clock")
            self.data = io.SimulationPort("io", 14)

        ### IO buffers
        m.submodules.led_buffer = led = io.Buffer("o", self.led)

        m.submodules.x_latch_buffer  = x_latch  = io.Buffer("o", self.control.x_latch)
        m.submodules.y_latch_buffer  = y_latch  = io.Buffer("o", self.control.y_latch)
        m.submodules.a_latch_buffer  = a_latch  = io.Buffer("o", self.control.a_latch)
        m.submodules.a_enable_buffer = a_enable = io.Buffer("o", self.control.a_enable)
        m.submodules.d_clock_buffer  = d_clock  = io.Buffer("o", self.control.d_clock)
        m.submodules.a_clock_buffer  = a_clock  = io.Buffer("o", self.control.a_clock)

        m.submodules.data_buffer = data = io.Buffer("io", self.data)

        ### use LED to indicate backpressure
        m.d.comb += led.o.eq(~serializer.usb_stream.ready)

        ### connect buffers to data + control signals
        m.d.comb += [
            x_latch.o.eq(executor.bus.dac_x_le_clk),
            y_latch.o.eq(executor.bus.dac_y_le_clk),
            a_latch.o.eq(executor.bus.adc_le_clk),
            a_enable.o.eq(executor.bus.adc_oe),
            d_clock.o.eq(executor.bus.dac_clk),
            a_clock.o.eq(executor.bus.adc_clk),

            data.o.eq(executor.bus.data_o),
            data.oe.eq(executor.bus.data_oe),

            #data.oe.eq(~self.control.power_good.i),
            #control.oe.eq(~self.control.power_good.i)
        ]

        #### External IO control logic  
        def connect_pins(pin_name: str, signal):
            if hasattr(self.ports, pin_name):
                if self.ports[f"{pin_name}"] is not None:
                    if not hasattr(m.submodules, f"{pin_name}_buffer"):
                        m.submodules[f"{pin_name}_buffer"] = io.Buffer("o", self.ports[f"{pin_name}"])
                    # drive every pin in port with 1-bit signal
                    for pin in m.submodules[f"{pin_name}_buffer"].o:
                        m.d.comb += pin.eq(signal)
        
        connect_pins("ebeam_scan_enable", executor.ext_ctrl_enable)      
        connect_pins("ibeam_scan_enable", executor.ext_ctrl_enable)
        connect_pins("ebeam_blank_enable", executor.ext_ctrl_enable)
        connect_pins("ibeam_blank_enable", executor.ext_ctrl_enable)

        with m.If(executor.ext_ctrl_enabled):
            with m.If(executor.beam_type == BeamType.NoBeam):
                connect_pins("ebeam_blank", 1)
                connect_pins("ibeam_blank", 1)

            with m.Elif(executor.beam_type == BeamType.Electron):
                connect_pins("ebeam_blank", executor.blank_enable)
                connect_pins("ibeam_blank", 1)
                
            with m.Elif(executor.beam_type == BeamType.Ion):
                connect_pins("ibeam_blank", executor.blank_enable)
                connect_pins("ebeam_blank", 1)
        with m.Else():
            # Do not blank if external control is not enabled
            connect_pins("ebeam_blank",0) #TODO: check diff pair behavior here
            connect_pins("ibeam_blank",0)
        
        #=================================================================== end resources

        if self.loopback: ## In loopback mode, connect input to output
            m.submodules.loopback_adapter = loopback_adapter = PipelinedLoopbackAdapter(executor.adc_latency)
            wiring.connect(m, executor.bus, flipped(loopback_adapter.bus))

            loopback_dwell_time = Signal()
            if self.loopback:
                m.d.sync += loopback_dwell_time.eq(executor.cmd_stream.payload.type == CmdType.RasterPixel)

            with m.If(loopback_dwell_time):
                m.d.comb += loopback_adapter.loopback_stream.eq(executor.supersampler.dac_stream_data.dwell_time)
            with m.Else():
                m.d.comb += loopback_adapter.loopback_stream.eq(executor.supersampler.super_dac_stream.payload.dac_x_code)
        else: ## if not in loopback, connect input to external input
            m.d.comb += executor.bus.data_i.eq(data.i)
            

        if self.benchmark:
            m.d.comb += self.out_stall_cycles.eq(executor.supersampler.stall_cycles)
            m.d.comb += executor.supersampler.stall_count_reset.eq(self.stall_count_reset)
            out_stall_event = Signal()
            begin_write = Signal()
            with m.If(self.stall_count_reset):
                # m.d.sync += self.out_stall_cycles.eq(0)
                m.d.sync += self.out_stall_events.eq(0)
                m.d.sync += out_stall_event.eq(0)
                m.d.sync += begin_write.eq(0)
            with m.Else():
                with m.If(self.out_fifo.r_rdy):
                    m.d.sync += begin_write.eq(1)
                with m.If(begin_write):
                    with m.If(~self.out_fifo.r_rdy):
                        with m.If(~out_stall_event):
                            m.d.sync += out_stall_event.eq(1)
                            with m.If(~(self.out_stall_events >= 65536)):
                                m.d.sync += self.out_stall_events.eq(self.out_stall_events + 1)
                    with m.Else():
                        m.d.sync += out_stall_event.eq(0)

        return m
