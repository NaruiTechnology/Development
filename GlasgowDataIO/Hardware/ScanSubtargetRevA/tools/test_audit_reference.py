"""Regression checks for sample-count evidence handling."""
import io
from pathlib import Path
import unittest
from unittest.mock import patch

from audit_reference import capture_summary, sexpr


class CaptureTests(unittest.TestCase):
    def summarize(self, text):
        with patch.object(Path, "open", return_value=io.StringIO(text)):
            with patch("audit_reference.digest", return_value="test-source"):
                return capture_summary(Path("fixture.log"))

    def test_sync_excluded_and_big_endian_samples_counted(self):
        result = self.summarize(
            "FIFO: read <ffff007b>\nFIFO: read <3fff00012000>\n")
        self.assertEqual(result["sync_reply_records_excluded"], 1)
        self.assertEqual(result["visible_complete_words"], 3)
        self.assertEqual(result["visible_3fff_words"], 1)
        self.assertEqual(result["visible_min"], 1)
        self.assertEqual(result["visible_max"], 0x3FFF)

    def test_truncated_transfer_does_not_invent_unlogged_samples(self):
        result = self.summarize(
            "FIFO: read <3fff3fff... (1026 bytes total)>\n")
        self.assertEqual(result["truncated_data_read_records"], 1)
        self.assertEqual(result["visible_complete_words"], 2)

    def test_incomplete_word_is_reported_not_counted(self):
        result = self.summarize("FIFO: read <3fff20>\n")
        self.assertEqual(result["records_with_incomplete_visible_word"], 1)
        self.assertEqual(result["visible_complete_words"], 1)

    def test_long_payload_starting_ffff_is_not_sync(self):
        result = self.summarize("FIFO: read <ffff00010002>\n")
        self.assertEqual(result["sync_reply_records_excluded"], 0)
        self.assertEqual(result["visible_complete_words"], 3)

    def test_send_records_are_not_received_samples(self):
        result = self.summarize("FIFO: write <3fff3fff>\n")
        self.assertEqual(result["visible_complete_words"], 0)
        self.assertIsNone(result["visible_min"])


class SExpressionTests(unittest.TestCase):
    def test_quoted_parentheses_do_not_change_structure(self):
        self.assertEqual(sexpr('(pad "1" (net 2 "Net-(U9-Ain+)"))'),
                         ["pad", "1", ["net", "2", "Net-(U9-Ain+)"]])

    def test_unbalanced_input_rejected(self):
        with self.assertRaises(ValueError):
            sexpr("(pad (net 1)")


if __name__ == "__main__":
    unittest.main()
