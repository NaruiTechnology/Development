"""streamData.json (actionData.pins) is the single source of truth for OBI pins.

There is no separate pin-config file. This test pins that contract:
  * the active config satisfies the upstream OBI pin contract,
  * the shipped default copy cannot drift from the active one,
  * the unit-test fixture (which intentionally has empty control pins) can
    never be used for a physical build: the validator must reject it.
"""
import json
import unittest
from pathlib import Path

from GlasgowDataIO.IobeamControl.applet import validate_obi_pin_config

JSON_DIR = Path(__file__).resolve().parents[3] / "Json"


def load_pins(name):
    with open(JSON_DIR / name, encoding="utf-8") as fh:
        return json.load(fh)["Actions"][0]["streamData"]["actionData"]["pins"]


def strip_comments(node):
    if isinstance(node, dict):
        return {k: strip_comments(v) for k, v in node.items() if k != "_comment"}
    if isinstance(node, list):
        return [strip_comments(v) for v in node]
    return node


class StreamDataPinsTest(unittest.TestCase):
    def test_active_config_satisfies_upstream_pin_contract(self):
        validate_obi_pin_config(load_pins("streamData.json"))

    def test_default_copy_has_identical_pins(self):
        self.assertEqual(strip_comments(load_pins("streamData.json")),
                         strip_comments(load_pins("streamData_default.json")))

    def test_unit_test_fixture_is_rejected_for_physical_builds(self):
        with self.assertRaises(ValueError):
            validate_obi_pin_config(load_pins("streamData unit_test.json"))


if __name__ == "__main__":
    unittest.main()
