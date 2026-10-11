import math
import asyncio
import sys

import usb1

from ..support.logging import *
from ..support.chunked_fifo import *
from ..support.task_queue import *
from ..access import AccessDemultiplexer, AccessDemultiplexerInterface, AccessMultiplexer
from .device import GlasgowDeviceError, ST_FPGA_RDY
import logging
logger = logging.getLogger(__name__)

# Per-transfer FIFO messages were raised to INFO during USB bring-up. At scan
# rates they cost tens of thousands of log records per frame on the host path
# that must keep the FPGA fed, so they go back to upstream Glasgow's TRACE
# level. Enable with logging.getLogger(...).setLevel(5) when debugging USB.
_TRACE = 5
if logging.getLevelName(_TRACE) != "TRACE":
    logging.addLevelName(_TRACE, "TRACE")

_max_packets_per_ep = 1024
_packets_per_xfer   = 32
_xfers_per_queue    = min(16, _max_packets_per_ep // _packets_per_xfer)


class DirectDemultiplexer(AccessDemultiplexer):
    def __init__(self, device, pipe_count):
        super().__init__(device)
        self._claimed = set()

        target_iface_count = pipe_count * 2
        current_config_val = device.usb_handle.getConfiguration()

        target_config = None
        # Windows USB drivers cannot select the second configuration. The
        # active four-interface configuration also supports a one-pipe applet.
        if sys.platform == "win32":
            for cfg in device.usb_handle.getDevice().iterConfigurations():
                if (cfg.getConfigurationValue() == current_config_val and
                        cfg.getNumInterfaces() >= target_iface_count):
                    target_config = cfg
                    break
        for cfg in device.usb_handle.getDevice().iterConfigurations():
            if target_config is not None:
                break
            if cfg.getNumInterfaces() == target_iface_count:
                target_config = cfg
                break

        if target_config is None:
            available = [c.getNumInterfaces()
                         for c in device.usb_handle.getDevice().iterConfigurations()]
            raise GlasgowDeviceError(
                f"No USB configuration found for {pipe_count} pipe(s) "
                f"({target_iface_count} interfaces needed). "
                f"Available interface counts: {available}")

        if target_config.getConfigurationValue() != current_config_val:
            logger.debug(
                "switching USB config %d→%d (%d pipe(s), %d interfaces)",
                current_config_val, target_config.getConfigurationValue(),
                pipe_count, target_iface_count)

            current_iface_count = DirectDemultiplexer._num_interfaces_for_config(
                device, current_config_val)
            for intf_num in range(current_iface_count):
                try:
                    device.usb_handle.releaseInterface(intf_num)
                    logger.debug("released interface %d before config switch", intf_num)
                except (usb1.USBErrorNotFound, usb1.USBErrorNoDevice):
                    pass

            try:
                device.usb_handle.setConfiguration(
                    target_config.getConfigurationValue())
                logger.debug("USB config %d now active",
                             target_config.getConfigurationValue())
            except (usb1.USBErrorInvalidParam, usb1.USBErrorNotSupported):
                logger.warning(
                    "setConfiguration() not supported on this platform; "
                    "continuing with current config")

            try:
                device.usb_handle.claimInterface(0)
                logger.debug("re-claimed interface 0 after config switch")
            except (usb1.USBErrorNotSupported, usb1.USBErrorBusy):
                pass
        else:
            logger.debug("USB config %d already active (%d pipe(s))",
                         current_config_val, pipe_count)

    @staticmethod
    def _num_interfaces_for_config(device, config_val):
        for cfg in device.usb_handle.getDevice().iterConfigurations():
            if cfg.getConfigurationValue() == config_val:
                return cfg.getNumInterfaces()
        return 0

    async def claim_interface(self, applet, mux_interface, args,
                              pull_low=set(), pull_high=set(), activate=True, **kwargs):
        assert mux_interface._pipe_num not in self._claimed
        self._claimed.add(mux_interface._pipe_num)

        if activate:
            await self._check_fpga_ready("before USB interface claiming")
        iface = DirectDemultiplexerInterface(self.device, applet, mux_interface, **kwargs)
        if activate:
            await self._check_fpga_ready("after USB interface claiming")
        self._interfaces.append(iface)

        if hasattr(args, "mirror_voltage") and args.mirror_voltage:
            for port in args.port_spec:
                await self.device.mirror_voltage(port)
                applet.logger.info("port %s voltage set to %.1f V",
                                   port, await self.device.get_voltage(port))
        elif hasattr(args, "voltage") and args.voltage is not None:
            await self.device.set_voltage(args.port_spec, args.voltage)
            applet.logger.info("port(s) %s voltage set to %.1f V",
                               ", ".join(sorted(args.port_spec)), args.voltage)
        elif hasattr(args, "keep_voltage") and args.keep_voltage:
            applet.logger.info("port voltage unchanged")

        if activate:
            await self._check_fpga_ready("after I/O voltage setup")

        device_pull_low  = set()
        device_pull_high = set()
        for pin_arg in pull_low:
            (device_pull_high if pin_arg.invert else device_pull_low).add(pin_arg.number)
        for pin_arg in pull_high:
            (device_pull_low if pin_arg.invert else device_pull_high).add(pin_arg.number)

        if self.device.has_pulls:
            if self.device.revision == "C0":
                if pull_low or pull_high:
                    applet.logger.error(
                        "Glasgow revC0 has severe restrictions on use of configurable "
                        "pull resistors; device may require power cycling")
                    await self.device.set_pulls(
                        args.port_spec, device_pull_low, device_pull_high)
            elif hasattr(args, "port_spec"):
                await self.device.set_pulls(
                    args.port_spec, device_pull_low, device_pull_high)
                if activate:
                    await self._check_fpga_ready("after I/O pull-resistor setup")
                device_pull_desc = []
                if device_pull_high:
                    device_pull_desc.append(
                        f"pull-up on {', '.join(map(str, device_pull_high))}")
                if device_pull_low:
                    device_pull_desc.append(
                        f"pull-down on {', '.join(map(str, device_pull_low))}")
                if not device_pull_desc:
                    device_pull_desc.append("disabled")
                applet.logger.debug("port(s) %s pull resistors: %s",
                                    ", ".join(sorted(args.port_spec)),
                                    "; ".join(device_pull_desc))
            if activate:
                await iface._activate()

        elif device_pull_low or device_pull_high:
            if device_pull_low:
                applet.logger.warning(
                    "port(s) %s requires external pull-down resistors on pins %s",
                    ", ".join(sorted(args.port_spec)),
                    ", ".join(map(str, device_pull_low)))
            if device_pull_high:
                applet.logger.warning(
                    "port(s) %s requires external pull-up resistors on pins %s",
                    ", ".join(sorted(args.port_spec)),
                    ", ".join(map(str, device_pull_high)))
            if activate:
                await iface.reset()
        else:
            if activate:
                await iface._activate()

        return iface

    async def _check_fpga_ready(self, stage):
        status = await self.device._status()
        logger.info("FPGA readiness %s: status=0x%02x", stage, status)
        if not status & ST_FPGA_RDY:
            raise GlasgowDeviceError(
                f"FPGA is not configured {stage} (status=0x{status:02x})")


class DirectDemultiplexerInterface(AccessDemultiplexerInterface):
    def __init__(self, device, applet, mux_interface,
                 read_buffer_size=None, write_buffer_size=None):
        super().__init__(device, applet)
        self.set_usb_handle(mux_interface, read_buffer_size, write_buffer_size)

    async def cancel(self):
        if self._in_tasks or self._out_tasks:
            self.logger.info("FIFO: cancelling operations")
            await self._in_tasks.cancel()
            await self._out_tasks.cancel()

    async def _activate(self):
        logger.warning(
            "FIFO: _activate pipe=%d  OUT EP=0x%02x If=%d  IN EP=0x%02x If=%d  config=%d",
            self._pipe_num,
            self._endpoint_out, self._out_interface,
            self._endpoint_in,  self._in_interface,
            self.device.usb_handle.getConfiguration())

        # A new host connection may reuse an already-running bitstream. In
        # that case the gateware is not reset by FPGA configuration, so its
        # command parser and FIFOs may still contain state from the previous
        # connection. Always assert the interface reset before activating the
        # USB endpoints; it is deasserted below after the read queue is ready.

        await self.device.write_register(self._addr_reset, 1)

        for intf_num in [self._in_interface, self._out_interface]:
            try:
                self.device.usb_handle.setInterfaceAltSetting(intf_num, 1)
                logger.warning("setInterfaceAltSetting If%d alt=1 OK", intf_num)
            except Exception as exc:
                raise GlasgowDeviceError(
                    f"setInterfaceAltSetting(interface={intf_num}, alt=1) failed: {exc}"
                ) from exc

        try:
            self.device.usb_handle.clearHalt(self._endpoint_out)
        except Exception as exc:
            logger.warning("clearHalt EP 0x%02x skipped: %s", self._endpoint_out, exc)

        self._in_buffer.clear()
        self._out_buffer.clear()

        logger.warning("FIFO: pipelining %d reads on EP 0x%02x",
                       _xfers_per_queue, self._endpoint_in)
        for _ in range(_xfers_per_queue):
            self._in_tasks.submit(self._in_task())

        await asyncio.sleep(0)

        # Deassert the multiplexer hardware reset so the subtarget can run.
        # DirectMultiplexerInterface adds a reset register (init=1) that holds
        # the subtarget in ResetInserter reset until explicitly cleared here.
        logger.warning("FIFO: deasserting multiplexer reset (addr=%d)", self._addr_reset)
        await self.device.write_register(self._addr_reset, 0)
        logger.warning("FIFO: _activate complete")

    async def reset(self):
        await self.cancel()
        self.logger.info("asserting reset")
        await self.device.write_register(self._addr_reset, 1)
        await self._activate()

    async def _in_task(self):
        if self._read_buffer_size is not None:
            async with self._in_pushback:
                while len(self._in_buffer) > self._read_buffer_size:
                    self.logger.info("FIFO: read pushback")
                    await self._in_pushback.wait()

        size = self._in_packet_size * _packets_per_xfer
        data = await self.device.bulk_read(self._endpoint_in, size)
        self._in_buffer.write(data)
        self._in_tasks.submit(self._in_task())

    async def read(self, length=None, *, flush=True):
        if flush and len(self._out_buffer) > 0:
            await self.flush(wait=False)

        if length is None and len(self._in_buffer) > 0:
            length = len(self._in_buffer)
        elif length is None:
            self._in_stalls += 1
            await self._in_tasks.wait_one()
            length = len(self._in_buffer)
        else:
            self._in_stalls += 1
            while len(self._in_buffer) < length:
                self.logger.log(_TRACE, "FIFO: need %d bytes", length - len(self._in_buffer))
                await self._in_tasks.wait_one()

        async with self._in_pushback:
            result = self._in_buffer.read(length)
            self._in_pushback.notify_all()
        if len(result) < length:
            chunks  = [result]
            length -= len(result)
            while length > 0:
                async with self._in_pushback:
                    chunk = self._in_buffer.read(length)
                    self._in_pushback.notify_all()
                chunks.append(chunk)
                length -= len(chunk)
            result = memoryview(b"".join(chunks))

        self.logger.log(_TRACE, "FIFO: read <%s>", dump_hex(result))
        return result

    def _out_slice(self):
        size = self._out_packet_size * _packets_per_xfer
        data = self._out_buffer.read(size)
        if len(data) < self._out_packet_size:
            data = bytearray(data)
            while len(data) < self._out_packet_size and self._out_buffer:
                data += self._out_buffer.read(self._out_packet_size - len(data))
        self._out_inflight += len(data)
        return data

    @property
    def _out_threshold(self):
        out_xfer_size = self._out_packet_size * _packets_per_xfer
        if self._write_buffer_size is None:
            return out_xfer_size
        return min(self._write_buffer_size, out_xfer_size)

    async def _out_task(self, data):
        assert len(data) > 0
        try:
            await self.device.bulk_write(self._endpoint_out, data)
        finally:
            self._out_inflight -= len(data)
        if len(self._out_buffer) >= self._out_threshold:
            self._out_tasks.submit(self._out_task(self._out_slice()))

    async def write(self, data):
        if self._write_buffer_size is not None:
            if self._out_inflight >= self._write_buffer_size:
                self._out_stalls += 1
            while self._out_inflight >= self._write_buffer_size:
                self.logger.info("FIFO: write pushback")
                await self._out_tasks.wait_one()
        await self._out_tasks.poll()
        self.logger.log(_TRACE, "FIFO: write <%s>", dump_hex(data))
        self._out_buffer.write(data)
        while (len(self._out_tasks) < _xfers_per_queue and
               len(self._out_buffer) >= self._out_threshold):
            self._out_tasks.submit(self._out_task(self._out_slice()))

    async def flush(self, wait=True):
        self.logger.log(_TRACE, "FIFO: flush")
        if len(self._out_tasks) >= _xfers_per_queue:
            self._out_stalls += 1
        while len(self._out_tasks) >= _xfers_per_queue:
            await self._out_tasks.wait_one()
        assert len(self._out_buffer) <= self._out_packet_size * _packets_per_xfer
        if self._out_buffer:
            data = bytearray()
            while self._out_buffer:
                data += self._out_buffer.read()
            self._out_inflight += len(data)
            self._out_tasks.submit(self._out_task(data))
        if wait:
            self.logger.log(_TRACE, "FIFO: wait for flush")
            if self._out_tasks:
                self._out_stalls += 1
            while self._out_tasks:
                await self._out_tasks.wait_all()

    def statistics(self):
        self.logger.info("FIFO statistics:")
        self.logger.info("  read total    : %d B", self._in_buffer.total_read_bytes)
        self.logger.info("  written total : %d B", self._out_buffer.total_written_bytes)
        self.logger.info("  reads waited  : %.3f s", self._in_tasks.total_wait_time)
        self.logger.info("  writes waited : %.3f s", self._out_tasks.total_wait_time)
        self.logger.info("  read stalls   : %d", self._in_stalls)
        self.logger.info("  write stalls  : %d", self._out_stalls)
        self.logger.info("  read wakeups  : %d", self._in_tasks.total_wait_count)
        self.logger.info("  write wakeups : %d", self._out_tasks.total_wait_count)
