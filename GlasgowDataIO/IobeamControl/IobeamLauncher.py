
import asyncio

from types import SimpleNamespace
from .IobeamDemux import IobeamDemux
from .applet.DataStreamApplet import DataStreamApplet
from .glasgowLib.glasgow.hardware.device import GlasgowDevice
from .glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from .glasgowLib.glasgow.hardware.assembly import HardwareAssembly
from .glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.definitions import Consts
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts
from IobeamControl.glasgowLib.glasgow.abstract import GlasgowPin
from glasgow.applet.program.ice40_sram import ICE40SRAMInterface
import logging

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
        applet = DataStreamApplet(assembly)  
        
        actionConfig = stateConfig.get(Consts.ACTION_DATA)
        action_voltage = actionConfig.get("voltage", 2.5)
        voltages_map = {"A": action_voltage, "B": action_voltage}
        pin_list = []
        for p in actionConfig.get("ports", []):
            port_letter = p.get("port")
            for pin_num in p.get("pinList", []):
                pin_list.append(f"{port_letter}{pin_num}")
        
        # 'voltages' must be a Mapping[GlasgowPort, float] for assembly.py
        buffer_size = eval(actionConfig.get('bufferSize', '16384*16384'))
        applet_args = SimpleNamespace(
            voltage_map=voltages_map,
            pins=GlasgowPin.parse(",".join(pin_list)) if pin_list else [],
            buffer_size = buffer_size,
            benchmark = False
        )             

        iface = applet.build(target, applet_args)
        plan = target.build_plan()  

        build_result = plan.execute() 
        if hasattr(build_result, "data"):
            bitstream = build_result.data
        elif hasattr(build_result, "bitstream"):
            bitstream = build_result.bitstream
        else:
            bitstream = build_result 
        print(f"Bitstream size: {len(bitstream)} bytes")
        try:
            programmer = ICE40SRAMInterface(
                logger=logger, 
                assembly=assembly,
                cs=GlasgowPin.parse("A0")[0].number,    
                sck=GlasgowPin.parse("A1")[0].number,
                copi=GlasgowPin.parse("A2")[0].number,
                reset=GlasgowPin.parse("A3")[0].number
            )
            await programmer.program(bitstream) # This programs the FPGA
        except Exception as e:
            logger.error(f"Programming failed: {e}")
            raise e

        
        device.demultiplexer = IobeamDemux(device, target.multiplexer.pipe_count)
        iface = await device.demultiplexer.claim_interface(applet, iface, applet_args,
                                                           read_buffer_size=applet_args.buffer_size, #16384*16384, 
                                                           write_buffer_size=applet_args.buffer_size) #16384*16384) 
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
    launcher = IobeamLauncher(config)
    asyncio.run(launcher.start())