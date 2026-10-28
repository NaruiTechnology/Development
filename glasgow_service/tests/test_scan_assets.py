import hashlib
import json

import pytest

from glasgow_service import scan_assets


def test_chunked_asset_resumes_and_survives_cache_clear(tmp_path, monkeypatch):
    monkeypatch.setenv("GLASGOW_SCAN_ASSET_DIR", str(tmp_path))
    payload = json.dumps({"width": 2, "height": 2, "pixels": [1, 2, 3, 4]}).encode()
    asset_id = hashlib.sha256(payload).hexdigest()

    assert scan_assets.prepare(asset_id, len(payload))["offset"] == 0
    first = payload[:12]
    assert scan_assets.append(asset_id, 0, first)["offset"] == len(first)
    assert scan_assets.prepare(asset_id, len(payload))["offset"] == len(first)
    assert scan_assets.append(asset_id, 0, first)["offset"] == len(first)
    scan_assets.append(asset_id, len(first), payload[len(first):])
    assert scan_assets.complete_upload(asset_id)["cached"] is False
    scan_assets._load.cache_clear()
    assert scan_assets.load(asset_id).pixels == [1, 2, 3, 4]
    assert scan_assets.prepare(asset_id, len(payload))["cached"] is True


def test_asset_rejects_corrupt_or_oversized_data(tmp_path, monkeypatch):
    monkeypatch.setenv("GLASGOW_SCAN_ASSET_DIR", str(tmp_path))
    payload = b'{"width":1,"height":1,"pixels":[7]}'
    wrong_id = hashlib.sha256(b"different").hexdigest()
    scan_assets.prepare(wrong_id, len(payload))
    scan_assets.append(wrong_id, 0, payload)
    with pytest.raises(ValueError, match="checksum"):
        scan_assets.complete_upload(wrong_id)
    with pytest.raises(ValueError, match="1.."):
        scan_assets.prepare(wrong_id, scan_assets.MAX_ASSET_BYTES + 1)
