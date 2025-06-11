from glasgow.device import GlasgowDevice
from glasgow.applet.interface import GlasgowAppletInterface

class GlasgowScanInterface:
    def __init__(self):
        self.device = GlasgowDevice()
        self.device.open()
        self.iface: GlasgowAppletInterface = self.device.instantiate_applet("ebeam-scan", args=[])

    def send_scan_point(self, x, y, eV):
        # Placeholder for sending values to FPGA registers
        self.iface.write_register("x_coord", int(x * 1000))
        self.iface.write_register("y_coord", int(y * 1000))
        self.iface.write_register("e_beam_voltage", int(eV * 1000))
        self.iface.write_register("trigger", 1)

    def read_reflection(self):
        return self.iface.read_register("reflect_out") / 1000.0
