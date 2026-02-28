import asyncio, struct, time
from usb1 import USBError

from amaranth import *
from amaranth.lib import enum, data, io, wiring
from amaranth.lib.fifo import SyncFIFOBuffered
from amaranth.lib.wiring import In, Out, flipped
from amaranth.build import Resource, Pins

# from commands import BaseCommand
from ..lib.glasgow.support.logging import dump_hex

from ..lib.glasgow.applet import GlasgowApplet
# from glasgow.hardware.device import GlasgowDeviceError
from ..lib.glasgow.hardware.device import GlasgowDeviceError
from ..lib.glasgow.support.endpoint  import ServerEndpoint

from ..commands.structs import Transforms
from ..commands.low_level_commands import ExternalCtrlCommand

import logging
logger = logging.getLogger()

#------- using legacy code ----------
# class BeamControlApplet(Elaboratable):
#     def __init__(self, target, args):
#         self.x_pins = args.x_pins
#         self.y_pins = args.y_pins
#         self.port = args.port
#         self.target = target

#     def elaborate(self, platform):
#         m = Module()

#         # --- Request each GPIO pin individually
#         x_pin = self.target.request(f"{self.port}{self.x_pins[0].number}", dir="o")
#         y_pin = self.target.request(f"{self.port}{self.y_pins[0].number}", dir="o")

#         # --- Add the physical pins to the platform
#         platform.add_resources([
#             Resource("x_output", 0, Pins(f"{self.port}{self.x_pins[0].number}", dir="o")),
#             Resource("y_output", 0, Pins(f"{self.port}{self.y_pins[0].number}", dir="o")),
#         ])

#         # --- Create simple scan waveform (toggle both pins)
#         counter = Signal(24)
#         toggle = Signal()

#         m.d.sync += counter.eq(counter + 1)
#         with m.If(counter == 1_000_000):  # adjustable scan speed
#             m.d.sync += [
#                 toggle.eq(~toggle),
#                 counter.eq(0)
#             ]

#         m.d.comb += [
#             x_pin.o.eq(toggle),
#             y_pin.o.eq(~toggle),
#         ]

#         return m
#------ end of using legaccy code --------------------------

class BeamControlApplet(GlasgowApplet):
    """
    Beam Control Applet for Glasgow.
    This applet is used to control the beam scanner hardware.
   """
    required_revision = "C3"
    logger = logging.getLogger(__name__)
    help = "NaruiTech Beam Control Applet"
    description = """
    Scanning beam control applet
    """
    @classmethod
    def add_build_arguments(cls, parser, access):
        super().add_build_arguments(parser, access)

        access.add_pin_set_argument(parser, "ebeam_scan_enable", range(1,3))
        access.add_pin_set_argument(parser, "ibeam_scan_enable", range(1,3))
        access.add_pin_set_argument(parser, "ebeam_blank_enable", range(1,3))
        access.add_pin_set_argument(parser, "ibeam_blank_enable", range(1,3))
        access.add_pin_set_argument(parser, "ibeam_blank", range(1,3))
        access.add_pin_set_argument(parser, "ebeam_blank", range(1,3))


        parser.add_argument("--loopback",
            dest = "loopback", action = 'store_true',
            help = "connect output and input streams internally")
        parser.add_argument("--benchmark",
            dest = "benchmark", action = 'store_true',
            help = "run benchmark test")
        parser.add_argument("--xflip",
            dest = "xflip", action = 'store_true',
            help = "flip x axis")
        parser.add_argument("--yflip",
            dest = "yflip", action = 'store_true',
            help = "flip y axis")
        parser.add_argument("--rotate90",
            dest = "rotate90", action = 'store_true',
            help = "switch x and y axes")
        parser.add_argument("--out_only",
            dest = "out_only", action = 'store_true',
            help = "use FastBusController instead of BusController; don't use ADC")
        parser.add_argument("--ext_switch_delay", type=int, default=0,
            help="time for external control switch to actuate, in ms")


    def build(self, target, args):
        args.pipes = "PQ"
        self.mux_interface = iface = \
                target.multiplexer.claim_interface(self, args)
                
        # return iface                
        # TODO: ================================
        ports = iface.get_port_group(
            # ebeam_scan_enable = args.pin_set_ebeam_scan_enable,
            # ibeam_scan_enable = args.pin_set_ibeam_scan_enable,
            # ebeam_blank_enable = args.pin_set_ebeam_blank_enable,
            # ibeam_blank_enable = args.pin_set_ibeam_blank_enable,
            # ebeam_blank = args.pin_set_ebeam_blank,
            # ibeam_blank = args.pin_set_ibeam_blank,
        )

        subtarget_args = {
            #"ports": ports,
            #"in_fifo": iface.get_in_fifo(depth=512, auto_flush=False),
            #"out_fifo": iface.get_out_fifo(depth=512),
            #"loopback": args.loopback,
            #"transforms": Transforms(args.xflip, args.yflip, args.rotate90),
            #"out_only": args.out_only
        }

        """ if args.ext_switch_delay:
            ext_delay_cycles = int(args.ext_switch_delay * pow(10, -3) / (1/(48 * pow(10,6))))
            subtarget_args.update({"ext_switch_delay": ext_delay_cycles})

        if args.benchmark:
            out_stall_events, self.__addr_out_stall_events = target.registers.add_ro(8, init=0)
            out_stall_cycles, self.__addr_out_stall_cycles = target.registers.add_ro(16, init=0)
            stall_count_reset, self.__addr_stall_count_reset = target.registers.add_rw(1, init=1)
            subtarget_args.update({"benchmark_counters": [out_stall_events, out_stall_cycles, stall_count_reset]})
 """
        # subtarget = OBISubtarget(**subtarget_args)

        # return iface.add_subtarget(subtarget)
        return iface
        # return iface.add_subtarget(GlasgowTarge(**subtarget_args))

    # @classmethod
    # def add_run_arguments(cls, parser, access):
    #     super().add_run_arguments(parser, access)

    async def run(self, device, args):
        # ========== GlasgowSimulationDevice is no longer supported
        # from glasgow.device.simulation import GlasgowSimulationDevice
        # if isinstance(device, GlasgowSimulationDevice):
        #     iface = await device.demultiplexer.claim_interface(self, self.mux_interface, args)
        # else:
        #     iface = await device.demultiplexer.claim_interface(self, self.mux_interface, args,
        #         # read_buffer_size=131072*16, write_buffer_size=131072*16)
        #         read_buffer_size=16384*16384, write_buffer_size=16384*16384)
        iface = await device.demultiplexer.claim_interface(self, self.mux_interface, args,
        # read_buffer_size=131072*16, write_buffer_size=131072*16)
        read_buffer_size=16384*16384, write_buffer_size=16384*16384)
        
        if args.benchmark:
            output_mode = 2 #no output
            raster_mode = 0 #no raster
            mode = int(output_mode<<1 | raster_mode)
            sync_cmd = struct.pack('>BHB', 0, 123, mode)
            flush_cmd = struct.pack('>B', 2)
            await iface.write(sync_cmd)
            await iface.write(flush_cmd)
            await iface.flush()
            await iface.read(4)
            print(f"got cookie!")
            commands = bytearray()
            print("generating block of commands...")
            for _ in range(131072*16):
                commands.extend(struct.pack(">BHHH", 0x14, 0, 16383, 1))
                commands.extend(struct.pack(">BHHH", 0x14, 16383, 0, 1))
            length = len(commands)
            print("writing commands...")
            while True:
                await device.write_register(self.__addr_stall_count_reset, 1)
                await device.write_register(self.__addr_stall_count_reset, 0)
                begin = time.time()
                await iface.write(commands)
                await iface.flush()
                end = time.time()
                out_stall_events = await device.read_register(self.__addr_out_stall_events)
                out_stall_cycles = await device.read_register(self.__addr_out_stall_cycles, width=2)
                self.logger.info("benchmark: %.2f MiB/s (%.2f Mb/s)",
                                 (length / (end - begin)) / (1 << 20),
                                 (length / (end - begin)) / (1 << 17))
                self.logger.info(f"out stalls: {out_stall_events}, stalled cycles: {out_stall_cycles}")
                
        else:
            return iface

    @classmethod
    def add_interact_arguments(cls, parser):
        ServerEndpoint.add_argument(parser, "endpoint")

    async def interact(self, device, args, iface):

        class InterceptedError(Exception):
            """
            An error that is only raised in response to GlasgowDeviceError or USBError.
            Should /always/ be triggered when the USB cable is unplugged.
            """
            pass

        class ForwardProtocol(asyncio.Protocol):
            logger = self.logger

            #TODO: will no longer be needed if Python requirement is bumped to 3.13
            def intercept_err(self, func):
                def if_err(err):
                    self.transport.write_eof()
                    self.transport.close()
                    raise InterceptedError(err)

                async def wrapper(*args, **kwargs):
                    try:
                        await func(*args, **kwargs)
                    except USBError as err:
                        if_err(err)
                    except GlasgowDeviceError as err:
                        if_err(err)
                return wrapper

            async def reset(self):
                await iface.reset()
                await iface.write(bytes(ExternalCtrlCommand(enable=False)))
                self.logger.debug("reset")
                self.logger.debug(iface.statistics())

            def connection_made(self, transport):
                self.backpressure = False
                self.send_paused = False

                transport.set_write_buffer_limits(131072*16)

                self.transport = transport
                peername = self.transport.get_extra_info("peername")
                self.logger.info("connect peer=[%s]:%d", *peername[0:2])

                async def initialize():
                    await self.reset()
                    asyncio.create_task(self.send_data())
                self.init_fut = asyncio.create_task(initialize())

                self.flush_fut = None
            
            async def send_data(self):
                self.send_paused = False
                self.logger.debug("awaiting read")

                @self.intercept_err
                async def read_send_data():
                    data = await iface.read(flush=False)

                    if self.transport:
                        self.logger.debug(f"in-buffer size={len(iface._in_buffer)}")
                        self.logger.debug("dev->net <%s>", dump_hex(data))
                        self.transport.write(data)
                        await asyncio.sleep(0)
                        if self.backpressure:
                            self.logger.debug("paused send due to backpressure")
                            self.send_paused = True
                        else:
                            asyncio.create_task(self.send_data())
                    else:
                        self.logger.debug("dev->🗑️ <%s>", dump_hex(data))

                await read_send_data()

            
            def pause_writing(self):
                self.backpressure = True
                self.logger.debug("dev->NG")

            def resume_writing(self):
                self.backpressure = False
                self.logger.debug("dev->OK->net")
                if self.send_paused:
                    asyncio.create_task(self.send_data())

            
            def data_received(self, data):
                @self.intercept_err
                async def recv_data():
                    await self.init_fut
                    if not self.flush_fut == None:
                        self.transport.pause_reading()
                        try:
                            await self.flush_fut
                        except Exception: #USBErrorOther:
                            self.transport.write_eof()
                            print("Wrote EOF")
                        self.transport.resume_reading()
                        self.logger.debug("net->dev flush: done")
                    self.logger.debug("net->dev <%s>", dump_hex(data))
                    await iface.write(data)
                    self.logger.debug("net->dev write: done")

                    @self.intercept_err
                    async def flush():
                        await iface.flush(wait=True)
                            
                    self.flush_fut = asyncio.create_task(flush())


                asyncio.create_task(recv_data())

            def connection_lost(self, exc):
                peername = self.transport.get_extra_info("peername")
                self.logger.info("disconnect peer=[%s]:%d", *peername[0:2], exc_info=exc)
                self.transport = None

                asyncio.create_task(self.reset())
                
        proto, *proto_args = args.endpoint
        server = await asyncio.get_event_loop().create_server(ForwardProtocol, *proto_args, backlog=1)

        def handler(loop, context):
            if "exception" in context.keys():
                if isinstance(context["exception"], InterceptedError):
                    #TODO: in python 3.13, use server.close_clients()
                    self.logger.warning("Device Error detected.")
                    server.close()
                    self.logger.warning("Forcing Server To Close...")            


        loop = asyncio.get_running_loop()
        loop.set_exception_handler(handler)
        
        try:
            self.logger.info("Start OBI Server")
            await server.serve_forever()
        except asyncio.CancelledError:
            self.logger.warning("Server shut down due to device error.\n Check device connection.")
        finally:
            self.logger.info("OBI Server Closed.")
       
class GlasgowTarge(wiring.Component):    
    pass       