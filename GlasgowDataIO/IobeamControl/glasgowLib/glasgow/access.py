from abc import ABCMeta, abstractmethod
from amaranth import *
from amaranth.lib import io

from .gateware.ports import PortGroup


__all__ = [
    "AccessMultiplexer", "AccessMultiplexerInterface",
    "AccessDemultiplexer", "AccessDemultiplexerInterface"
]


class AccessMultiplexer(Elaboratable, metaclass=ABCMeta):
    @abstractmethod
    def claim_interface(self, applet, args):
        pass


class AccessMultiplexerInterface(Elaboratable, metaclass=ABCMeta):
    def __init__(self, applet):
        self.applet = applet
        self.logger = applet.logger

    @abstractmethod
    def get_out_fifo(self, **kwargs):
        pass

    @abstractmethod
    def get_in_fifo(self, **kwargs):
        pass

    @abstractmethod
    def get_pin_name(self, pin):
        pass

    @abstractmethod
    def get_port_impl(self, pin, *, name):
        pass

    def get_port(self, pin_or_pins, *, name):
        if isinstance(pin_or_pins, list):
            if pin_or_pins == []:
                self.logger.debug("not assigning applet ports '%s[]' to any device pins", name)
                return None
            port = None
            for index, subpin in enumerate(pin_or_pins):
                subport = self.get_port(subpin, name=f"{name}[{index}]")
                if port is None:
                    port  = subport
                else:
                    port += subport
            assert port is not None
            return port
        else:
            if pin_or_pins is None:
                self.logger.debug("not assigning applet port '%s' to any device pin", name)
                return None
            return self.get_port_impl(pin_or_pins, name=name)

    def get_port_group(self, **kwargs):
        return PortGroup(**{
            name: self.get_port(pin_or_pins, name=name) for name, pin_or_pins in kwargs.items()
        })


class AccessDemultiplexer(metaclass=ABCMeta):
    def __init__(self, device):
        self.device = device
        self._interfaces = []

    @abstractmethod
    async def claim_interface(self, applet, mux_interface, args, timeout=None):
        pass

    async def flush(self):
        for iface in self._interfaces:
            await iface.flush()

    async def cancel(self):
        for iface in self._interfaces:
            await iface.cancel()

    def statistics(self):
        for iface in self._interfaces:
            iface.statistics()


class AccessDemultiplexerInterface(metaclass=ABCMeta):
    def __init__(self, device, applet):
        self.device = device
        self.applet = applet
        self.logger = applet.logger

    @abstractmethod
    async def cancel(self): ...
    @abstractmethod
    async def reset(self): ...
    @abstractmethod
    async def flush(self, wait=True): ...

    def statistics(self): pass

    # -----------------------------------------------------
    # Endpoint discovery
    # -----------------------------------------------------
    def set_usb_handle(self, mux_interface, read_buffer_size=16384*16384, write_buffer_size=16384*16384):
        import asyncio, usb1
        from .support.chunked_fifo import ChunkedFIFO
        from .support.task_queue import TaskQueue

        self._write_buffer_size = write_buffer_size
        self._read_buffer_size  = read_buffer_size
        self._in_pushback  = asyncio.Condition()
        self._out_inflight = 0

        self._pipe_num   = mux_interface._pipe_num
        self._addr_reset = mux_interface._addr_reset

        # ------------------------------------------------------------------ #
        # Endpoint scan — pipe-aware                                          #
        #                                                                     #
        # Glasgow FX2 firmware lays out endpoints across interfaces in order: #
        #                                                                     #
        # Config 2 (1 pipe):                                                  #
        #   If0 Alt1 → EP 0x02 OUT  (pipe 0)                                 #
        #   If1 Alt1 → EP 0x86 IN   (pipe 0)                                 #
        #                                                                     #
        # Config 1 (2 pipes):                                                 #
        #   If0 Alt1 → EP 0x02 OUT  (pipe 0)                                 #
        #   If1 Alt1 → EP 0x04 OUT  (pipe 1)                                 #
        #   If2 Alt1 → EP 0x86 IN   (pipe 0)                                 #
        #   If3 Alt1 → EP 0x88 IN   (pipe 1)                                 #
        #                                                                     #
        # To get the correct endpoints for pipe N, skip the first N OUT       #
        # endpoints and the first N IN endpoints encountered in the scan.     #
        # DirectDemultiplexer.__init__ must call setConfiguration() first     #
        # so that the right configuration is active before we scan here.      #
        # ------------------------------------------------------------------ #
        config_num = self.device.usb_handle.getConfiguration()
        config = None
        for cfg in self.device.usb_handle.getDevice().iterConfigurations():
            if cfg.getConfigurationValue() == config_num:
                config = cfg
                break
        assert config is not None, \
            f"Active USB configuration {config_num} not found in device descriptor"

        self._endpoint_in  = None
        self._endpoint_out = None
        self._in_interface  = None
        self._out_interface = None

        out_seen = 0  # how many OUT endpoints we have passed over
        in_seen  = 0  # how many IN  endpoints we have passed over

        for interface in config.iterInterfaces():
            for setting in interface.iterSettings():
                intf_num = setting.getNumber()
                for endpoint in setting.iterEndpoints():
                    address     = endpoint.getAddress()
                    packet_size = endpoint.getMaxPacketSize()
                    direction   = address & usb1.ENDPOINT_DIR_MASK

                    if direction == usb1.ENDPOINT_OUT:
                        if out_seen == self._pipe_num and self._endpoint_out is None:
                            self._endpoint_out   = address
                            self._out_packet_size = packet_size
                            self._out_interface  = intf_num
                            self.device.usb_handle.claimInterface(self._out_interface)
                            self.logger.info(
                                "pipe %d: OUT EP 0x%02x on interface %d (packet size %d)",
                                self._pipe_num, address, intf_num, packet_size)
                        out_seen += 1

                    elif direction == usb1.ENDPOINT_IN:
                        if in_seen == self._pipe_num and self._endpoint_in is None:
                            self._endpoint_in    = address
                            self._in_packet_size = packet_size
                            self._in_interface   = intf_num
                            self.device.usb_handle.claimInterface(self._in_interface)
                            self.logger.info(
                                "pipe %d: IN  EP 0x%02x on interface %d (packet size %d)",
                                self._pipe_num, address, intf_num, packet_size)
                        in_seen += 1

            # Stop scanning once both endpoints for this pipe have been found.
            if self._endpoint_out is not None and self._endpoint_in is not None:
                break

        if self._endpoint_out is None or self._endpoint_in is None:
            # Build a human-readable summary of what was actually found to aid diagnosis.
            found = []
            for interface in config.iterInterfaces():
                for setting in interface.iterSettings():
                    for ep in setting.iterEndpoints():
                        dir_str = "IN" if (ep.getAddress() & usb1.ENDPOINT_DIR_MASK) == usb1.ENDPOINT_IN else "OUT"
                        found.append(
                            f"If{setting.getNumber()} Alt{setting.getAlternateSetting()} "
                            f"EP 0x{ep.getAddress():02x} {dir_str}")
            raise AssertionError(
                f"Could not find both IN and OUT endpoints for pipe {self._pipe_num} "
                f"in USB config {config_num}.\n"
                f"Endpoints present: {found or ['(none)']}\n"
                f"Hint: DirectDemultiplexer.__init__ must call setConfiguration() before "
                f"set_usb_handle() is invoked.")

        self._in_tasks   = TaskQueue()
        self._in_buffer  = ChunkedFIFO()
        self._out_tasks  = TaskQueue()
        self._out_buffer = ChunkedFIFO()
        self._in_stalls  = 0
        self._out_stalls = 0

    # -----------------------------------------------------
    # USB I/O methods
    # Note: DirectDemultiplexerInterface in demultiplexer.py overrides read(),
    # write(), and flush() with pipelined async implementations. The
    # synchronous fallbacks below are only used when DirectDemultiplexerInterface
    # is NOT in the MRO (e.g. in tests or alternative demultiplexer implementations).
    # -----------------------------------------------------
    async def read(self, length=None, *, flush=True, timeout=1000):
        """
        Synchronous-style fallback read. Overridden by DirectDemultiplexerInterface.
        """
        import usb1
        if length is None:
            length = self._in_packet_size
        try:
            data = self.device.usb_handle.bulkRead(
                self._endpoint_in, length, timeout)
            return data
        except usb1.USBErrorTimeout:
            return b""
        except usb1.USBError as e:
            self.logger.error("USB bulkRead error on EP 0x%02x: %s", self._endpoint_in, e)
            raise

    async def write(self, data, timeout=1000):
        """
        Synchronous-style fallback write. Overridden by DirectDemultiplexerInterface.
        """
        import usb1
        total_written = 0
        offset = 0
        while offset < len(data):
            chunk = data[offset: offset + self._out_packet_size]
            try:
                written = self.device.usb_handle.bulkWrite(
                    self._endpoint_out, chunk, timeout)
            except usb1.USBError as e:
                self.logger.error("USB bulkWrite error on EP 0x%02x: %s", self._endpoint_out, e)
                raise
            if written <= 0:
                break
            offset        += written
            total_written += written
        return total_written
