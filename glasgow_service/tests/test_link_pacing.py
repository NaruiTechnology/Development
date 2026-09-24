"""Chunk sizing for slow host links and the raster-generator route for sawtooth vectors."""
import unittest
from pathlib import Path

from glasgow_service.models import DacRampRequest, VectorPattern, VectorRequest, VectorScanPath
from glasgow_service.service import DeviceService, _link_chunk_latency
from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from GlasgowDataIO.IobeamControl.transfer.linkStats import LinkStats

CONFIG_PATH = Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"


class LinkChunkLatencyTest(unittest.TestCase):
    def test_chunk_covers_min_beam_time(self):
        # 8 MHz conversions, dwell 16 -> 17 conversions per pixel; 100 ms -> 47059 pixels
        self.assertEqual(_link_chunk_latency(8196, 16, 8e6, 100.0), 47059 * 16)

    def test_requested_is_lower_bound(self):
        self.assertEqual(_link_chunk_latency(10**9, 16, 8e6, 100.0), 10**9)

    def test_vector_cap(self):
        self.assertEqual(_link_chunk_latency(8196, 16, 8e6, 100.0, max_points=32768), 32768 * 16)

    def test_disabled(self):
        self.assertEqual(_link_chunk_latency(8196, 16, 8e6, 0), 8196)

    def test_dac_ramp_defaults_no_longer_33_pixel_chunks(self):
        latency = _link_chunk_latency(16384, 500, 8e6, 100.0)
        self.assertGreaterEqual(latency // 500, 1500)

    def test_dac_ramp_uses_one_complete_sweep(self):
        svc = DeviceService(str(CONFIG_PATH))
        # DacRampRequest's upstream-compatible default is dwell=500.
        ramp = DacRampRequest()
        cmd = svc._build_dac_ramp_cmd(ramp)
        latency = svc._chunk_latency("dac_ramp", ramp.latency_bytes, cmd)
        self.assertGreaterEqual(latency, 16384 * ramp.dwell)
        self.assertEqual(len(list(cmd._iter_chunks(latency))), 1)


def _req(**kw):
    base = dict(pattern=VectorPattern.default, scan_path=VectorScanPath.horizontal_sawtooth,
                points=None, vector_resolution=2048, dwell=16, latency_bytes=8196,
                output_mode="SixteenBit", cookie=123, pre_process=False, do_validate=True,
                roi=None, simulation_bitmap=None)
    base.update(kw)
    return VectorRequest(**base)


class SawtoothRoutingTest(unittest.TestCase):
    def setUp(self):
        self.svc = DeviceService(str(CONFIG_PATH))

    def test_default_sawtooth_uses_raster_generator(self):
        cmd = self.svc._build_vector_cmd(_req())
        self.assertIsInstance(cmd, RasterScanCommand)
        self.assertEqual((cmd._x_range.count, cmd._y_range.count), (2048, 2048))
        self.assertEqual(cmd._dwell, 16)

    def test_other_paths_stream_points(self):
        for path in (VectorScanPath.horizontal_triangle, VectorScanPath.vertical_raster,
                     VectorScanPath.vertical_serpentine):
            self.assertIsInstance(self.svc._build_vector_cmd(_req(scan_path=path)), VectorScanCommand)

    def test_custom_points_stream(self):
        cmd = self.svc._build_vector_cmd(_req(pattern=VectorPattern.custom, points=[(0, 0, 1), (5, 5, 1)]))
        self.assertIsInstance(cmd, VectorScanCommand)

    def test_coarse_grid_falls_back(self):
        self.assertIsInstance(self.svc._build_vector_cmd(_req(vector_resolution=32)), VectorScanCommand)

    def test_can_be_disabled(self):
        self.svc._vector_defaults["sawtoothOnRasterGenerator"] = False
        self.assertIsInstance(self.svc._build_vector_cmd(_req()), VectorScanCommand)

    def test_service_latency_for_vector_default(self):
        cmd = self.svc._build_vector_cmd(_req())
        self.assertGreater(self.svc._chunk_latency("vector", 8196, cmd), 8196)
        self.assertEqual(cmd._dwell, 16)

    def test_raster_routed_vector_is_not_point_capped(self):
        # Routed to the raster generator: sized like a raster (100 ms at
        # 8 MHz / 17 conversions = 47059 pixels), not the 32768-point cap
        # meant for streamed 6-byte vector points.
        cmd = self.svc._build_vector_cmd(_req())
        self.assertIsInstance(cmd, RasterScanCommand)
        self.assertEqual(self.svc._chunk_latency("vector", 8196, cmd), 47059 * 16)

    def test_streamed_vector_is_point_capped(self):
        cmd = self.svc._build_vector_cmd(_req(scan_path=VectorScanPath.horizontal_triangle))
        self.assertIsInstance(cmd, VectorScanCommand)
        self.assertEqual(cmd.link_dwell, 16)
        self.assertEqual(self.svc._chunk_latency("vector", 8196, cmd), 32768 * 16)

    def test_activate_sets_beam_rate_for_link_summary(self):
        cmd = self.svc._build_vector_cmd(_req())
        self.svc._activate_command(cmd)
        try:
            self.assertEqual(cmd.link_beam_hz, 8e6)
        finally:
            self.svc._deactivate_command(cmd)


class LinkStatsTest(unittest.TestCase):
    """Heuristic attribution in the end-of-scan [link] summary."""

    def _stats(self, flush_s, consumer_s, wall_s, chunks=10, pixels_per_chunk=47059):
        s = LinkStats("raster", dwell=16, beam_hz=8e6, expected_chunks=chunks)
        for _ in range(chunks):
            s.sent(flush_s)
            s.received(0.0, pixels_per_chunk)
            s.consumed(consumer_s)
        return s, wall_s

    def test_beam_time(self):
        s, _ = self._stats(0, 0, 1.0, chunks=1, pixels_per_chunk=8_000_000 // 17)
        self.assertAlmostEqual(s.beam_s(), 1.0, places=5)

    def test_link_keeps_up(self):
        s, wall = self._stats(0.001, 0.001, 1.05)      # beam 1.0 s
        self.assertEqual(s.limit_hint(wall), "none")

    def test_out_limited(self):
        s, wall = self._stats(0.2, 0.001, 2.2)         # 200 ms flush > 100 ms beam/chunk
        self.assertEqual(s.limit_hint(wall), "OUT(flush)")

    def test_consumer_limited(self):
        s, wall = self._stats(0.001, 0.3, 3.1)
        self.assertEqual(s.limit_hint(wall), "host(consumer)")

    def test_in_limited(self):
        s, wall = self._stats(0.001, 0.001, 4.0)
        self.assertEqual(s.limit_hint(wall), "IN(usb-read)")

    def test_unknown_without_rate(self):
        s = LinkStats("vector", dwell=None, beam_hz=8e6)
        s.received(0.1, 1000)
        self.assertEqual(s.limit_hint(1.0), "unknown")
        self.assertIn("beam=?", s.summary())


if __name__ == "__main__":
    unittest.main()
