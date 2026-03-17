
import asyncio

from types import SimpleNamespace
from IobeamDemux import IobeamDemux
from applet.DataStreamApplet import DataStreamApplet
from glasgowLib.glasgow.hardware.device import GlasgowDevice
from glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from glasgowLib.glasgow.hardware.assembly import HardwareAssembly
from glasgowLib.glasgow.abstract import GlasgowPin
from glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts

class IobeamLauncher(object):
    def __init__(self, config, taskName):
        super(IobeamLauncher, self).__init__()
        self._config = config
        self._taskName = taskName

    #@staticmethod
    async def start(self, deviceId=None):
        return await self.run(self._taskName)

    #@staticmethod
    async def run(self, taskName):
        stateConfig = util.GetStateConfigByName(self._config, taskName)
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
        applet_args = SimpleNamespace(
            voltage_map=voltages_map,
            pins=GlasgowPin.parse(",".join(pin_list)) if pin_list else []
        )             

        iface = applet.build(target, applet_args)
        plan = target.build_plan()  
        device.demultiplexer = IobeamDemux(device, target.multiplexer.pipe_count)
        iface = await device.demultiplexer.claim_interface(applet, iface, applet_args,
                                                           read_buffer_size=16384*16384, 
                                                           write_buffer_size=16384*16384) 
        return iface        


if __name__ == "__main__":   
    import argparse, os
    from pathlib import Path
    parser = argparse.ArgumentParser(description='Load FPGA image onto the device.')
    parser.add_argument('-j', action='store', dest='jsonfile', help="Config Json file path", default=os.path.realpath(r'./Development/GlasgowDataIO/Json/directIo.json'))
    parser.add_argument('-t', action='store', dest='taskName', help="Direct data IO task", default=r'patternScan')
 
    args = parser.parse_args()
    if not Path(args.jsonfile).is_file():
        raise ValueError(f'Cannot find the JSON file {args.jsonfilej}')
    config = AutomationConfig(args.jsonfile)
    launcher = IobeamLauncher(config, args.taskName)
    asyncio.run(launcher.start())