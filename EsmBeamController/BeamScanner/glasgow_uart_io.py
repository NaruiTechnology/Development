import asyncio
from glasgow.hardware.device import GlasgowDevice
from glasgow.applet.interface.uart import UARTInterface
from glasgow.hardware.assembly import HardwareAssembly
from glasgow.software.glasgow.applet import GlasgowAppletMetadata

class GlasgowUARTController:
    def __init__(self, port="A", tx_pin=0, rx_pin=1, baud=9600, deviceSeries='C3-20241215T152505Z'):
        self.port = port
        self.tx_pin = tx_pin
        self.rx_pin = rx_pin
        self.baud = baud
        self.device = None
        self.interface = None
        self.deviceSeries = deviceSeries

    async def connect(self):
        self.device = GlasgowDevice(self.deviceSeries)
        assembly = HardwareAssembly(device=self.device)

        # Configure and build UART applet
        applet_args = [
            "uart",
            "-p", self.port,
            "--tx", str(self.tx_pin),
            "--rx", str(self.rx_pin),
            "--baud", str(self.baud)
        ]
        # applet_clss = assembly.get_applet_class(applet_args[0]) # "uart")
        # applet = await self.device.build_applet(applet_args)
        applet = GlasgowAppletMetadata.get(applet_args[0]).load()
        self.interface = await self.device.run_applet(applet, UARTInterface)

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
            await self.device.__aexit__(None, None, None)
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


