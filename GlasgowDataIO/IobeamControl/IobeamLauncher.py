
import asyncio

from types import SimpleNamespace

import usb1
#from .IobeamDemux import IobeamDemux
from .applet.DataStreamApplet import DataStreamApplet
from .glasgowLib.glasgow.hardware.device import GlasgowDevice
from .glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from .glasgowLib.glasgow.hardware.assembly import HardwareAssembly
from .glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from .glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexerInterface
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.definitions import Consts
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts
from IobeamControl.glasgowLib.glasgow.abstract import GlasgowPin
from AutomationPy.buildingblocks.workflow.workstate import WorkState
import logging 
import usb1
from .glasgowLib.glasgow.hardware.device import REQ_REGISTER, REQ_FPGA_CFG, ST_FPGA_RDY
from .glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer

logger = logging.getLogger(__name__)

def hard_reset_fx2():
    
    with usb1.USBContext() as context: # Use 'with' to ensure context.close()       
        handle = context.openByVendorIDAndProductID(0x20b7, 0x9db1)
        if handle:
            print("Forcing FX2 CPU Reset...")
            handle.controlWrite(0x40, 0xA0, 0xE600, 0, b'\x01')
            handle.controlWrite(0x40, 0xA0, 0xE600, 0, b'\x00')
            handle.close()

class IobeamLauncher(object):
    def __init__(self, config):
        super(IobeamLauncher, self).__init__()
        self._config = config

    #@staticmethod
    async def start(self, deviceId=None):
        return await self.run()

    #@staticmethod
    async def run(self):
        stateConfig = util.GetStateConfigByName(self._config, Consts.STREAM_DATA) 
        deviceId = self._config.Glasgow.get("DeviceId")
        actionConfig = stateConfig.get(Consts.ACTION_DATA)

        device = GlasgowDevice(deviceId)
        #await asyncio.sleep(0.1)
        #await device.control_read(usb1.REQUEST_TYPE_VENDOR, 0x13, 0x00, 0, 1)
        target = GlasgowHardwareTarget(revision=device.revision, multiplexer_cls=DirectMultiplexer)
        applet = DataStreamApplet()  
        
        action_voltage = actionConfig.get("voltage", 2.5)
        buffer_size = eval(actionConfig.get('bufferSize', '1024*1024')) # default to 10MB buffer if not specified
        pin_list = [f"{p.get('port')}{n}" for p in actionConfig.get("ports", []) for n in p.get("pinList", [])]
        
        applet_args = SimpleNamespace(
            voltage_map={"A": action_voltage, "B": action_voltage},
            pins=GlasgowPin.parse(",".join(pin_list)) if pin_list else [],
            buffer_size = buffer_size,
            sample_rate=1000000
        )  


        applet.build(target, applet_args)
        device.demultiplexer = DirectDemultiplexer(device, target.multiplexer.pipe_count)
        plan = target.build_plan()
        plan.execute(plan.buildDir, debug=True)
        
        await device.download_target(plan, reload=True)
        await device.set_voltage("AB", action_voltage)

        #device.demultiplexer = DirectDemultiplexer(device, target.multiplexer.pipe_count)
        iface = await device.demultiplexer.claim_interface(applet, applet.mux_interface, applet_args,
                                                           read_buffer_size=applet_args.buffer_size, #16384*16384, 
                                                           write_buffer_size=applet_args.buffer_size) #16384*16384) 
         
        
        #device.demultiplexer = DirectDemultiplexer(device, target.multiplexer.pipe_count)      
        #iface = await applet.run(device, applet_args)
        await asyncio.sleep(1.5)
        #hard_reset_fx2()
        #await device.control_write(usb1.REQUEST_TYPE_VENDOR, 0x01, 0, 0, b'')

        #magic_val = await device.read_register(applet.addr_magic)
        #if magic_val != 0xa5:
            #raise RuntimeError(f"FPGA Not Responsive! Expected 0xa5, got {hex(magic_val)}")
        #device.clear_usb_stalls()

        status = await device._status()
        if not (status & ST_FPGA_RDY):
            raise RuntimeError("FPGA not ready — bitstream did not start correctly")

        magic_data = await asyncio.wait_for(
                                device.control_read(usb1.REQUEST_TYPE_VENDOR, REQ_REGISTER, 0x00, 0, 1), 
                                timeout=2.0)
        logger.info(f"Writing run gate: addr_reset={applet.addr_reset}, addr_magic={applet.addr_magic}")
        await device.write_register(applet.addr_reset, 1)
        await asyncio.sleep(0.5)
        #await applet.run_handshake(iface)

        return iface  

if __name__ == "__main__":   
    import argparse, os
    from pathlib import Path
    parser = argparse.ArgumentParser(description='Load FPGA image onto the device.')
    parser.add_argument('-j', action='store', dest='jsonfile', help="Config Json file path", default=os.path.realpath(r'./Development/GlasgowDataIO/Json/directIo.json'))
     
    args = parser.parse_args()
    if not Path(args.jsonfile).is_file():
        raise ValueError(f'Cannot find the JSON file {args.jsonfilej}')
    config = AutomationConfig(args.jsonfile)
    launcher = IobeamLauncher(config) if not config.Simulate else None
    asyncio.run(launcher.start())