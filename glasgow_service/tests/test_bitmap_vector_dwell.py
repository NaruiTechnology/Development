import unittest

from glasgow_service.models import SimulationBitmap, VectorPattern, VectorRequest
from glasgow_service.service import _bitmap_vector_chunks


class BitmapVectorDwellTest(unittest.TestCase):
    def test_custom_bitmap_chunks_respect_per_point_dwell(self):
        bitmap = SimulationBitmap(
            width=4,
            height=4,
            pixels=[128] * 16,
        )
        low_dwell = VectorRequest(
            pattern=VectorPattern.custom,
            points=[
                [0, 0, 1],
                [1000, 1000, 1],
                [2000, 2000, 1],
                [3000, 3000, 1],
            ],
            vector_resolution=2048,
            dwell=1,
            latency_bytes=8,
            output_mode="SixteenBit",
            cookie=123,
            pre_process=True,
            do_validate=True,
            roi=None,
            simulation_bitmap=bitmap,
        )
        high_dwell = low_dwell.model_copy(update={
            "points": [
                [0, 0, 4],
                [1000, 1000, 4],
                [2000, 2000, 4],
                [3000, 3000, 4],
            ]
        })

        low_chunks = _bitmap_vector_chunks(low_dwell)
        high_chunks = _bitmap_vector_chunks(high_dwell)

        self.assertIsNotNone(low_chunks)
        self.assertIsNotNone(high_chunks)
        self.assertLess(len(low_chunks), len(high_chunks))
        self.assertEqual(sum(len(chunk) for chunk in low_chunks), 4)
        self.assertEqual(sum(len(chunk) for chunk in high_chunks), 4)

    def test_custom_bitmap_blank_flag_zeroes_output(self):
        bitmap = SimulationBitmap(
            width=1,
            height=1,
            pixels=[255],
        )
        req = VectorRequest(
            pattern=VectorPattern.custom,
            points=[{"x": 0, "y": 0, "dwell": 1, "blank": True}],
            vector_resolution=2048,
            dwell=1,
            latency_bytes=8,
            output_mode="SixteenBit",
            cookie=123,
            pre_process=True,
            do_validate=True,
            roi=None,
            simulation_bitmap=bitmap,
        )

        chunks = _bitmap_vector_chunks(req)
        self.assertIsNotNone(chunks)
        self.assertEqual(sum(len(chunk) for chunk in chunks), 1)
        self.assertEqual(chunks[0][0], 0)


if __name__ == "__main__":
    unittest.main()
