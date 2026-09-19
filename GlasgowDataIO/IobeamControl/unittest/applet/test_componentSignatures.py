"""Guard against Component-declaration regressions in the scan path.

Amaranth's ``wiring.Component`` builds its signature from class annotations
that are ``In(...)``/``Out(...)`` members. Rewriting an annotation to
``name: any = In(...)`` (or any other non-Member annotation) silently removes
the member, and the class then fails at instantiation with "does not have
signature member annotations". That happened to ``BusController`` and made
every bitstream build fail, including the upstream-identical timing profile.

These tests instantiate every Component on the physical scan path, for the
upstream profile and for the diagnostic-extended profiles, and assert that the
bus/stream members the rest of the design wires against actually exist.
"""
import unittest

from amaranth.lib import wiring

from GlasgowDataIO.IobeamControl.applet.busController import BusController
from GlasgowDataIO.IobeamControl.applet.upstreamBusController import UpstreamBusController
from GlasgowDataIO.IobeamControl.applet.fastBusController import FastBusController
from GlasgowDataIO.IobeamControl.applet.commandExecutor import CommandExecutor
from GlasgowDataIO.IobeamControl.applet.commandParser import CommandParser
from GlasgowDataIO.IobeamControl.applet.imageSerializer import ImageSerializer
from GlasgowDataIO.IobeamControl.applet.rasterScanner import RasterScanner
from GlasgowDataIO.IobeamControl.applet.supersampler import Supersampler
from GlasgowDataIO.IobeamControl.applet.skidBuffer import SkidBuffer

BUS_MEMBERS = {"dac_stream", "adc_stream", "bus", "inline_blank"}


class ComponentSignatureTest(unittest.TestCase):
    def assertComponent(self, component, members):
        self.assertIsInstance(component, wiring.Component)
        self.assertTrue(members <= set(component.signature.members.keys()),
                        f"{type(component).__name__} lost members: "
                        f"{sorted(members - set(component.signature.members.keys()))}")

    def test_upstream_profile_bus_controllers_instantiate(self):
        self.assertComponent(BusController(adc_half_period=3, adc_latency=8), BUS_MEMBERS)
        self.assertComponent(UpstreamBusController(adc_half_period=3, adc_latency=8), BUS_MEMBERS)

    def test_diagnostic_profiles_instantiate(self):
        profiles = (
            dict(adc_half_period=4, adc_settle_cycles=2),
            dict(adc_half_period=5, adc_latch_cycles=2),
            dict(adc_half_period=5, bus_turnaround_cycles=2),
            dict(adc_half_period=12, adc_settle_cycles=2, adc_latch_cycles=8,
                 bus_turnaround_cycles=1),
        )
        for kwargs in profiles:
            with self.subTest(**kwargs):
                self.assertComponent(BusController(adc_latency=8, **kwargs), BUS_MEMBERS)

    def test_upstream_profile_selects_the_unmodified_upstream_fsm(self):
        from GlasgowDataIO.IobeamControl.applet.adcTiming import AdcTiming
        self.assertTrue(AdcTiming().uses_upstream_sequence)
        self.assertTrue(AdcTiming(half_period=3).uses_upstream_sequence)
        self.assertFalse(AdcTiming(half_period=3, bus_turnaround_cycles=1).uses_upstream_sequence)
        self.assertFalse(AdcTiming(half_period=4, settle_cycles=2).uses_upstream_sequence)

    def test_remaining_scan_path_components_instantiate(self):
        self.assertComponent(CommandParser(), {"usb_stream", "cmd_stream"})
        self.assertComponent(ImageSerializer(), {"img_stream", "usb_stream", "output_mode"})
        self.assertComponent(RasterScanner(), {"roi_stream", "dwell_stream", "abort", "dac_stream"})
        self.assertComponent(Supersampler(), {"dac_stream", "adc_stream",
                                              "super_dac_stream", "super_adc_stream"})
        self.assertComponent(CommandExecutor(), {"cmd_stream", "img_stream", "bus", "output_mode"})
        self.assertComponent(FastBusController(), {"dac_stream", "bus", "inline_blank"})
        self.assertComponent(SkidBuffer(unsigned_shape(16), depth=8), {"i", "o"})


def unsigned_shape(width):
    from amaranth import unsigned
    return unsigned(width)


if __name__ == "__main__":
    unittest.main()
