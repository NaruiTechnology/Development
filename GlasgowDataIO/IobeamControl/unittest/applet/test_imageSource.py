import unittest

from GlasgowDataIO.IobeamControl.applet.imageSource import (
    pattern_image,
    random_image,
)


class ImageSourceTest(unittest.TestCase):
    def test_pattern_image_uses_full_16bit_range(self):
        pixels = pattern_image(resolution=16, kind="ramp")

        self.assertEqual(pixels[:4], [0, 4369, 8738, 13107])
        self.assertEqual(pixels[-1], 65535)

    def test_random_image_uses_full_16bit_range(self):
        pixels = random_image(resolution=16, seed=123)

        self.assertEqual(len(pixels), 16 * 16)
        self.assertTrue(all(0 <= value <= 65535 for value in pixels))
        self.assertTrue(any(value > 255 for value in pixels))
