import json
import logging

from glasgow_service.executor_logging import JsonFormatter


def test_json_formatter_has_structured_fields():
    record = logging.LogRecord("test", logging.INFO, __file__, 1, "hello", (), None)
    record.event = "ready"
    payload = json.loads(JsonFormatter().format(record))
    assert payload["message"] == "hello"
    assert payload["event"] == "ready"
    assert "timestamp" in payload
