import csv
import unittest
import asyncio
import time
import logging
from pathlib import Path

from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from GlasgowDataIO.IobeamControl.transfer.mock import MockConnection
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.support.logging import dump_hex
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode, BeamType
from AutomationPy.buildingblocks.automation_config import AutomationConfig
from AutomationPy.buildingblocks.definitions import Consts
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.scan_params import VectorParams

logger = logging.getLogger()

JSON_PATH = r'./Development/GlasgowDataIO/Json/streamData_unit_test.json'


class VectorScanTest(unittest.TestCase):
    """Wet-run vector scan test, parameterized through VectorParams.

    Previously this test reassigned a *local* LATENCY in setUp, which
    didn't override the class-level LATENCY=8196 the rest of the test
    used. (Classic Python "you assigned to a local, not a class attr"
    bug.) Now VectorParams.from_json provides defaults and PARAM_OVERRIDES
    customizes them in one place.
    """

    PARAM_OVERRIDES: dict = {}

    def setUp(self):
        if Path(JSON_PATH).is_file():
            self._config = AutomationConfig(JSON_PATH)
            vector_block = (
                util.GetStateConfigByName(self._config, 'streamData')
                [Consts.ACTION_DATA].get('vectorScan')
            )
        else:
            self._config = None
            vector_block = None

        self.params: VectorParams = VectorParams.from_json(vector_block).override(
            **self.PARAM_OVERRIDES,
        )
        try:
            self.beam_type = BeamType[self.params.beam_type]
        except KeyError:
            self.beam_type = BeamType.Ion

    # ------------------------------------------------------------------ #
    # Mock / simulation test (no hardware).                              #
    # ------------------------------------------------------------------ #
    async def scan(self):
        try:
            output_mode = OutputMode[self.params.output_mode]
        except KeyError:
            output_mode = OutputMode.SixteenBit

        test_cmd = VectorScanCommand(
            cookie=self.params.cookie,
            output_mode=output_mode,
            beam_type=self.beam_type,
            external_control=self.params.external_control,
            max_pipeline=self.params.max_pipeline,
            fpga_pipeline_depth_pixels=self.params.fpga_pipeline_depth_pixels,
            drain_safety_factor=self.params.drain_safety_factor,
            sender_drain_timeout_s=self.params.sender_drain_timeout_s,
            drain_floor_pixels=self.params.effective_drain_floor_pixels,
        )

        start_process = time.perf_counter()
        test_cmd._pre_process_chunks(latency=self.params.latency_bytes)
        end_process = time.perf_counter()

        conn = MockConnection()
        await conn._connect()

        start_send = time.perf_counter()
        async for chunk in conn.transfer_multiple(
                test_cmd, latency=self.params.latency_bytes):
            print(f"chunk: {dump_hex(chunk)}")
        end_send = time.perf_counter()

        print(f"process time: {end_process - start_process:04f}, "
              f"send time: {end_send - start_send:04f}")

    def test_scan(self):
        asyncio.run(self.scan())
        self.assertTrue(True)

    def test_lazy_transfer_does_not_split_point_iterator(self):
        async def run_scan(pre_process: bool):
            points = ((i, i, 1) for i in range(10))
            cmd = VectorScanCommand(
                cookie=self.params.cookie,
                output_mode=OutputMode.SixteenBit,
                beam_type=self.beam_type,
                external_control=self.params.external_control,
                iter_points=points,
                drain_floor_pixels=1,
                max_pipeline=self.params.max_pipeline,
                fpga_pipeline_depth_pixels=self.params.fpga_pipeline_depth_pixels,
                drain_safety_factor=self.params.drain_safety_factor,
                sender_drain_timeout_s=self.params.sender_drain_timeout_s,
            )
            if pre_process:
                cmd._pre_process_chunks(latency=2)

            conn = MockConnection()
            await conn._connect()
            chunks = []
            async for chunk in conn.transfer_multiple(cmd, latency=2):
                chunks.append(chunk)
            return chunks

        lazy_chunks = asyncio.run(run_scan(pre_process=False))
        processed_chunks = asyncio.run(run_scan(pre_process=True))

        self.assertEqual(
            [len(chunk) for chunk in lazy_chunks],
            [len(chunk) for chunk in processed_chunks],
        )
        self.assertEqual(sum(len(chunk) for chunk in lazy_chunks), 10)

    # ------------------------------------------------------------------ #
    # Wet-run test: real Glasgow hardware.                               #
    # ------------------------------------------------------------------ #
    async def scan_wet_run(self):
        self.chunks = []
        self.chunks_received = 0
        self.process_time = 0.0
        self.send_time = 0.0

        if self._config is None:
            self.skipTest("no config")

        try:
            output_mode = OutputMode[self.params.output_mode]
        except KeyError:
            output_mode = OutputMode.SixteenBit

        test_cmd = VectorScanCommand(
            cookie=self.params.cookie,
            output_mode=output_mode,
            beam_type=self.beam_type,
            external_control=self.params.external_control,
            max_pipeline=self.params.max_pipeline,
            fpga_pipeline_depth_pixels=self.params.fpga_pipeline_depth_pixels,
            drain_safety_factor=self.params.drain_safety_factor,
            sender_drain_timeout_s=self.params.sender_drain_timeout_s,
            drain_floor_pixels=self.params.effective_drain_floor_pixels,
        )

        print(f"[test] === VectorScan, latency={self.params.latency_bytes}, "
              f"max_pipeline={self.params.max_pipeline}, "
              f"drain_floor={self.params.effective_drain_floor_pixels} ===",
              flush=True)

        # Pre-processing is host-side CPU work, independent of the USB
        # transfer itself, so time it separately.
        start_process = time.perf_counter()
        test_cmd._pre_process_chunks(latency=self.params.latency_bytes)
        end_process = time.perf_counter()
        self.process_time = end_process - start_process
        print(f"[test] pre-process time: {self.process_time:04f}s", flush=True)

        conn = GlasgowConnection(self._config)
        await conn._connect()
        if not conn.connected:
            print("[test] connection failed")
            return

        start_send = time.perf_counter()
        try:
            async for chunk in conn.transfer_multiple(
                    test_cmd, latency=self.params.latency_bytes):
                self.chunks.append(chunk)
                self.chunks_received += 1
                # Sparse preview so the log doesn't drown on large streams:
                # first 3 chunks, then every 128th.
                if (self.chunks_received <= 3
                        or self.chunks_received % 128 == 0):
                    preview = (dump_hex(bytes(chunk)[:16])
                               if chunk is not None else "<None>")
                    length = len(chunk) if chunk is not None else 0
                    print(f"[test] chunk #{self.chunks_received} "
                          f"len={length}: {preview}", flush=True)
        except Exception as e:
            print(f"[test] EXCEPTION during transfer_multiple after "
                  f"{self.chunks_received} chunks: {type(e).__name__}: {e}",
                  flush=True)
            raise
        end_send = time.perf_counter()
        self.send_time = end_send - start_send

        print(f"[test] transfer complete after {self.chunks_received} chunks",
              flush=True)
        print(f"[test] process time: {self.process_time:04f}s, "
              f"send time: {self.send_time:04f}s", flush=True)

    def test_scan_wet_run(self):
        asyncio.run(self.scan_wet_run())

        # Dump received chunks before assertions so we still get the file
        # even if a check below fails. Skipped if the scan aborted early.
        if self.chunks:
            self._exportDataToCsvFile()

        self.assertGreater(
            self.chunks_received, 0,
            f"expected at least one chunk, got {self.chunks_received}",
        )

        # Every chunk should be non-empty.
        for i, chunk in enumerate(self.chunks):
            self.assertGreater(
                len(chunk), 0,
                f"chunk {i} is empty",
            )

        # Sanity check: at least one chunk somewhere in the stream contains
        # non-zero data. (See history comment in the original test for why
        # we don't assert "chunk 2 != all zeros" — with default_iter() the
        # first ~64 chunks are legitimately all-zero on FakeAdcSimulator
        # patterns because host x in 0..255 all reads image column 0.)
        self.assertTrue(
            any(any(v != 0 for v in chunk) for chunk in self.chunks),
            "every chunk is all zeros — scan returned no real data",
        )

    def _exportDataToCsvFile(self):
        if not self._config or not getattr(self._config, "DumpData", False):
            return

        downloads_dir = Path.home() / "Downloads"
        downloads_dir.mkdir(parents=True, exist_ok=True)
        csv_path = downloads_dir / f"vector_latency{self.params.latency_bytes}.csv"

        total_values = 0
        with csv_path.open("w", newline="") as f:
            writer = csv.writer(f, delimiter=" ")
            for chunk in self.chunks:
                writer.writerow(chunk)
                total_values += len(chunk)

        print(f"[test] wrote CSV: {csv_path} "
              f"({total_values} values from {len(self.chunks)} chunks)",
              flush=True)
