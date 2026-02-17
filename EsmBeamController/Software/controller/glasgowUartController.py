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
    

    def enumerate_usb_interfaces(self):  
        import usb.core
        import usb.util

        # Find Glasgow device
        dev = usb.core.find(idVendor=0x20b7, idProduct=0x9db1)
        if dev is None:
            raise ValueError("Glasgow device not found")

        print(f"Glasgow device found: {dev}")

        # USB endpoint type mapping
        EP_TYPE = {
            0: "Control",
            1: "Isochronous",
            2: "Bulk",
            3: "Interrupt",
        }

        # Iterate over all configurations
        for cfg in dev:
            print(f"\nConfiguration {cfg.bConfigurationValue}:")
            for intf in cfg:
                print(f" Interface {intf.bInterfaceNumber}:")
                print(f"   Class/SubClass/Protocol: {intf.bInterfaceClass}/"
                    f"{intf.bInterfaceSubClass}/{intf.bInterfaceProtocol}")
                
                for ep in intf:
                    direction = "IN" if (ep.bEndpointAddress & 0x80) else "OUT"
                    ep_type = EP_TYPE.get(ep.bmAttributes & 0x3, "Unknown")
                    print(f"   Endpoint 0x{ep.bEndpointAddress:02x}: {direction}, Type: {ep_type}")

                # Check kernel driver
                try:
                    if dev.is_kernel_driver_active(intf.bInterfaceNumber):
                        print("   Status: claimed by kernel driver")
                    else:
                        print("   Status: free")
                except usb.core.USBError:
                    print("   Status: unable to query kernel driver")

                                        

    async def connect(self):
        try:
            from Software.configs.applet import OBIAppletArguments          
            

            self.enumerate_usb_interfaces()  # Enumerate USB interfaces
                                                                         
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
            self.device = GlasgowDevice() #serial=self.serial_number)
            self.assembly = HardwareAssembly(device=self.device) 
            
            # target = DeprecatedTarget(assembly=self.assembly) # using lelgacy code
            # applet = BeamControlApplet(target, args)

            voltage = 3.3 # 1.8 
            await self.device.set_voltage("AB", voltage)
  
            target = GlasgowHardwareTarget(revision=self.device.revision, multiplexer_cls=DirectMultiplexer)
            applet = BeamControlApplet() # target, args)
            self.iface = applet.build(target, args)
            self.device.demultiplexer = target.multiplexer # OBIDemux(device, target.multiplexer.pipe_count)
            plan = target.build_plan()
            
            #await self.device.download_target(plan, reload=True)
                     
            from Software.configs.applet import OBIAppletArguments  
            
            from . import OBIDemux          
            args = OBIAppletArguments()
            args.parse_toml()
            args = args.args
            self.device.demultiplexer = OBIDemux(self.device, target.multiplexer.pipe_count) # target.multiplexer # OBIDemux(device, target.multiplexer.pipe_count)
            self.iface = await self.device.demultiplexer.claim_interface(applet, applet.mux_interface, args,
                                                            read_buffer_size=16384*16384, write_buffer_size=16384*16384)  
            self.iface.reset()  # Reset the interface to ensure it's ready for communication


        except Exception as e:
            raise RuntimeError(f"Failed to connect to Glasgow device: {e}")
        
        pass

    async def send(self, data: bytes):
        """ if not isinstance(data, bytes):
            data = data.encode("utf-8") """

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

