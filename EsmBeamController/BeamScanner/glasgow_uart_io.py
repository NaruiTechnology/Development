import asyncio
from glasgow.hardware.device import GlasgowDevice
# from glasgow.applet.interface.uart import UARTInterface
from glasgow.applet.interface.uart import UARTInterface, UARTApplet

# from glasgow.software.glasgow.applet.interface.uart import UARTInterface, UARTApplet
# from glasgow.software.glasgow.applet.interface.uart import UARTInterface, UART
# from glasgow.hardware.assembly import HardwareAssembly

# from glasgow.software.glasgow.hardware.assembly import HardwareAssembly
# from glasgow.software.glasgow.applet import GlasgowAppletMetadata

from glasgow.software.glasgow.hardware.assembly import HardwareAssembly
from glasgow.software.glasgow.applet.interface.uart import UARTApplet, UARTInterface
import argparse
# from types import SimpleNamespace


# class GlasgowUARTController:
#     def __init__(self, port="A", tx_pin=0, rx_pin=1, baud=9600, deviceSeries='C3-20241215T152505Z'):
#         self.port = port
#         self.tx_pin = tx_pin
#         self.rx_pin = rx_pin
#         self.baud = baud
#         self.device = None
#         self.interface = None
#         self.deviceSeries = deviceSeries

#     async def connect(self):
#         try:
#             # self.device = GlasgowDevice(self.deviceSeries)
#             # assembly = HardwareAssembly(device=self.device)

#             # Configure and build UART applet
#             applet_args = [
#                 "uart",
#                 "-p", self.port,
#                 "--tx", str(self.tx_pin),
#                 "--rx", str(self.rx_pin),
#                 "--baud", str(self.baud)
#             ]
            
#             # applet = GlasgowAppletMetadata.get(applet_args[0]).load()
#             applet = UARTApplet()
#             self.interface = await self.device.run_applet(applet, UARTInterface)
#         except Exception as e:
#             raise RuntimeError(f"Failed to connect to Glasgow device: {e}")
        

#     async def send(self, data: bytes):
#         if not isinstance(data, bytes):
#             data = data.encode("utf-8")

#         if self.interface:
#             await self.interface.write(data)
#             await self.interface.flush()
#         else:
#             raise RuntimeError("UART interface not connected.")

#     async def receive(self, size: int = 64, timeout: float = 2.0) -> bytes:
#         if self.interface:
#             try:
#                 return await asyncio.wait_for(self.interface.read(size), timeout=timeout)
#             except asyncio.TimeoutError:
#                 return b""
#         else:
#             raise RuntimeError("UART interface not connected.")

#     async def disconnect(self):
#         if self.device:
#             await self.device.__aexit__(None, None, None)
#             self.device = None
#             self.interface = None


class GlasgowUARTController:
    def __init__(self, port="A", tx_pin=0, rx_pin=1, baud=9600, serial_number=None):
        self.port = port
        self.tx_pin = tx_pin
        self.rx_pin = rx_pin
        self.baud = baud
        self.serial_number = serial_number
        self.device = None
        self.interface = None

#     async def connect(self):
#         try:
#             self.device = GlasgowDevice(serial=self.serial_number)
#             self.assembly = HardwareAssembly(device=self.device)
#             # Connect real GPIO pins
#             self.assembly.connect_pins(
#                 f"{self.port}{self.tx_pin}", f"{self.port}{self.rx_pin}"
#             )

#             applet = UARTApplet(self.assembly)

#             # Build the arguments required by UARTApplet
#             args = SimpleNamespace(
#                 port=self.port,
#                 tx=self.tx_pin,
#                 rx=self.rx_pin,
#                 baud=self.baud,
#                 operation="run",   
#             )

#             # Run applet with real hardware args
#             await applet.run(args)
#             self.interface = getattr(applet, "uart_iface", None)

#             if not isinstance(self.interface, UARTInterface):
#                 raise RuntimeError("Failed to initialize UART interface.")
#             self.interface = await applet.run()
#             if not isinstance(self.interface, UARTInterface):
#                 raise RuntimeError("Failed to initialize UART interface.")

#         except Exception as e:
#             raise RuntimeError(f"Failed to connect to Glasgow device: {e}")
    async def connect(self):
        try:
            # Step 1: Initialize device and assembly
            self.device = GlasgowDevice(serial=self.serial_number)
            self.assembly = HardwareAssembly(device=self.device)

            # Step 2: Create UARTApplet with the hardware assembly
            applet = UARTApplet(self.assembly)

            # Step 3: Build parsed arguments (Namespace object) with required attributes
            args = argparse.Namespace(
                port=self.port,
                tx=self.tx_pin,
                rx=self.rx_pin,
                baudrate=self.baud,
                parity=None,
                bits=8,
                stop_bits=1,
                operation="run",
                voltage=None,
                extclk=False,
                divclk=False,
                in_clk=None,
                out_clk=None,
                debug=False
            )

            # # Step 4: Run the applet
            # await applet.run(args)

            # # Step 5: Retrieve UART interface
            # self.interface = getattr(applet, "uart_iface", None)
            # self.interface = await applet.run(args)
            # await self.assembly.build_applet(applet, args)
            # self.interface = await self.assembly.run_applet(applet, args, UARTInterface)
            # self.uart_iface = UARTInterface(...)
            await applet.run(args)
            self.interface = getattr(applet, "uart_iface", None)
            if not isinstance(self.interface, UARTInterface):
                raise RuntimeError("Failed to initialize UART interface.")
        except Exception as e:
            raise RuntimeError(f"Failed to connect to Glasgow device: {e}")

    async def send(self, data: bytes):
        if not isinstance(data, bytes):
            data = data.encode("utf-8")

        if self.interface:
            await self.interface.write(data)
            await self.interface.flush()
        else:
            raise RuntimeError("UART interface not connected.")

    async def receive(self, size: int = 64, timeout: float = 2.0) -> bytes:
        if self.interface:
            try:
                return await asyncio.wait_for(self.interface.read(size), timeout=timeout)
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
    uart = GlasgowUARTController(port="A", tx_pin=0, rx_pin=1, baud=9600)
    await uart.connect()
    await uart.send("Hello from Glasgow UART!\n")
    response = await uart.receive()
    print("Received:", response)
    await uart.disconnect()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"[ERROR] {e}")


