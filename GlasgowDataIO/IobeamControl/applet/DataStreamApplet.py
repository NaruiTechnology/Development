
import logging

import struct, time
from ..glasgowLib.glasgow.applet import GlasgowApplet
from glasgow.applet import GlasgowApplet
from .iobeamDataSubtarget import IobeamDataSubtarget

class DataStreamApplet(GlasgowApplet):
    required_revision = "C3"
    logger = logging.getLogger(__name__)
    help = "IobeamTech ADC data stream Applet"
    description = ""

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

        # Claim them ONCE here
        out_fifo = iface.get_out_fifo()
        in_fifo = iface.get_in_fifo()

        ports = iface.get_port_group(
            # TODO: we should support multiple pin sets for scan enable and blanking, but for now just use the first one if multiple are provided
            #
            # ebeam_scan_enable = args.pin_set_ebeam_scan_enable,
            # ibeam_scan_enable = args.pin_set_ibeam_scan_enable,
            # ebeam_blank_enable = args.pin_set_ebeam_blank_enable,
            # ibeam_blank_enable = args.pin_set_ibeam_blank_enable,
            # ebeam_blank = args.pin_set_ebeam_blank,
        )

        subtarget_args = {
            "ports": ports,
            "in_fifo": in_fifo,
            "out_fifo": out_fifo,
            #"loopback": args.loopback,
            #"transforms": Transforms(args.xflip, args.yflip, args.rotate90),
            #"out_only": args.out_only
        }

        if hasattr(args, 'ext_switch_delay'):  
            ext_delay_cycles = int(args.ext_switch_delay * pow(10, -3) / (1/(48 * pow(10,6))))
            subtarget_args.update({"ext_switch_delay": ext_delay_cycles})

        if hasattr(args, 'benchmark'):
            out_stall_events, self.__addr_out_stall_events = target.registers.add_ro(8, init=0)
            out_stall_cycles, self.__addr_out_stall_cycles = target.registers.add_ro(16, init=0)
            stall_count_reset, self.__addr_stall_count_reset = target.registers.add_rw(1, init=1)
            subtarget_args.update({"benchmark_counters": [out_stall_events, out_stall_cycles, stall_count_reset]})
    
        """ subtarget = IobeamDataSubtarget(
            ports=ports,
            out_fifo=out_fifo, # Connects USB Host -> FPGA
            in_fifo=in_fifo     # Connects FPGA -> USB Host
        ) """
        #subtarget = IobeamDataSubtarget(**subtarget_args)

        return iface #.add_subtarget(subtarget)       
    
    async def run(self, device, args):
        buffer_size = args.buffer_size if hasattr(args, 'buffer_size') else 1024*1024 # 16384*16384 --TODOW
        iface = await device.demultiplexer.claim_interface(self, self.mux_interface, args,
        read_buffer_size=buffer_size, write_buffer_size=buffer_size)
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
