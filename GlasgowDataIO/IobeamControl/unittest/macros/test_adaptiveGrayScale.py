"""Adaptive-gray decisions must compare like with like.

The gateware sends SixteenBit samples OBI-aligned (code << 2). The thresholds stay in raw
14-bit units, built from the UI's 8-bit gray window as ``gray * 64``. Comparing the two
directly is off by a factor of four: with a 100..200 window, pixels of gray 100, 150 and
200 (all inside) were decided as outside.
"""
from types import SimpleNamespace
import unittest

from GlasgowDataIO.IobeamControl.macros.vector import AdaptiveGrayFeedbackConfig, VectorScanCommand

LO, HI = 100 * 64, 200 * 64            # the service's thresholds for a UI window of 100..200


def decide(gray, *, blank_when_inside=True):
    cfg = AdaptiveGrayFeedbackConfig(gray_min=LO, gray_max=HI, blank_when_inside=blank_when_inside)
    hardware_sample = (gray * 64) << 2                    # what the gateware sends for that pixel
    command = SimpleNamespace(_adaptive_gray_feedback=cfg,
                              _feedback_sample_value=VectorScanCommand._feedback_sample_value)
    return VectorScanCommand._feedback_blank_decision(command, [hardware_sample])


class AdaptiveGrayScaleTest(unittest.TestCase):
    def test_sample_value_is_converted_back_to_14_bit(self):
        self.assertEqual(VectorScanCommand._feedback_sample_value([0xFFFC]), 0x3FFF)
        self.assertEqual(VectorScanCommand._feedback_sample_value([(9600 << 2), (9600 << 2)]), 9600)

    def test_pixels_inside_the_gray_window_are_inside(self):
        for gray in (100, 150, 200):
            self.assertTrue(decide(gray), f"gray {gray} is inside 100..200")

    def test_pixels_outside_the_gray_window_are_outside(self):
        for gray in (0, 20, 60, 230, 255):
            self.assertFalse(decide(gray), f"gray {gray} is outside 100..200")

    def test_blank_when_outside_inverts_the_decision(self):
        self.assertFalse(decide(150, blank_when_inside=False))
        self.assertTrue(decide(20, blank_when_inside=False))


if __name__ == "__main__":
    unittest.main()
