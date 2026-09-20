import unittest
from pathlib import Path

from GlasgowDataIO.IobeamControl.commands.structs import OutputMode
from glasgow_service.models import SimulationBitmap, VectorPattern, VectorRequest
from glasgow_service.service import DeviceService, _bitmap_vector_chunks


CONFIG_PATH = Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json" / "streamData unit_test.json"


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

    def test_custom_bitmap_pass_index_is_accepted(self):
        bitmap = SimulationBitmap(
            width=1,
            height=1,
            pixels=[255],
        )
        req = VectorRequest(
            pattern=VectorPattern.custom,
            points=[{"x": 0, "y": 0, "dwell": 1, "blank": False, "passIndex": 2}],
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
        self.assertEqual(chunks[0][0], 255 * 256)   # OBI-aligned: (255 * 64) << 2

    def test_adaptive_feedback_forces_sixteen_bit_when_enabled(self):
        svc = DeviceService(str(CONFIG_PATH))
        svc._vector_defaults["PixelFallbackBlank"] = True
        svc._vector_defaults["adaptiveFeedbackWindowPoints"] = 1
        svc._vector_defaults["adaptiveFeedbackPipelineDelayPoints"] = 2

        req = VectorRequest(
            pattern=VectorPattern.default,
            points=None,
            vector_resolution=2048,
            dwell=1,
            latency_bytes=8,
            output_mode="EightBit",
            feedback_mode="adaptive_gray_feedback",
            gray_level_range=(10, 20),
            gray_level_skipped=True,
            cookie=123,
            pre_process=False,
            do_validate=True,
            roi=None,
            simulation_bitmap=None,
        )

        cmd = svc._build_vector_cmd(req)

        self.assertEqual(cmd._output_mode, OutputMode.SixteenBit)
        self.assertIsNotNone(cmd._adaptive_gray_feedback)
        self.assertEqual(cmd._adaptive_gray_feedback.gray_min, 640)
        self.assertEqual(cmd._adaptive_gray_feedback.gray_max, 1280)
        self.assertEqual(cmd._adaptive_gray_feedback.pipeline_delay_points, 2)

    def test_adaptive_feedback_forces_dwell_above_probe_floor(self):
        svc = DeviceService(str(CONFIG_PATH))
        svc._vector_defaults["PixelFallbackBlank"] = True

        req = VectorRequest(
            pattern=VectorPattern.default,
            points=None,
            vector_resolution=2048,
            dwell=1,
            latency_bytes=8,
            output_mode="EightBit",
            feedback_mode="adaptive_gray_feedback",
            gray_level_range=(10, 20),
            gray_level_skipped=True,
            cookie=123,
            pre_process=False,
            do_validate=True,
            roi=None,
            simulation_bitmap=None,
        )

        cmd = svc._build_vector_cmd(req)
        first_point = next(cmd._iter_adaptive_points())

        self.assertEqual(first_point[2], 16)

    def test_adaptive_feedback_is_gated_by_pixel_fallback_blank(self):
        svc = DeviceService(str(CONFIG_PATH))
        svc._vector_defaults["PixelFallbackBlank"] = False

        req = VectorRequest(
            pattern=VectorPattern.default,
            points=None,
            vector_resolution=32,
            dwell=1,
            latency_bytes=8,
            output_mode="EightBit",
            feedback_mode="adaptive_gray_feedback",
            gray_level_range=(10, 20),
            gray_level_skipped=True,
            cookie=123,
            pre_process=False,
            do_validate=True,
            roi=None,
            simulation_bitmap=None,
        )

        cmd = svc._build_vector_cmd(req)

        self.assertEqual(cmd._output_mode, OutputMode.EightBit)
        self.assertIsNone(cmd._adaptive_gray_feedback)


if __name__ == "__main__":
    unittest.main()
