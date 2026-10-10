"""Pin contract from OBI 0f6e62c829dadbde17a8f9b8d27e1ab839c5ba2f.

Checks the shipped scan configs and actual resource builders against that
external reference. This does not certify beam wiring or analog timing.
"""
import json
from pathlib import Path
import unittest

from GlasgowDataIO.IobeamControl.applet import build_iobeam_resources, validate_obi_pin_config
from GlasgowDataIO.IobeamControl.applet.AdcDataStreamApplet import build_adc_resources
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.platform.rev_c import (
    GlasgowRevC123Platform,
)


# OBI names: a_clock, a_latch, a_enable, d_clock, x_latch, y_latch.
CONTROL = {
    "power_good": ("K1", "i", False),
    "adc_clk": ("G1", "o", True),
    "adc_le_clk": ("H2", "o", False),
    "adc_oe": ("G3", "o", True),
    "dac_clk": ("F3", "o", True),
    "dac_x_le_clk": ("H3", "o", False),
    "dac_y_le_clk": ("H1", "o", False),
}
DATA = "B2 C4 B1 C3 C2 C1 D3 D1 F4 G2 E3 F1 E2 F2".split()
CONFIG_DIR = Path(__file__).resolve().parents[3] / "Json"


def pin_config(filename):
    document = json.loads((CONFIG_DIR / filename).read_text())
    return next(action["streamData"]["actionData"]["pins"]
                for action in document["Actions"] if "streamData" in action)


def controls(resource):
    return {sub.name: (" ".join(sub.ios[0].names), sub.ios[0].dir,
                       sub.ios[0].invert) for sub in resource.ios}


class ObiPinMappingTest(unittest.TestCase):
    def test_physical_build_rejects_missing_empty_swapped_or_inverted_pins(self):
        from copy import deepcopy
        pins = pin_config("streamData.json")
        validate_obi_pin_config(pins)
        bad = []
        for field, value in (("pin", ""), ("pin", "G2"), ("invert", False), ("direction", "i")):
            cfg = deepcopy(pins)
            next(s for s in cfg["control"]["subsignals"] if s["name"] == "adc_oe")[field] = value
            bad.append(cfg)
        cfg = deepcopy(pins)
        cfg["data"]["pins"] = " ".join(reversed(DATA))
        bad.append(cfg)
        for cfg in bad + [{}]:
            with self.subTest(config=cfg), self.assertRaises(ValueError):
                validate_obi_pin_config(cfg)

    def test_scan_bus_matches_reference_in_both_shipped_configs(self):
        for filename in ("streamData.json", "streamData_default.json"):
            with self.subTest(config=filename):
                resources = {r.name: r for r in build_iobeam_resources(pin_config(filename))}
                self.assertEqual(controls(resources["control"]), CONTROL)
                bus = resources["data"].ios[0]
                self.assertEqual(bus.names, DATA)
                self.assertEqual(bus.dir, "io")
                self.assertFalse(bus.invert)
                for resource in resources.values():
                    self.assertEqual(dict(resource.attrs), {"IO_STANDARD": "SB_LVCMOS33"})

    def test_adc_only_keeps_adc_mapping_without_dac_outputs(self):
        resources = {r.name: r for r in build_adc_resources(pin_config("streamData.json"))}
        self.assertEqual(set(resources), {"adc_control", "adc_data"})
        self.assertEqual(controls(resources["adc_control"]),
                         {name: value for name, value in CONTROL.items()
                          if name.startswith("adc_") or name == "power_good"})
        bus = resources["adc_data"].ios[0]
        self.assertEqual(bus.names, DATA)
        self.assertEqual(bus.dir, "i")
        self.assertFalse(bus.invert)
        for resource in resources.values():
            self.assertEqual(dict(resource.attrs), {"IO_STANDARD": "SB_LVCMOS33"})

    def test_bus_pins_are_unique_and_do_not_overlap_platform_resources(self):
        bus_pins = DATA + [value[0] for value in CONTROL.values()]
        self.assertEqual(len(set(bus_pins)), 21)

        def collect_pins(resource):
            for item in resource.ios:
                if hasattr(item, "ios"):
                    yield from collect_pins(item)
                elif hasattr(item, "names"):
                    yield from item.names

        platform_pins = {pin for resource in GlasgowRevC123Platform.resources
                         for pin in collect_pins(resource)}
        self.assertFalse(set(bus_pins) & platform_pins)


if __name__ == "__main__":
    unittest.main()
