import asyncio
# from glasgow.hardware.device import GlasgowDevice
from Software.lib.glasgow.hardware.device import GlasgowDevice
from Software.applets.BeamControlApplet import BeamControlApplet
from Software.applets.controllerTarget import OBISubtarget
from Software.lib.glasgow.legacy import DeprecatedTarget, DeprecatedDemultiplexer
from Software.lib.glasgow.hardware.assembly import HardwareAssembly

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


    async def connect(self):
        try:
            from Software.configs.applet import OBIAppletArguments
            args = SimpleNamespace(
                port="A",
                x_pins=[f"{self.port}0"], # PinArgument(0)
                y_pins=[f"{self.port}1"], # PinArgument(1)
                operation="run"
            )
            self.device = GlasgowDevice(serial=self.serial_number)
            self.assembly = HardwareAssembly(device=self.device)
            # applet = BeamControlApplet()            
            target = DeprecatedTarget(assembly=self.assembly)
            applet = BeamControlApplet(target, args)
            self.iface = applet.build(target, args)
            self.device.demultiplexer = target.multiplexer # OBIDemux(device, target.multiplexer.pipe_count)
            plan = target.build_plan()
            await self.device.download_target(plan)
            voltage = 5.0
            await self.device.set_voltage("AB", voltage)
            self.iface = await self.device.demultiplexer.claim_interface(applet, applet.mux_interface, args,
                                            # read_buffer_size=131072*16, write_buffer_size=131072*16)
                                            read_buffer_size=16384*16384, write_buffer_size=16384*16384)
            await self.iface.reset()

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
    uart = GlasgowUARTController(port="A", tx_pin=0, rx_pin=1, baud=9600, serial_number='C3-20241215T152505Z')
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


