import logging
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from amaranth.sim import Simulator

from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.utils import GetStateConfigByName
from GlasgowDataIO.IobeamControl.scanConfiguration import configure_scan_args
from GlasgowDataIO.IobeamControl.applet.DataStreamApplet import DataStreamApplet
from GlasgowDataIO.IobeamControl.applet.busController import BusController
from GlasgowDataIO.IobeamControl.applet.AdcDataStreamApplet import AdcDataStreamApplet
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer


DEVELOPMENT = Path(__file__).resolve().parents[3]


class ScanConfigurationTest(unittest.TestCase):
    def test_configured_y_reflection_at_dac_latches(self):
        config = AutomationConfig(str(DEVELOPMENT / "GlasgowDataIO/Json/streamData.json"))
        action = GetStateConfigByName(config, "streamData")["actionData"]
        action["transforms"] = {"xflip": False, "yflip": True, "rotate90": False}
        args = configure_scan_args(config, action, SimpleNamespace())
        dut = BusController(adc_half_period=6, adc_latency=8, transforms=args.transforms)
        sim = Simulator(dut)
        sim.add_clock(1 / 48_000_000)

        async def bench(ctx):
            # Unequal coordinates expose both an axis swap and a reflection.
            ctx.set(dut.dac_stream.payload.dac_x_code, 1234)
            ctx.set(dut.dac_stream.payload.dac_y_code, 5678)
            ctx.set(dut.dac_stream.valid, 1)
            ctx.set(dut.adc_stream.ready, 1)
            accepted = False
            observed = set()
            for _ in range(48):
                if ctx.get(dut.dac_stream.ready):
                    accepted = True
                if accepted:
                    for axis, expected in (("x", 1234), ("y", 16383 - 5678)):
                        if ctx.get(getattr(dut.bus, f"dac_{axis}_le_clk")):
                            self.assertEqual(ctx.get(dut.bus.data_o), expected)
                            observed.add(axis)
                await ctx.tick()
            self.assertEqual(observed, {"x", "y"})

        sim.add_testbench(bench)
        sim.run()

    def test_shipped_instrument_roles_transforms_delay_and_voltage(self):
        config = AutomationConfig(str(DEVELOPMENT / "GlasgowDataIO/Json/streamData.json"))
        args = configure_scan_args(config, GetStateConfigByName(config, "streamData")["actionData"],
                                   SimpleNamespace())
        self.assertEqual(args.port_spec, "AB")
        # Single ion column: the scan-select relay is the ion role, so it
        # follows external control instead of the constant electron enable.
        self.assertEqual([pin.number for pin in args.ibeam_scan_enable], [0, 1])
        self.assertIsNone(args.ebeam_scan_enable)
        self.assertIsNone(args.ebeam_blank_enable)
        self.assertIsNone(args.ebeam_blank)
        self.assertEqual([pin.number for pin in args.ibeam_blank_enable], [4, 5])
        self.assertEqual([(pin.number, pin.invert) for pin in args.ibeam_blank], [(2, True), (3, False)])
        self.assertEqual((args.xflip, args.yflip, args.rotate90), (False, False, False))
        self.assertEqual(args.ext_switch_delay_cycles, 960000)
        self.assertEqual(args.voltage, 3.3)

    def test_factory_default_matches_single_ion_harness_and_voltage(self):
        # streamData_default.json is the restore target for Settings; it must
        # carry the same beam roles and the 3.3 V differential blanker level.
        config = AutomationConfig(str(DEVELOPMENT / "GlasgowDataIO/Json/streamData_default.json"))
        action = GetStateConfigByName(config, "streamData")["actionData"]
        args = configure_scan_args(config, action, SimpleNamespace())
        self.assertEqual(set(action["beam"]), {"ion"})
        self.assertEqual([pin.number for pin in args.ibeam_scan_enable], [0, 1])
        self.assertEqual([(pin.number, pin.invert) for pin in args.ibeam_blank], [(2, True), (3, False)])
        self.assertEqual(action["voltage"], 3.3)

    def test_b_only_pins_use_indices_relative_to_claimed_port(self):
        args = configure_scan_args(None, {"beam": {"ion": {"pinout": {"blank": "B2#,B3"}}}},
                                   SimpleNamespace())
        self.assertEqual(args.port_spec, "B")
        self.assertEqual([pin.number for pin in args.ibeam_blank], [2, 3])

    def test_legacy_toml_reference_is_not_opened(self):
        with patch("builtins.open", side_effect=AssertionError("must use JSON only")):
            args = configure_scan_args(None, {"microscopeConfig": "/missing/microscope.toml"},
                                       SimpleNamespace())
        self.assertEqual((args.xflip, args.yflip, args.rotate90), (False, False, False))
        self.assertEqual(args.port_spec, "")

    def test_json_transforms_and_timing_are_applied(self):
        args = configure_scan_args(None, {
            "transforms": {"xflip": True, "yflip": False, "rotate90": True},
            "timings": {"ext_switch_delay_ms": 5},
        }, SimpleNamespace())
        self.assertEqual((args.xflip, args.yflip, args.rotate90), (True, False, True))
        self.assertEqual(args.ext_switch_delay_cycles, 240000)

    def test_invalid_json_wiring_and_timing_fail_before_build(self):
        actions = [{"beam": {"ion": {"pinout": {"blank": spec}}}}
                   for spec in ("A8", "A2,A2#", [-2, 3])]
        actions += [{"timings": {"ext_switch_delay_ms": -1}},
                    {"transforms": {"rotate90": "false"}}]
        for action in actions:
            with self.subTest(action=action):
                with self.assertRaises(ValueError):
                    configure_scan_args(None, action, SimpleNamespace())

    def test_build_files_identical_without_voltage_map_and_named_pins_present(self):
        config = AutomationConfig(str(DEVELOPMENT / "GlasgowDataIO/Json/streamData.json"))
        config.LogName = "PinBuildTest"
        for adc in (False, True):
            plans = []
            for has_map in (True, False):
                with self.subTest(adc=adc, voltage_map=has_map):
                    args = SimpleNamespace()
                    if has_map:
                        args.voltage_map = {"A": 3.3, "B": 3.3}
                    applet = AdcDataStreamApplet(config) if adc else DataStreamApplet(config)
                    target = GlasgowHardwareTarget("C3", multiplexer_cls=DirectMultiplexer)
                    subtarget = applet.build(target, args)
                    if not adc:
                        self.assertEqual(subtarget.ext_switch_delay, 960000)
                        self.assertEqual((subtarget.transforms.xflip, subtarget.transforms.yflip,
                                          subtarget.transforms.rotate90), (False, False, False))
                        self.assertEqual(len(subtarget.ports.ibeam_blank), 2)
                    plan = target.platform.prepare(target, emit_src=False)
                    plans.append(plan.files)
                    pcf = plan.files["top.pcf"]
                    self.assertIn("K1", pcf)
                    if adc:
                        self.assertNotIn("dac_clk", pcf)
                        self.assertNotIn("dac_x_le_clk", pcf)
                    else:
                        for ball in ("A1", "A2", "B3", "A3", "B6", "A4"):
                            self.assertIn(" " + ball + "\n", pcf)
            self.assertEqual(plans[0], plans[1])


class RuntimePowerTest(unittest.IsolatedAsyncioTestCase):
    async def test_voltage_and_inverted_pulls_are_applied_before_activation(self):
        config = AutomationConfig(str(DEVELOPMENT / "GlasgowDataIO/Json/streamData.json"))
        args = configure_scan_args(config, GetStateConfigByName(config, "streamData")["actionData"],
                                   SimpleNamespace())
        events = []
        async def voltage(spec, volts):
            events.append(("voltage", spec, volts))
        async def pulls(spec, low, high):
            events.append(("pulls", spec, low, high))
        async def activate():
            events.append(("activate",))
        device = SimpleNamespace(has_pulls=True, revision="C3", set_voltage=voltage, set_pulls=pulls)
        demux = object.__new__(DirectDemultiplexer)
        demux.device, demux._claimed, demux._interfaces = device, set(), []
        iface = SimpleNamespace(_activate=activate)
        applet = SimpleNamespace(logger=logging.getLogger("RuntimePowerTest"))
        with patch("GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.demultiplexer.DirectDemultiplexerInterface",
                   return_value=iface):
            await demux.claim_interface(applet, SimpleNamespace(_pipe_num=0), args,
                                        pull_high=args.beam_pull_high)
        self.assertEqual(events, [("voltage", "AB", 3.3),
                                  ("pulls", "AB", {2}, {0, 1, 3, 4, 5}), ("activate",)])


if __name__ == "__main__":
    unittest.main()


class BlankFailsafeConfigurationTest(unittest.TestCase):
    """safety.blank_when_released / safety.stall_blank_ms (glasgow_service/docs/blank-failsafe.md)."""

    def args(self, safety=None):
        action = {"beam": {"ion": {"pinout": {"blank": "A2#,A3"}}}}
        if safety is not None:
            action["safety"] = safety
        return configure_scan_args(None, action, SimpleNamespace())

    def test_safe_by_default(self):
        args = self.args()
        self.assertIs(args.blank_when_released, True)
        self.assertEqual(args.stall_blank_cycles, 100 * 48_000)

    def test_settings(self):
        args = self.args({"blank_when_released": False, "stall_blank_ms": 0})
        self.assertIs(args.blank_when_released, False)
        self.assertEqual(args.stall_blank_cycles, 0)
        self.assertEqual(self.args({"stall_blank_ms": 2.5}).stall_blank_cycles, 120_000)

    def test_bad_values_are_refused(self):
        for safety in ({"blank_when_released": "yes"}, {"stall_blank_ms": -1},
                       {"stall_blank_ms": 20_000}, {"stall_blank_ms": True}, "on"):
            with self.subTest(safety=safety), self.assertRaises(ValueError):
                self.args(safety)

    def test_applet_passes_the_settings_to_the_gateware(self):
        source = (DEVELOPMENT / "GlasgowDataIO/IobeamControl/applet/DataStreamApplet.py").read_text()
        self.assertIn('blank_when_released  = getattr(args, "blank_when_released", True)', source)
        self.assertIn('stall_blank_cycles   = getattr(args, "stall_blank_cycles", 0)', source)
