
import asyncio

from types import SimpleNamespace
from ..IobeamControl.IobeamDemux import IobeamDemux
from .applet.DataStreamApplet import DataStreamApplet
from glasgowLib.glasgow.hardware.device import GlasgowDevice
from glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from glasgowLib.glasgow.hardware.assembly import HardwareAssembly
from glasgowLib.glasgow.abstract import GlasgowPin
from glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer

class IobeamLauncher():
    @staticmethod
    async def start(deviceId=None):
        return await IobeamLauncher.run(deviceId)

    @staticmethod
    async def run(deviceId=None):
        device = GlasgowDevice(deviceId)
        target = GlasgowHardwareTarget(revision=device.revision, multiplexer_cls=DirectMultiplexer)
        assembly = HardwareAssembly(revision=device.revision)
        applet = DataStreamApplet()  

        #action_data = self.ParentWorkThread._config["Actions"][0]["streamData"]["actionData"]        
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

        plan = target.build_plan()  
        iface = applet.build(target, applet_args)
        device.demultiplexer = IobeamDemux(device, target.multiplexer.pipe_count)
        iface = await device.demultiplexer.claim_interface(applet, iface, applet_args,
                                                           read_buffer_size=16384*16384, 
                                                           write_buffer_size=16384*16384) 
        return iface        


if __name__ == "__main__":    
    launcher = IobeamLauncher()
    asyncio.run(launcher.start())