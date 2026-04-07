
import asyncio

from types import SimpleNamespace

import usb1
from .IobeamDemux import IobeamDemux
from .applet.DataStreamApplet import DataStreamApplet
from .glasgowLib.glasgow.hardware.device import REQ_FPGA_CFG, GlasgowDevice
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
from .glasgowLib.glasgow.hardware.device import REQ_BITSTREAM_ID, REQ_FPGA_CFG, ST_FPGA_RDY

from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware import device

logger = logging.getLogger(__name__)

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
        device = GlasgowDevice(deviceId)
        target = GlasgowHardwareTarget(revision=device.revision, multiplexer_cls=DirectMultiplexer)
        assembly = HardwareAssembly(revision=device.revision)
        applet = DataStreamApplet()  
        actionConfig = stateConfig.get(Consts.ACTION_DATA)
        action_voltage = actionConfig.get("voltage", 2.5)
        voltages_map = {"A": action_voltage, "B": action_voltage}
        pin_list = []
        for p in actionConfig.get("ports", []):
            port_letter = p.get("port")
            for pin_num in p.get("pinList", []):
                pin_list.append(f"{port_letter}{pin_num}")
        
        # 'voltages' must be a Mapping[GlasgowPort, float] for assembly.py
        buffer_size = eval(actionConfig.get('bufferSize', '1024*1024')) # default to 10MB buffer if not specified
        applet_args = SimpleNamespace(
            cs=GlasgowPin.parse("A0"),    
            sck=GlasgowPin.parse("A1"),
            copi=GlasgowPin.parse("A2"),
            reset=GlasgowPin.parse("A3"),
            #magic=0xa5, 
            #magic_pin=GlasgowPin.parse("B0"),
            #target = "ice40-hx1k-vq100",
            voltage_map=voltages_map,
            pins=GlasgowPin.parse(",".join(pin_list)) if pin_list else [],
            buffer_size = buffer_size,
            benchmark = False,
            sample_rate=1000000
        )             
        iface = applet.build(target, applet_args)
        plan = target.build_plan()  
        bitstream, stdout = plan.execute(plan.buildDir, debug=True)
        plan.execute(plan.buildDir, debug=False)
        #await device.download_target(plan)
        index = 0
        while index * 4096 < len(bitstream):
            await device.control_write(usb1.REQUEST_TYPE_VENDOR, REQ_FPGA_CFG,
                                    0, index, bitstream[index * 4096:(index + 1) * 4096])
            index += 1
        await asyncio.sleep(0.5)
        await device.control_write(usb1.REQUEST_TYPE_VENDOR, REQ_BITSTREAM_ID,
                                0, 0, plan.bitstream_id)
        await asyncio.sleep(0.2)
        await device.set_voltage("AB", action_voltage)
        await asyncio.sleep(0.1)
        status = await device._status()    
        if not (status & ST_FPGA_RDY):
            raise RuntimeError("FPGA did not become ready after configuration") 

        device.demultiplexer = IobeamDemux(device, target.multiplexer.pipe_count)
        iface = await device.demultiplexer.claim_interface(applet, applet.mux_interface, applet_args,
                                                           read_buffer_size=applet_args.buffer_size, #16384*16384, 
                                                           write_buffer_size=applet_args.buffer_size) #16384*16384) 
        await asyncio.sleep(0.1)
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