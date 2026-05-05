import unittest
from itertools import islice

import numpy as np

from GlasgowDataIO.IobeamControl.macros.scan_display import (
    _delay_iter_points,
    _roll_regular_vector_rows,
)
from GlasgowDataIO.IobeamControl.macros.vector import default_iter


class ScanDisplayTimingTest(unittest.TestCase):
    def test_delay_iter_points_uses_adc_cycles_for_unit_dwell_vector(self):
        points = [(x, 0, 1) for x in range(10)]

        delayed = _delay_iter_points(points, adc_delay_cycles=3)

        self.assertEqual(delayed[:4], [(3, 0, 1), (4, 0, 1), (5, 0, 1), (6, 0, 1)])

    def test_delay_iter_points_respects_variable_dwell(self):
        points = [
            (0, 0, 2),
            (1, 0, 2),
            (2, 0, 4),
            (3, 0, 1),
        ]

        delayed = _delay_iter_points(points, adc_delay_cycles=3)

        self.assertEqual(delayed[:2], [(2, 0, 4), (3, 0, 1)])

    def test_default_vector_iter_spans_full_dac_range(self):
        points = list(islice(default_iter(resolution=1024), 1024 * 1024 - 1, None))

        self.assertEqual(points[0], (16368, 16368, 1))

    def test_roll_regular_vector_rows_deskews_x_major_grid(self):
        arr = np.array([
            0, 1, 2, 3,
            5, 6, 7, 4,
            10, 11, 8, 9,
        ], dtype=np.uint16)
        points = [
            (0, 0, 1), (0, 1, 1), (0, 2, 1), (0, 3, 1),
            (1, 0, 1), (1, 1, 1), (1, 2, 1), (1, 3, 1),
            (2, 0, 1), (2, 1, 1), (2, 2, 1), (2, 3, 1),
        ]

        corrected = _roll_regular_vector_rows(arr, points, 1)

        self.assertEqual(
            corrected.tolist(),
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        )
