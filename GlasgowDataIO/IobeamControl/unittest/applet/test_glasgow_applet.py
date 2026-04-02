import unittest, argparse, os, types, functools, threading, asyncio

from amaranth import *
from amaranth.build import *
from amaranth.sim.core import Simulator

from dataclasses import dataclass
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.applet import GlasgowAppletArguments
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.applet import GlasgowHardwareTarget, GlasgowSimulationTarget
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import GlasgowDevice
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.platform.rev_ab import GlasgowRevABPlatform
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.toolchain  import find_toolchain
from GlasgowDataIO.IobeamControl.applet.rasterScanner import RasterScanner

from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.simulation.device import GlasgowSimulationDevice
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.simulation.multiplexer import SimulationMultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.simulation.demultiplexer import SimulationDemultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.simulation.device import GlasgowSimulationDevice
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.support.mock import MockRecorder, MockReplayer




class GlasgowAppletTestCase(unittest.TestCase):
    """ def __init_subclass__(cls, applet, **kwargs):
        super().__init_subclass__(**kwargs)

        cls.applet_cls  = applet """

    def setUp(self):
        self.applet = RasterScanner() #self.applet_cls()

    def assertBuilds(self, access="direct", args=[]):
        if access == "direct":
            target = GlasgowHardwareTarget(revision=self.applet_cls.required_revision,
                                           multiplexer_cls=DirectMultiplexer)
            access_args = GlasgowAppletArguments("applet", "AB", 16)
        else:
            raise NotImplementedError

        parser = argparse.ArgumentParser()
        self.applet.add_build_arguments(parser, access_args)

        try:
            parsed_args = parser.parse_args(args)
        except SystemExit:
            raise AssertionError("argument parsing failed") from None
        self.applet.build(target, parsed_args)

        target.build_plan().get_bitstream()

    def _prepare_applet_args(self, args, access_args, interact=False):
        parser = argparse.ArgumentParser()
        self.applet.add_build_arguments(parser, access_args)
        self.applet.add_run_arguments(parser, access_args)
        if interact:
            self.applet.add_interact_arguments(parser)
        self._parsed_args = parser.parse_args(args)

    def _prepare_simulation_target(self):
        self.target = GlasgowSimulationTarget(multiplexer_cls=SimulationMultiplexer)

        self.device = GlasgowSimulationDevice(self.target)
        self.device.demultiplexer = SimulationDemultiplexer(self.device)

    def build_simulated_applet(self):
        self.applet.build(self.target, self._parsed_args)

    async def run_simulated_applet(self):
        return await self.applet.run(self.device, self._parsed_args)

    def _prepare_hardware_target(self, case, fixture, mode):
        assert mode in ("record", "replay")

        if mode == "record":
            self.device = None # in case the next line raises
            self.device = GlasgowDevice()
            self.device.demultiplexer = DirectDemultiplexer(self.device, pipe_count=1)
            revision = self.device.revision
        else:
            self.device = None
            revision = "A0"

        self.target = GlasgowHardwareTarget(revision=revision,
                                            multiplexer_cls=DirectMultiplexer)
        self.applet.build(self.target, self._parsed_args)

        self._recording = False
        self._recorders = []

        old_run_lower = self.applet.run_lower

        async def run_lower(cls, device, args):
            if mode == "record":
                lower_iface = await old_run_lower(cls, device, args)
                recorder = MockRecorder(case, lower_iface, fixture)
                self._recorders.append(recorder)
                return recorder

            if mode == "replay":
                return MockReplayer(case, fixture)

        self.applet.run_lower = run_lower

    async def run_hardware_applet(self, mode):
        if mode == "record":
            await self.device.download_target(self.target.build_plan())
        else:
            # avoid UnusedElaboratable warning
            Fragment.get(self.target, GlasgowRevABPlatform())

        return await self.applet.run(self.device, self._parsed_args)


    def test_synthesis_test(case):
        synthesis_available = find_toolchain(quiet=True) is not None
        return unittest.skipUnless(synthesis_available, "synthesis not available")(case)


    def test_applet_simulation_test(setup, args=[]):
        def decorator(case):
            def wrapper(self):
                access_args = GlasgowAppletArguments("applet", "AB", 16)
                self._prepare_applet_args(args, access_args)
                self._prepare_simulation_target()

                getattr(self, setup)()
                @types.coroutine
                def run():
                    yield from case(self)

                sim = Simulator(self.target)
                sim.add_clock(1e-9)
                sim.add_sync_process(run)
                vcd_name = f"{case.__name__}.vcd"
                with sim.write_vcd(vcd_name):
                    sim.run()
                os.remove(vcd_name)

            return wrapper

        return decorator


    def test_applet_hardware_test(setup="run_hardware_applet", args=[]):
        def decorator(case):
            @functools.wraps(case)
            def wrapper(self):
                fixture_path = os.path.join(os.path.dirname(case.__code__.co_filename), "fixtures",
                                            case.__name__ + ".json")
                os.makedirs(os.path.dirname(fixture_path), exist_ok=True)
                if os.path.exists(fixture_path):
                    fixture = open(fixture_path)
                    mode = "replay"
                else:
                    fixture = open(fixture_path, "w")
                    mode = "record"

                try:
                    access_args = GlasgowAppletArguments(self.applet, default_port="AB", pin_count=16)
                    self._prepare_applet_args(args, access_args)
                    self._prepare_hardware_target(self, fixture, mode)

                    exception = None
                    def run_test():
                        try:
                            loop = asyncio.new_event_loop()
                            iface = loop.run_until_complete(getattr(self, setup)(mode))

                            self._recording = True
                            loop.run_until_complete(case(self, iface))

                        except Exception as e:
                            nonlocal exception
                            exception = e

                        finally:
                            if self.device is not None:
                                loop.run_until_complete(self.device.demultiplexer.cancel())
                            loop.close()

                    thread = threading.Thread(target=run_test)
                    thread.start()
                    thread.join()
                    if exception is not None:
                        raise exception

                except:
                    if mode == "record":
                        os.remove(fixture_path)
                    raise

                finally:
                    if mode == "record":
                        if self.device is not None:
                            self.device.close()
                    fixture.close()

            return wrapper

        return decorator

#=============================================================
