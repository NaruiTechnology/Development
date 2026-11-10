"""pattern=lattice: the service streams a physically spaced exposure without a client point list."""
import itertools
import time
import unittest
from pathlib import Path

from pydantic import ValidationError

from glasgow_service.models import VectorPattern, VectorRequest
from glasgow_service.service import DeviceService, _simulated_pass_samples
from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand

CONFIG_PATH = Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"


def _lattice_req(**kw):
    lattice = dict(shape={"kind": "rect", "x0": 100, "x1": 200, "y0": 100, "y1": 150}, pitch_x=5.0, dwell=7, passes=1)
    lattice.update(kw)
    return VectorRequest(pattern=VectorPattern.lattice, lattice=lattice, vector_resolution=64, latency_bytes=8196)


class LatticeVectorTest(unittest.TestCase):
    def setUp(self):
        self.svc = DeviceService(str(CONFIG_PATH))

    def test_builds_a_streaming_vector_command(self):
        cmd = self.svc._build_vector_cmd(_lattice_req(passes=2))
        self.assertIsInstance(cmd, VectorScanCommand)
        self.assertEqual(cmd.pass_pixels, 20 * 10 * 2)
        self.assertEqual(cmd.link_dwell, 7)

    def test_pass_samples_match_the_lattice_for_simulation(self):
        self.assertEqual(_simulated_pass_samples("vector", _lattice_req(passes=3)), 20 * 10 * 3)

    def test_a_multi_million_spot_pattern_is_never_materialised(self):
        # ~6.7M spots x 3 passes (the reviewed Free hand ROI at 35 nm / 50% overlap) in DAC codes.
        req = _lattice_req(shape={"kind": "rect", "x0": 0, "x1": 16000, "y0": 0, "y1": 16000}, pitch_x=6.2, dwell=7, passes=3)
        t0 = time.perf_counter()
        cmd = self.svc._build_vector_cmd(req)
        self.assertLess(time.perf_counter() - t0, 1.0)
        self.assertGreater(cmd.pass_pixels, 6_000_000)

    def test_first_points_are_serpentine_dac_codes_with_the_requested_dwell(self):
        req = _lattice_req(shape={"kind": "rect", "x0": 0, "x1": 8, "y0": 0, "y1": 4}, pitch_x=1.0, dwell=5)
        cmd = self.svc._build_vector_cmd(req)
        points = list(itertools.islice(cmd._iter_points, 10))
        self.assertEqual([p[:2] for p in points[:10]],
                         [(1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 1), (8, 1), (8, 2), (7, 2)])
        self.assertTrue(all(p[2] == 5 and p[3] is False for p in points))

    def test_live_zoom_and_other_geometry_updates_are_refused_during_a_lattice_exposure(self):
        req = _lattice_req()
        cmd = self.svc._build_vector_cmd(req, continuous=True)
        self.svc._active_scan = {"kind": "vector", "owner": None}
        self.svc._active_live_request = req
        self.svc._active_command = cmd
        roi = {"x_start": 0, "x_end": 4000, "y_start": 0, "y_end": 4000}
        for geometry in ({"roi": roi, "parallel_rois": None},
                         {"roi": roi, "parallel_rois": None, "points": []},
                         {"gray_rule": {}}):
            with self.assertRaisesRegex(ValueError, "lattice exposure"):
                self.svc.update_live_scan_geometry("vector", geometry)
        self.assertIs(self.svc._active_live_request, req)   # nothing was swapped in
        self.assertIs(self.svc._active_command, cmd)

    def test_the_guard_does_not_touch_raster_live_updates(self):
        from glasgow_service.models import RasterRequest
        self.svc._active_live_request = RasterRequest()
        self.svc._active_scan = None   # reaches the normal "no active scan" check, not an AttributeError
        with self.assertRaisesRegex(ValueError, "no matching continuous scan"):
            self.svc.update_live_scan_geometry("raster", {"roi": None, "parallel_rois": None})

    def test_pre_process_would_materialise_the_stream_and_is_rejected(self):
        with self.assertRaises(ValidationError):
            VectorRequest(pattern=VectorPattern.lattice, pre_process=True,
                          lattice={"shape": {"kind": "rect", "x0": 0, "x1": 8, "y0": 0, "y1": 4}, "pitch_x": 1, "dwell": 1})

    def test_lattice_field_and_pattern_must_agree(self):
        with self.assertRaises(ValidationError):
            VectorRequest(pattern=VectorPattern.lattice)
        with self.assertRaises(ValidationError):
            VectorRequest(pattern=VectorPattern.default,
                          lattice={"shape": {"kind": "rect", "x0": 0, "x1": 1, "y0": 0, "y1": 1}, "pitch_x": 1, "dwell": 1})

    def test_absurd_pitch_is_rejected_before_any_hardware_work(self):
        with self.assertRaises(ValidationError):
            _lattice_req(shape={"kind": "rect", "x0": 0, "x1": 16000, "y0": 0, "y1": 16000}, pitch_x=0.01)

    def test_ring_needs_ordered_radii(self):
        with self.assertRaises(ValidationError):
            _lattice_req(shape={"kind": "ellipse", "cx": 500, "cy": 500, "rx": 50, "ry": 50, "inner_rx": 60, "inner_ry": 60})


if __name__ == "__main__":
    unittest.main()
