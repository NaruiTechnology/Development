
import logging

import struct, time
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.applet import GlasgowApplet
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
        #self.mux_interface = iface =  target.multiplexer.claim_interface(self, args) 

        self.magic_reg, self.addr_magic = target.registers.add_ro(8, init=0xa5)
        """ self.reset_reg, addr_reset = target.registers.add_rw(8, init=0)
        self.addr_reset = addr_reset """
        
        self.reset_reg, addr_reset = target.registers.add_rw(8, init=0)
        self.addr_reset = addr_reset 
        self.mux_interface = iface =  target.multiplexer.claim_interface(self, args) 

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

        """ subtarget_args = {
            "ports": ports,
            "in_fifo": in_fifo,
            "out_fifo": out_fifo,
            #"loopback": args.loopback,
            #"transforms": Transforms(args.xflip, args.yflip, args.rotate90),
            #"out_only": args.out_only
            "magic_reg": self.magic_reg,
            "_addr_reset": addr_reset
        } """
   
        subtarget = IobeamDataSubtarget(
                ports=iface.get_port_group(),
                in_fifo=in_fifo,
                out_fifo=out_fifo,
                magic_reg=self.magic_reg,
                _addr_reset=self.reset_reg 
            )
        #subtarget = IobeamDataSubtarget(**subtarget_args)
        return iface.add_subtarget(subtarget)       
    
    async def run(self, device, args):
        # This is the OBI approach: Return the interface 
        # let the Launcher/Connection handle the high-level streaming.
        await device.write_register(applet.addr_reset, 0x01)
        return await device.demultiplexer.claim_interface(self, self.mux_interface, args)

    async def run_handshake(self, iface):
        print("Synchronizing with Glasgow hardware...")
        
        # 1. Generate a unique 16-bit cookie
        cookie_val = 0x1234 
        # Command Format: [ID=0 (Sync), Cookie_High, Cookie_Low, Mode]
        sync_cmd = struct.pack('>BHB', 0, cookie_val, 1) 
        
        # 2. Clear the pipes
        await iface.write(sync_cmd)
        await iface.flush()
        
        # 3. Block until the FPGA echoes the cookie back
        # This is where the -1 error is prevented; we don't proceed until sync is confirmed.
        reply = await iface.read(4)
        
        if len(reply) < 4:
            raise RuntimeError("Handshake failed: No response from hardware")
            
        print(f"Handshake successful. Hardware echo: {reply.hex()}")

