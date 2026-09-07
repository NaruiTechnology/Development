import unittest

from GlasgowDataIO.IobeamControl.transfer.adcStream import _aligned_sentinel


class AdcConnectionTest(unittest.TestCase):
    def test_finds_only_uint16_aligned_sentinel(self):
        self.assertEqual(_aligned_sentinel(b"\x00\x01\xff\xff\x00\x02"), 2)
        self.assertIsNone(_aligned_sentinel(b"\x00\xff\xff\x02"))
        self.assertEqual(_aligned_sentinel(b"\xff\xff"), 0)


if __name__ == "__main__":
    unittest.main()

