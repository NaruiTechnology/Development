import unittest
import struct
import array
from amaranth.sim import Simulator, Tick
from amaranth import *
from amaranth import DriverConflict
from amaranth.lib import wiring
from abc import ABCMeta, abstractmethod
import asyncio
import numpy as np

import logging
logger = logging.getLogger()

from commands.low_level_commands import *
from Software.applets.BeamControlApplet import *  # Add this import if BeamControlApplet is defined in this module
from Software.applets.controllerTarget import CommandParser

## support functions for prettier output 
def unpack_const(data):
    newmembers = {}
    members = data.shape().members
    for member in members:
        field = data.__getattr__(member)
        newmembers[member] = field
    return newmembers

def unpack_dict(data):
    all_data = {}
    for member in data:
        try:
            unpacked_data = unpack_const(data.get(member))
            all_data[member] = unpack_dict(unpacked_data)
        except Exception as e:
            all_data[member] = data.get(member)
    return all_data

def prettier_dict(data):
    try:
        data = unpack_const(data)
        if isinstance(data, dict):
            all_data = unpack_dict(data)
        else:
            all_data = data
    except: all_data = data
    return all_data

def filtered_dict(data, payload):
    data = prettier_dict(data)
    filtered_data = {}
    def unpack(data, payload, filtered_data):
        for signal, payload_value in payload.items():
            data_value = data[signal]
            if isinstance(data_value, dict):
                filtered_data[signal] = {}
                unpack(data_value, payload_value, filtered_data[signal])
            else:
                filtered_data[signal] = data_value
    if isinstance(data, dict):
        unpack(data, payload, filtered_data)
    else:
        filtered_data = data
    return filtered_data
    
def prettier_diff(data, payload:dict):
    summary = "\nSignal \t Expected \t Actual"
    data = filtered_dict(data, payload)
    def unpack_diff(data, payload):
        nonlocal summary
        for signal, payload_value in payload.items():
            data_value = data[signal]
            if isinstance(data_value, dict):
                unpack_diff(data_value, payload_value)
            else:
                summary += f"\n{signal}\t {payload_value}\t {data_value}"
                if payload_value != data_value:
                    summary += "\t<---"
    if isinstance(data, dict):
        unpack_diff(data, payload)
    else:
        summary += f"\n \t {payload} \t {data}"
    return summary

# Submit a test payload into a stream. Paayload gets put into stream.
async def put_stream(ctx, stream, payload, timeout_steps=10):
    ctx.set(stream.payload, payload)
    ctx.set(stream.valid, 1)
    ready = False
    timeout = 0
    while not ready:
        ready = ctx.get(stream.ready)
        logger.debug(f"put_stream: {ready=}, {timeout=}/{timeout_steps}")
        await ctx.tick()
        timeout += 1; assert timeout < timeout_steps
    logger.debug(f"put_stream: {ready=}, {timeout=}/{timeout_steps}")
    ctx.set(stream.valid, 0)
# Receive and validate a test payload from a stream. Payload gets compared against stream output.
async def get_stream(ctx, stream, payload, timeout_steps=10):
    ctx.set(stream.ready, 1)
    valid = False
    timeout = 0
    while not valid:
        _, _, valid, data = await ctx.tick().sample(stream.valid, stream.payload)
        logger.debug(f"get_stream: {valid=}, data={filtered_dict(data, payload)}")
        timeout += 1; assert timeout < timeout_steps
    logger.debug(f"get_stream: {valid=}, data={filtered_dict(data, payload)}")
    if isinstance(payload, dict):
        wrapped_payload = stream.payload.shape().const(payload)
    else:
        wrapped_payload = payload
    assert data == wrapped_payload, f"{prettier_diff(data, payload)}"
    ctx.set(stream.ready, 0) 
       

class TestControllerHub(unittest.TestCase):
    '''
    Creates a simulation with a set of testbenches

    Attributes
    ----------
    testbench - an Amaranth testbench bench(ctx) see amaranth.SimulatorContext
    name - str - name of vcd file to be generated
    '''
    def simulate(self, dut, testbenches, *, name="test"):
        logger.debug(f"running {name}")
        sim = Simulator(dut)
        sim.add_clock(20.83e-9)
        for testbench in testbenches:
            sim.add_testbench(testbench)
        try:
            # with sim.write_vcd(f"{name}.vcd"), sim.write_vcd(f"{name}+d.vcd", fs_per_delta=250_000):
            #     sim.run()
            sim.run()
        except:
            sim.reset()
            # with sim.write_vcd(f"{name}.vcd"), sim.write_vcd(f"{name}+d.vcd", fs_per_delta=250_000):
            #     sim.run()

    def setUp(self):
        pass

    def test_initial_beam_control_applet(self):
        try:
            BeamControlApplet()
        except Exception as exc:
            self.fail(f"Command parser failed with exception: {exc}")

    def test_command_parser(self):
        dut = CommandParser()
        def test_cmd(command:BaseCommand, name:str="cmd"):
            logger.debug(f"testing {command.fieldstr}")
            try:
                async def put_testbench(ctx):
                    for byte in bytes(command):
                        await put_stream(ctx, dut.usb_stream, byte)
                async def get_testbench(ctx):
                    d = command.as_dict()
                    logger.debug(f"{d=}")
                    await get_stream(ctx, dut.cmd_stream, d,
                        timeout_steps=len(command)*2 + 2)
                    await ctx.tick()
                    self.assertEqual(ctx.get(dut.cmd_stream.valid),0)
                self.simulate(dut, [get_testbench,put_testbench], name="parse_" + name)
            except Exception:
                pass

        test_cmd(SynchronizeCommand(cookie=1234, raster=True, output=OutputMode.NoOutput),"cmd_sync")
        test_cmd(AbortCommand(), "cmd_abort")
        test_cmd(FlushCommand(),"cmd_flush")
        test_cmd(ExternalCtrlCommand(enable=True), "cmd_extctrlenable")
        test_cmd(BeamSelectCommand(beam_type=BeamType.Electron),"cmd_selectebeam")
        test_cmd(BlankCommand(enable=True, inline=False),"cmd_blank")
        test_cmd(DelayCommand(delay=960),"cmd_delay")
        x_range = DACCodeRange(start=5, count=2, step=0x2_00)
        y_range = DACCodeRange(start=9, count=1, step=0x5_00)
        test_cmd(RasterRegionCommand(x_range=x_range, y_range=y_range), "cmd_rasterregion")
        test_cmd(RasterPixelRunCommand(length=5, dwell_time= 6),"cmd_rasterpixelrun")
        test_cmd(RasterPixelFreeRunCommand(dwell_time = 10), "cmd_rasterpixelfreerun")
        test_cmd(VectorPixelCommand(x_coord=4, y_coord=5, dwell_time= 6),"cmd_vectorpixel")
        test_cmd(VectorPixelCommand(x_coord=4, y_coord=5, dwell_time= 1),"cmd_vectorpixelmin")

        def test_raster_pixels_cmd():
            command = ArrayCommand(cmdtype = CmdType.RasterPixel, array_length = 5)
            dwells = [1,2,3,4,5,6]
            async def put_testbench(ctx):
                for byte in bytes(command):
                    await put_stream(ctx, dut.usb_stream, byte)
                for dwell in dwells:
                    for byte in struct.pack(">H", dwell):
                        await put_stream(ctx, dut.usb_stream, byte)
            async def get_testbench(ctx):
                for dwell in dwells:
                    await get_stream(ctx, dut.cmd_stream, RasterPixelCommand(dwell_time=dwell).as_dict(), timeout_steps=len(command)*2 + len(dwells)*2 + 2)
                    self.assertEqual(ctx.get(dut.cmd_stream.valid),0)
                self.assertEqual(ctx.get(dut.is_started),1)
            self.simulate(dut, [get_testbench,put_testbench], name="parse_cmd_rasterpixel")  

        test_raster_pixels_cmd()

if __name__ == '__main__':
    unittest.main()