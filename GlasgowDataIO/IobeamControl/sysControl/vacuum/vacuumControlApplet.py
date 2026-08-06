"""Glasgow applet wrapper for the vacuum-control sub-target."""

import logging

from ...glasgowLib.glasgow.applet import GlasgowApplet
from .vacuumControlInterface import VacuumControlInterface
from .vacuumControlSubtarget import VacuumControlSubtarget


class VacuumControlApplet(GlasgowApplet):
    logger = logging.getLogger(__name__)
    help = "control vacuum equipment outputs and sample comparator inputs"
    description = """
    Atomically drives configured Port A vacuum-control outputs and returns a
    synchronized snapshot of the corresponding Port B comparator inputs.
    """
    required_revision = "C3"

    def build(self, target, args):
        self.mux_interface = iface = target.multiplexer.claim_interface(self, args)
        if iface is None:
            raise RuntimeError("unable to claim Glasgow interface for vacuum control")
        ports = iface.get_port_group(port_a=args.pin_a, port_b=args.pin_b)
        self._subtarget = VacuumControlSubtarget(
            ports=ports,
            out_fifo=iface.get_out_fifo(),
            in_fifo=iface.get_in_fifo(),
            channel_count=len(args.pin_a),
        )
        return iface.add_subtarget(self._subtarget)

    async def run(self, device, args):
        lower = await device.demultiplexer.claim_interface(
            self, self.mux_interface, args,
            read_buffer_size=args.buffer_size,
            write_buffer_size=args.buffer_size,
        )
        return VacuumControlInterface(lower, self.logger)
