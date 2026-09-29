"""The executor drives ``output_mode`` only while imaging, exactly like upstream OBI.

In every other state (the 0xFFFF and cookie words of a sync) the signal keeps its default,
0. That is only correct because 0 is SixteenBit: the sync words are always two bytes each.
If the enum were ever reordered, sync words would silently change format, so pin it here.
"""
import unittest

from GlasgowDataIO.IobeamControl.commands.structs import OutputMode


class OutputModeDefaultTest(unittest.TestCase):
    def test_the_default_output_mode_is_sixteen_bit(self):
        self.assertEqual(int(OutputMode.SixteenBit), 0)

    def test_no_output_is_not_the_default(self):
        self.assertNotEqual(int(OutputMode.NoOutput), 0)


if __name__ == "__main__":
    unittest.main()
