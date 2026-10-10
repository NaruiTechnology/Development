import unittest

from GlasgowDataIO.IobeamControl.applet.imageSource import (
    pattern_image,
    random_image,
)


class ImageSourceTest(unittest.TestCase):
    def test_pattern_image_uses_full_14bit_adc_range(self):
        pixels = pattern_image(resolution=16, kind="ramp")

        self.assertEqual(pixels[:4], [0, 1092, 2184, 3276])
        self.assertEqual(pixels[-1], 16383)

    def test_random_image_uses_native_adc_range(self):
        pixels = random_image(resolution=16, seed=123)

        self.assertEqual(len(pixels), 16 * 16)
        self.assertTrue(all(0 <= value <= 16383 for value in pixels))
        self.assertTrue(any(value > 255 for value in pixels))

    def test_stepped_bars_keep_all_eight_display_levels(self):
        pixels = pattern_image(resolution=16, kind="bars")

        self.assertEqual(sorted(set(pixels)), [
            0, 2048, 4096, 6144, 8192, 10240, 12288, 14336,
        ])
