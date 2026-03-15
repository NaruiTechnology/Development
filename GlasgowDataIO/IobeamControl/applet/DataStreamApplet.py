
import logging
import asyncio, struct, time
from EsmBeamController.Software.lib.glasgow.applet import GlasgowApplet

class DataStreamApplet(GlasgowApplet):
    required_revision = "C3"
    logger = logging.getLogger(__name__)
    help = "IobeamTech ADC data stream Applet"
    description = ""

    @classmethod
    def add_build_arguments(cls, parser, access):
        super().add_build_arguments(parser, access)

    def build(self, target, args):
        args.pipes = "PQ"
        self.mux_interface = iface = \
                target.multiplexer.claim_interface(self, args)  
        ports = iface.get_port_group(
        )
        subtarget_args = {
        }      
        return iface        
    
    async def run(self, device, args):
        iface = await device.demultiplexer.claim_interface(self, self.mux_interface, args,
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
