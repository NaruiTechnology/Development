"""log_power_good must report K1 state and must never break a scan."""
import asyncio
import logging
import unittest
from types import SimpleNamespace

from GlasgowDataIO.IobeamControl.transfer.glasgowStream import log_power_good


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


def _run(value=None, exc=None, address=0x0A):
    async def read_register(addr):
        if exc:
            raise exc
        assert addr == address
        return value
    logger = logging.getLogger(f"pg-test-{id(object())}")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    cap = _Capture()
    logger.addHandler(cap)
    device = SimpleNamespace(read_register=read_register)
    result = asyncio.run(log_power_good(logger, device, address, "connect"))
    return result, cap.records


class PowerGoodLogTest(unittest.TestCase):
    def test_high_is_info(self):
        result, records = _run(0b11)
        self.assertEqual(result, 3)
        self.assertEqual([r.levelno for r in records], [logging.INFO])
        self.assertIn("K1 high", records[0].getMessage())

    def test_low_is_warning_and_names_the_consequence(self):
        result, records = _run(0b10)
        self.assertEqual(result, 2)
        self.assertEqual([r.levelno for r in records], [logging.WARNING])
        self.assertIn("K1 LOW", records[0].getMessage())

    def test_unconfigured_pin_is_reported_not_treated_as_low(self):
        _, records = _run(0b00)
        self.assertEqual([r.levelno for r in records], [logging.INFO])
        self.assertIn("not configured", records[0].getMessage())

    def test_missing_address_is_silent_and_read_errors_never_raise(self):
        result, records = _run(address=None)
        self.assertIsNone(result)
        self.assertEqual(records, [])
        result, records = _run(exc=OSError("usb gone"))
        self.assertIsNone(result)
        self.assertEqual([r.levelno for r in records], [logging.WARNING])


if __name__ == "__main__":
    unittest.main()
