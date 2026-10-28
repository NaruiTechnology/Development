import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from glasgow_service import api, scan_assets


def make_request(parts):
    async def receive():
        if parts:
            return {"type": "http.request", "body": parts.pop(0), "more_body": bool(parts)}
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request({"type": "http", "method": "PUT", "path": "/"}, receive)


def test_chunk_endpoint_rejects_oversized_stream_before_appending():
    request = make_request([b"x" * (scan_assets.MAX_CHUNK_BYTES // 2),
                            b"x" * (scan_assets.MAX_CHUNK_BYTES // 2 + 1)])

    with pytest.raises(HTTPException) as exc:
        asyncio.run(api.append_scan_asset("0" * 64, request, 0))

    assert exc.value.status_code == 413