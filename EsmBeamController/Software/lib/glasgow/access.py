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
    def __init__(self, device): #, read_buffer_size=16384*16384, write_buffer_size=16384*16384):
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

        config_num = self.device.usb_handle.getConfiguration()
        config = None
        for cfg in self.device.usb_handle.getDevice().iterConfigurations():
            if cfg.getConfigurationValue() == config_num:
                config = cfg
                break
        assert config is not None

        self._endpoint_in = None
        self._endpoint_out = None
        self._in_interface = None
        self._out_interface = None

        # Scan all interfaces + altsettings
        for interface in config.iterInterfaces():
            for setting in interface.iterSettings():
                intf_num = setting.getNumber()
                for endpoint in setting.iterEndpoints():
                    address = endpoint.getAddress()
                    packet_size = endpoint.getMaxPacketSize()
                    direction = address & usb1.ENDPOINT_DIR_MASK

                    if direction == usb1.ENDPOINT_OUT and self._endpoint_out is None:
                        self._endpoint_out = address
                        self._out_packet_size = packet_size
                        self._out_interface = intf_num
                        self.device.usb_handle.claimInterface(self._out_interface)
                        self.logger.info(f"Using OUT EP {hex(address)} (iface {self._out_interface}, packet {packet_size})")

                    elif direction == usb1.ENDPOINT_IN and self._endpoint_in is None:
                        self._endpoint_in = address
                        self._in_packet_size = packet_size
                        self._in_interface = intf_num
                        self.device.usb_handle.claimInterface(self._in_interface)
                        self.logger.info(f"Using IN EP {hex(address)} (iface {self._in_interface}, packet {packet_size})")


        assert self._endpoint_in is not None and self._endpoint_out is not None, \
            "Could not find both IN and OUT endpoints!"

        from .support.chunked_fifo import ChunkedFIFO
        from .support.task_queue import TaskQueue
        self._in_tasks   = TaskQueue()
        self._in_buffer  = ChunkedFIFO()
        self._out_tasks  = TaskQueue()
        self._out_buffer = ChunkedFIFO()
        self._in_stalls  = 0
        self._out_stalls = 0

    # -----------------------------------------------------
    # USB I/O methods
    # -----------------------------------------------------
    async def read(self, length=None, *, flush=True, timeout=1000):
        """
        Read from the IN endpoint. If length is None, try to read one packet.
        """
        import usb1
        if length is None:
            length = self._in_packet_size

        try:
            data = self.device.usb_handle.bulkRead(
                self._endpoint_in, length, timeout
            )
            return data
        except usb1.USBErrorTimeout:
            return b""
        except usb1.USBError as e:
            self.logger.error(f"USB bulkRead error: {e}")
            raise

    async def write(self, data, timeout=1000):
        """
        Write to the OUT endpoint. Handles large buffers by splitting into packets.
        """
        import usb1
        total_written = 0
        offset = 0
        while offset < len(data):
            chunk = data[offset: offset + self._out_packet_size]
            try:
                written = self.device.usb_handle.bulkWrite(
                    self._endpoint_out, chunk, timeout
                )
            except usb1.USBError as e:
                self.logger.error(f"USB bulkWrite error: {e}")
                raise
            if written <= 0:
                break
            offset += written
            total_written += written
        return total_written
