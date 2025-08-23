import asyncio
# from glasgow.hardware.device import GlasgowDevice
from Software.lib.glasgow.hardware.device import GlasgowDevice
from Software.applets.BeamControlApplet import BeamControlApplet
from Software.applets.controllerTarget import OBISubtarget
from Software.lib.glasgow.legacy import DeprecatedTarget, DeprecatedDemultiplexer
from Software.lib.glasgow.hardware.assembly import HardwareAssembly
from Software.lib.glasgow.hardware.target import GlasgowHardwareTarget
from Software.lib.glasgow.hardware.multiplexer import DirectMultiplexer

import argparse, os
from types import SimpleNamespace


class GlasgowUARTController:
    def __init__(self, port="A", tx_pin=0, rx_pin=1, baud=9600, serial_number=None):
        self.port = port
        self.tx_pin = tx_pin
        self.rx_pin = rx_pin
        self.baud = baud
        self.serial_number = serial_number
        self.device = None
        self.interface = None
    
    # def setup_usb_config(self):
    #     import usb.core
    #     import usb.util

    #     # Constants for Glasgow USB device
    #     VENDOR_ID = 0x20b7
    #     PRODUCT_ID = 0x9db1

    #     # Find the device
    #     dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)

    #     if dev is None:
    #         raise ValueError("Glasgow device not found.")

    #     # Detach kernel driver if needed
    #     for intf_num in range(4):
    #         if dev.is_kernel_driver_active(intf_num):
    #             dev.detach_kernel_driver(intf_num)

    #     # Set configuration 1
    #     dev.set_configuration(1)
    #     cfg = dev.get_active_configuration()

    #     print(f"Active Configuration: {cfg.bConfigurationValue}, Interfaces: {cfg.bNumInterfaces}")

    #     # Set alternate setting 1 for interfaces 0–3
    #     for intf in cfg:
    #         if intf.bAlternateSetting == 1:
    #             continue  # already alt setting 1
    #         intf_num = intf.bInterfaceNumber
    #         try:
    #             usb.util.claim_interface(dev, intf_num)
    #             dev.set_interface_altsetting(interface=intf_num, alternate_setting=1)
    #             print(f"Set Interface {intf_num} to alternate setting 1.")
    #         except usb.core.USBError as e:
    #             print(f"Error setting Interface {intf_num} AltSetting 1: {e}")

    #     # Display active endpoints
    #     print("\nActive endpoints (after alt setting applied):")
    #     for intf in cfg:
    #         if intf.bAlternateSetting != 1:
    #             continue
    #         print(f"Interface {intf.bInterfaceNumber} (Alt {intf.bAlternateSetting}):")
    #         for ep in intf.endpoints():
    #             print(f"  Endpoint: address=0x{ep.bEndpointAddress:02X}, dir={'IN' if ep.bEndpointAddress & 0x80 else 'OUT'}")
    def setup_usb_config(self):
        import usb.core
        import usb.util

        # Constants for Glasgow USB device
        VENDOR_ID = 0x20b7
        PRODUCT_ID = 0x9db1

        # Find the device
        dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)

        if dev is None:
            raise ValueError("Glasgow device not found.")

        # Detach kernel driver if needed
        for intf_num in range(4):
            if dev.is_kernel_driver_active(intf_num):
                dev.detach_kernel_driver(intf_num)

        # Set configuration 1
        dev.set_configuration(1)
        cfg = dev.get_active_configuration()

        print(f"Active Configuration: {cfg.bConfigurationValue}, Interfaces: {cfg.bNumInterfaces}")

        # Set alternate setting 1 for interfaces 0–3
        for intf in cfg:
            if intf.bAlternateSetting == 1:
                continue  # already alt setting 1
            intf_num = intf.bInterfaceNumber
            try:
                usb.util.claim_interface(dev, intf_num)
                dev.set_interface_altsetting(interface=intf_num, alternate_setting=1)
                print(f"Set Interface {intf_num} to alternate setting 1.")
            except usb.core.USBError as e:
                print(f"Error setting Interface {intf_num} AltSetting 1: {e}")

        # Display active endpoints
        print("\nActive endpoints (after alt setting applied):")
        for intf in cfg:
            if intf.bAlternateSetting != 1:
                continue
            print(f"Interface {intf.bInterfaceNumber} (Alt {intf.bAlternateSetting}):")
            for ep in intf.endpoints():
                print(f"  Endpoint: address=0x{ep.bEndpointAddress:02X}, dir={'IN' if ep.bEndpointAddress & 0x80 else 'OUT'}")

    async def connect(self):
        try:
            from Software.configs.applet import OBIAppletArguments          
            
            # self.setup_usb_config()
                                                                         
            args = SimpleNamespace(
                port="A",
                x_pins=[f"{self.port}0"], # PinArgument(0)
                y_pins=[f"{self.port}1"], # PinArgument(1)
                operation="run",
                loopback = True,
                out_only = False,
                xflip = False, 
                yflip = False, 
                rotate90 = False,
                ext_switch_delay = 0.5,
                benchmark = True           
            )
            self.device = GlasgowDevice()#serial=self.serial_number)
            self.assembly = HardwareAssembly(device=self.device) 
                    
            # target = DeprecatedTarget(assembly=self.assembly) # using lelgacy code
            # applet = BeamControlApplet(target, args)

            voltage = 3.3
            await self.device.set_voltage("AB", voltage)
  
            target = GlasgowHardwareTarget(revision=self.device.revision, multiplexer_cls=DirectMultiplexer)
            applet = BeamControlApplet() # target, args)
            self.iface = applet.build(target, args)
            self.device.demultiplexer = target.multiplexer # OBIDemux(device, target.multiplexer.pipe_count)
            plan = target.build_plan()
            
            # await self.device.download_target(plan)
            # voltage = 5.0
            # await self.device.set_voltage("AB", voltage)
            
            from Software.configs.applet import OBIAppletArguments  
            
            from . import OBIDemux          
            args = OBIAppletArguments()
            args.parse_toml()
            args = args.args
            self.device.demultiplexer = OBIDemux(self.device, target.multiplexer.pipe_count) # target.multiplexer # OBIDemux(device, target.multiplexer.pipe_count)
            interface = await self.device.demultiplexer.claim_interface(applet, applet.mux_interface, args,
                                                            read_buffer_size=16384*16384, write_buffer_size=16384*16384)  
            interface.reset()  # Reset the interface to ensure it's ready for communication


        except Exception as e:
            raise RuntimeError(f"Failed to connect to Glasgow device: {e}")
        
        pass

    async def send(self, data: bytes):
        if not isinstance(data, bytes):
            data = data.encode("utf-8")

        if self.iface:
            await self.iface.write(data)
            await self.iface.flush()
        else:
            raise RuntimeError("UART interface not connected.")

    async def receive(self, size: int = 64, timeout: float = 2.0) -> bytes:
        if self.iface:
            try:
                return await asyncio.wait_for(self.iface.read(size), timeout=timeout)
            except asyncio.TimeoutError:
                return b""
        else:
            raise RuntimeError("UART interface not connected.")

    async def disconnect(self):
        if self.device:
            await self.device.close()
            self.device = None
            self.interface = None

async def main():
    uart = GlasgowUARTController(port="A", tx_pin=0, rx_pin=1, baud=9600) #, serial_number='C3-20241215T152505Z')
    await uart.connect()
    # await uart.send("Hello from Glasgow UART!\n")
    # response = await uart.receive()
    # print("Received:", response)
    # await uart.disconnect()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"[ERROR] {e}")   
    pass

