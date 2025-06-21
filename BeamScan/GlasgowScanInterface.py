# from glasgow.software.glasgow.hardware.device import GlasgowDevice
# from glasgow.software import *
# from glasgow.hardware.boards import *

from glasgow.hardware.device import GlasgowDevice
from glasgow.software import *
from glasgow.applet import *
from glasgow.applet import GlasgowApplet
from glasgow.support.logging import dump_hex
from glasgow.support.endpoint import ServerEndpoint

from glasgow.hardware.device import GlasgowDeviceError
from glasgow.support.endpoint import endpoint

import random
import time


# TODO: from glasgow.applet import PinArgument
# TODO: from glasgow.software.glasgow.applet.interface import GlasgowAppletInterface
# TODO: from glasgow.hardware.multiplexer import _FIFOReadPort, _FIFOWritePort
# TODO: import glasgow.hardware.demultiplexer as glasgow_access
# TODO: from glasgow.hardware.target import GlasgowHardwareTarget

class GlasgowScanInterface:
    def __init__(self):
        self.device = GlasgowDevice()
        self.device.open()
        self.iface = self.device.instantiate_applet("ebeam-scan", args=[])
        pass
    
    def send_scan_point(self, x, y, eV):
        # Placeholder for sending values to FPGA registers
        self.iface.write_register("x_coord", int(x * 1000))
        self.iface.write_register("y_coord", int(y * 1000))
        self.iface.write_register("e_beam_voltage", int(eV * 1000))
        self.iface.write_register("trigger", 1)

    def read_reflection(self):
        return self.iface.read_register("reflect_out") / 1000.0
    
    def simulate_connection(self):
        print("Starting simulation...")
        for i in range(10):  # Simulate 10 scan points
            x = random.uniform(0, 10)  # Random x-coordinate
            y = random.uniform(0, 10)  # Random y-coordinate
            eV = random.uniform(1, 5)  # Random e-beam voltage
            print(f"Sending scan point: x={x:.2f}, y={y:.2f}, eV={eV:.2f}")
            self.send_scan_point(x, y, eV)
            time.sleep(0.5)  # Simulate delay
            reflection = random.uniform(0, 1)  # Simulated reflection value
            print(f"Reflection value: {reflection:.3f}")
        print("Simulation complete.")

if __name__ == "__main__":
    interface = GlasgowScanInterface()
    interface.simulate_connection()