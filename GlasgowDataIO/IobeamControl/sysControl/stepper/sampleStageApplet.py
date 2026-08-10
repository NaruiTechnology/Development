"""Two-axis TMC5160 SPI applet for the dedicated stage Glasgow."""
import logging

from ...glasgowLib.glasgow.applet.interface.spi_controller import (
    SPIControllerApplet, SPIControllerInterface,
)
from .sampleStageSubtarget import SampleStageSubtarget
from .tmc5160Interface import TMC5160Interface


class SampleStageAxisApplet(SPIControllerApplet):
    logger = logging.getLogger(__name__)

    def __init__(self, axis):
        self.axis = str(axis).upper()

    def build(self, target, args):
        self.mux_interface = iface = target.multiplexer.claim_interface(self, args)
        self._subtarget = SampleStageSubtarget(
            self.axis,
            ports=iface.get_port_group(sck=args.sck, cs=args.cs, copi=args.copi, cipo=args.cipo),
            out_fifo=iface.get_out_fifo(),
            in_fifo=iface.get_in_fifo(auto_flush=False),
            period_cyc=self.derive_clock(
                input_hz=target.sys_clk_freq, output_hz=args.frequency * 1000,
                clock_name=f"{self.axis.lower()}_sck", min_cyc=4,
            ),
            delay_cyc=self.derive_clock(
                input_hz=target.sys_clk_freq, output_hz=1e6,
                clock_name=f"{self.axis.lower()}_delay",
            ),
            sck_idle=args.sck_idle,
            sck_edge=args.sck_edge,
        )
        iface.add_subtarget(self._subtarget)

    async def run(self, device, args):
        lower = await device.demultiplexer.claim_interface(self, self.mux_interface, args)
        return TMC5160Interface(SPIControllerInterface(lower, self.logger), self.logger)


class SampleStageApplet:
    def __init__(self, axes):
        self.axes = axes
        self._applets = {name: SampleStageAxisApplet(name) for name in axes}

    def build(self, target, args_by_axis):
        for name in ("X", "Y"):
            self._applets[name].build(target, args_by_axis[name])

    async def run(self, device, args_by_axis):
        return {
            name: await self._applets[name].run(device, args_by_axis[name])
            for name in ("X", "Y")
        }
