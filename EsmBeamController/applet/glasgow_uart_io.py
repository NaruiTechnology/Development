import asyncio
import logging
from glasgow.hardware.device import GlasgowDevice
import usb1 as usb

class GlasgowUARTController:
    def __init__(self, port="A", tx_pin=0, rx_pin=1, baud=9600):
        self.port = port
        self.tx_pin = tx_pin
        self.rx_pin = rx_pin
        self.baud = baud
        self.device = None
        self.transport = None
        self.iface = None
        self._logger = logging.getLogger(__name__)  

    async def connect(self):
        self.transport = await usb.USBTransfer() # GlassgowDeviceTransport.acquire()
        self.device = GlasgowDevice(self.transport)
        await self.device.allocate()
        await self.device.run()

        uart_applet = await self.device.attach_applet("uart", {
            "port": self.port,
            "tx": str(self.tx_pin),
            "rx": str(self.rx_pin),
            "baud": str(self.baud)
        })
        try:
            self.iface = await uart_applet.run()
            self._logger.info(f"[UART] Connected at {self.baud} baud")
        except asyncio.TimeoutError as et:
            self._logger.error(f"[UART] Connection timed out: {e}")
        except Exception as e:
            self._logger.error(f"[UART] Connection failed: {e}")

    async def send(self, data: bytes):
        if not self.iface:
            raise RuntimeError("UART interface not initialized. Call connect() first.")
        if not isinstance(data, bytes):
            data = data.encode()
        try:
            await self.iface.write(data)
            await self.iface.flush()
            self._logger.info(f"[UART] Sent: {data}")
        except Exception as e:
            self._logger.error(f"[UART] send data {data} failed: {e}")
            
    async def receive(self, num_bytes=64, timeout=2.0):
        if not self.iface:
            raise RuntimeError("UART interface not initialized. Call connect() first.")
        try:
            data = await asyncio.wait_for(self.iface.read(num_bytes), timeout)
            self._logger.info(f"[UART] Received: {data}")
            return data
        except asyncio.TimeoutError:
            self._logger.error(f"[UART] receive timeout after {timeout} seconds")
        except Exception as e:
            self._logger.error(f"[UART] receive failed: {e}")

    async def disconnect(self):
        if self.device:
            await self.device.deallocate()
        if self.transport:
            await self.transport.close()
        print("[UART] Disconnected")

async def main():
    uart = GlasgowUARTController(port="A", tx_pin=0, rx_pin=1, baud=9600)
    await uart.connect()
    await uart.send("Hello from Glasgow UART!\n")
    await uart.disconnect()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"Error occurred: {e}")

#===========================================================================
# import asyncio
# # from glasgow.cli import GlasgowAppletV2
# from glasgow.applet import GlasgowAppletV2
# # from glasgow.support.binary import *
# # from glasgow.support.hwinfo import HardwareInfo

# class GlasgowUART(GlasgowAppletV2):
#     def __init__(self, port="A", tx_pin=0, rx_pin=1, baud=9600):
#         self.port = port
#         self.tx_pin = tx_pin
#         self.rx_pin = rx_pin
#         self.baud = baud

#     async def send_uart_data(self, data=b"Hello from Glasgow!"):
#         # app = GlasgowAppletV2()
#         # await app.run()

#         # device = await app.acquire_device()
#         # TODO: Use the device from the applet context
#         device = self.device
#         uart_iface = await device.attach_applet("uart", 
#             args={
#                 "port": self.port,
#                 "tx": str(self.tx_pin),
#                 "rx": str(self.rx_pin),
#                 "baud": str(self.baud)
#             })
#         try:
#             # Open UART interface
#             iface = await uart_iface.run()
#             print(f"Sending data: {data}")
#             await iface.write(data)
#             await iface.flush()
#         except asyncio.TimeoutError as et:
#             print(f"Send timed out: {et}")
#         except Exception as e:
#             print(f"Error occurred: {e}")
#         finally:
#             await device.release()

#     async def receive_uart_data(self, num_bytes=64, timeout=2.0):
#         # app = GlasgowAppletV2()
#         # await app.run()

#         # device = await app.acquire_device()
        
#         # TODO: Use the device from the applet context
#         device = self.device

#         uart_iface = await device.attach_applet("uart", 
#             args={
#                 "port": self.port,
#                 "tx": str(self.tx_pin),
#                 "rx": str(self.rx_pin),
#                 "baud": str(self.baud)
#             })

#         iface = await uart_iface.run()
#         print(f"Waiting to receive up to {num_bytes} bytes...")
#         try:
#             data = await asyncio.wait_for(iface.read(num_bytes), timeout=timeout)
#             print(f"Received data: {data}")
#         except asyncio.TimeoutError:
#             print("Receive timed out.")
#             data = b""
#         await device.release()
#         return data
    
#     # async def build(self, args):
#     #     return super().build(args)
#     async def build(self, args):
#         # Parse command line arguments
#         self.port = args.port
#         self.tx_pin = args.tx_pin
#         self.rx_pin = args.rx_pin
#         self.baud = args.baud
#         # Return the applet instance
#         return self

# # Run the asyncio loop
# if __name__ == "__main__":
#     uart = GlasgowUART()
#     asyncio.run(uart.send_uart_data())
#     # Example usage: receive data
#     # asyncio.run(uart.receive_uart_data())
    