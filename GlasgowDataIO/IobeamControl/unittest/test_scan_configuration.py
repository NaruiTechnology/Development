import logging
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.utils import GetStateConfigByName
from GlasgowDataIO.IobeamControl.scanConfiguration import configure_scan_args
from GlasgowDataIO.IobeamControl.applet.DataStreamApplet import DataStreamApplet
from GlasgowDataIO.IobeamControl.applet.AdcDataStreamApplet import AdcDataStreamApplet
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer


DEVELOPMENT = Path(__file__).resolve().parents[3]


class ScanConfigurationTest(unittest.TestCase):
    def test_shipped_instrument_roles_transforms_delay_and_voltage(self):
        config = AutomationConfig(str(DEVELOPMENT / "GlasgowDataIO/Json/streamData.json"))
        args = configure_scan_args(config, GetStateConfigByName(config, "streamData")["actionData"],
                                   SimpleNamespace())
        self.assertEqual(args.port_spec, "A")
        self.assertEqual([pin.number for pin in args.ebeam_scan_enable], [0, 1])
        self.assertEqual([pin.number for pin in args.ibeam_blank_enable], [4, 5])
        self.assertEqual([(pin.number, pin.invert) for pin in args.ibeam_blank], [(2, True), (3, False)])
        self.assertEqual((args.xflip, args.yflip, args.rotate90), (False, True, True))
        self.assertEqual(args.ext_switch_delay_cycles, 960000)
        self.assertEqual(args.voltage, 3.3)

    def test_b_only_pins_use_indices_relative_to_claimed_port(self):
        with TemporaryDirectory() as folder:
            source = Path(folder) / "instrument.toml"
            source.write_text('[beam.ion.pinout]\nblank="B2#,B3"\n')
            args = configure_scan_args(None, {"microscopeConfig": str(source)}, SimpleNamespace())
        self.assertEqual(args.port_spec, "B")
        self.assertEqual([pin.number for pin in args.ibeam_blank], [2, 3])

    def test_missing_config_and_invalid_wiring_fail_before_build(self):
        with TemporaryDirectory() as folder:
            source = Path(folder) / "instrument.toml"
            with self.assertRaises(FileNotFoundError):
                configure_scan_args(None, {"microscopeConfig": str(source)}, SimpleNamespace())
            for content in ('[beam.ion.pinout]\nblank="A8"',
                            '[beam.ion.pinout]\nblank="A2,A2#"',
                            '[beam.ion.pinout]\nblank=[-2,3]',
                            '[timings]\next_switch_delay_ms=-1'):
                with self.subTest(content=content):
                    source.write_text(content)
                    with self.assertRaises(ValueError):
                        configure_scan_args(None, {"microscopeConfig": str(source)}, SimpleNamespace())

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
                        self.assertTrue(subtarget.transforms.yflip)
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
        self.assertEqual(events, [("voltage", "A", 3.3),
                                  ("pulls", "A", {2}, {0, 1, 3, 4, 5}), ("activate",)])


if __name__ == "__main__":
    unittest.main()
