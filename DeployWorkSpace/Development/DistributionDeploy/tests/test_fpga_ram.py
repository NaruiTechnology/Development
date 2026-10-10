import asyncio
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


script = Path(__file__).resolve().parents[4] / "Scripts/program-fpga-ram.py"
spec = importlib.util.spec_from_file_location("program_fpga_ram", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FpgaRamTests(unittest.IsolatedAsyncioTestCase):
    def device(self):
        return SimpleNamespace(download_target=AsyncMock(return_value=True),
                               bitstream_id=AsyncMock(return_value=b"fresh-image-id!!"),
                               _status=AsyncMock(return_value=4),
                               write_register=AsyncMock(), read_register=AsyncMock(return_value=0))

    async def test_forces_ram_reload_and_keeps_run_gate_closed(self):
        device = self.device()
        plan = SimpleNamespace(bitstream_id=b"fresh-image-id!!")
        self.assertEqual(await module.download_and_verify(device, plan, 1, 4), 4)
        device.download_target.assert_awaited_once_with(plan, reload=True)
        device.write_register.assert_awaited_once_with(1, 0)

    async def test_failed_download_wrong_id_and_open_gate_fail(self):
        for failure in ("download", "id", "gate"):
            device = self.device()
            if failure == "download":
                device.download_target.return_value = False
            elif failure == "id":
                device.bitstream_id.return_value = b"stale-image-id!!"
            else:
                device.read_register.return_value = 1
            with self.subTest(failure=failure), self.assertRaises(RuntimeError):
                await module.download_and_verify(device, SimpleNamespace(bitstream_id=b"fresh-image-id!!"), 1, 4)

    async def test_not_ready_fails_and_does_not_open_run_gate(self):
        from unittest.mock import patch
        device = self.device()
        device._status.return_value = 0
        with patch.object(module.asyncio, "sleep", new=AsyncMock()), self.assertRaises(RuntimeError):
            await module.download_and_verify(device, SimpleNamespace(bitstream_id=b"fresh-image-id!!"), 1, 4)
        device.write_register.assert_not_awaited()
