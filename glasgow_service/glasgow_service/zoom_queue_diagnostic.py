"""Reproduce queued or superseded Zoom using the real live-control handler.

Run from Development with PYTHONPATH=.:glasgow_service:
    python -m glasgow_service.zoom_queue_diagnostic --pipeline 32 --rapid

A temporary simulation-only config is used; no device or deployed config is touched.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import suppress
import json
import logging
from pathlib import Path
import tempfile
import time

from . import api
from .models import RasterRequest, VectorRequest
from .service import DeviceService, LOG_NAME


class _ControlSocket:
    """In-memory WebSocket frames, dispatched through the production handler."""
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.replies = asyncio.Queue()

    async def receive(self):
        return await self.incoming.get()

    async def send_json(self, payload):
        await self.replies.put(payload)

    async def zoom(self, request_id, zoom):
        width = 16384 // zoom
        start = (16384 - width) // 2
        roi = dict(x_start=start, x_end=start + width - 1,
                   y_start=start, y_end=start + width - 1)
        control = dict(event="update_geometry", id=request_id,
                       geometry=dict(roi=roi, parallel_rois=None),
                       diagnostics=dict(zoom=zoom, regionCount=0))
        await self.incoming.put({"type": "websocket.receive", "text": json.dumps(control)})
        reply = await asyncio.wait_for(self.replies.get(), 5)
        if reply.get("event") != "geometry_updated" or reply.get("id") != request_id:
            raise RuntimeError(f"Geometry was not accepted: {reply}")
        return start << 2


async def reproduce(*, pipeline=8, kind="raster", rapid=False, chunk_ms=100):
    """Return delivered-sample evidence; INFO logs record the control/queue timeline."""
    config_path = Path(__file__).resolve().parents[2] / "GlasgowDataIO/Json/streamData.json"
    config = json.loads(config_path.read_text())
    config.update(IsProduction=False, DumpData=False)
    action = config["Actions"][0]["streamData"]["actionData"]
    for name in ["rasterScan", "vectorScan"]:
        action[name]["max_pipeline"] = pipeline
    fields = dict(dwell=1, latency_bytes=16384, continuous=True,
                  simulation={"enabled": True, "mode": "loopback", "chunkIntervalMs": chunk_ms})
    req = (RasterRequest(resolution=128, **fields) if kind == "raster" else
           VectorRequest(vector_resolution=128, scan_path="horizontal_sawtooth", **fields))
    with tempfile.TemporaryDirectory(prefix="zoom-queue-") as directory:
        path = Path(directory) / "streamData.json"
        path.write_text(json.dumps(config))
        service = DeviceService(str(path))
        service._config.DumpData = False
        previous_service = api.svc
        api.svc = service
        socket = _ControlSocket()
        method = service.raster_scan if kind == "raster" else service.vector_scan
        stream = method(req, native_samples=True)
        watcher = None
        try:
            first = await anext(stream)
            if first[0] != 0:
                raise RuntimeError("The diagnostic must begin with full-field X=0")
            watcher = asyncio.create_task(api._watch_client_disconnect(socket, asyncio.current_task(), kind))
            requests = []
            observations = []
            if rapid:
                await socket.zoom(1, 2)
                target = await socket.zoom(2, 4)
                requests = [2, 4]
                pending = [4]
            else:
                pending = [2, 4, 1]
            for request_id, zoom in enumerate(pending, 1):
                started = time.monotonic()
                if not rapid:
                    target = await socket.zoom(request_id, zoom)
                    requests.append(zoom)
                received = []
                for _ in range(pipeline + 3):
                    code = (await anext(stream))[0]
                    received.append(code)
                    if code == target:
                        break
                else:
                    raise RuntimeError("The queued Zoom never reached simulated output")
                observations.append(dict(zoom=zoom, stale_chunks=len(received) - 1,
                                         elapsed_ms=round((time.monotonic() - started) * 1000, 2),
                                         first_sample_codes=received))
            return dict(kind=kind, max_pipeline=pipeline, chunk_interval_ms=chunk_ms,
                        mode="rapid" if rapid else "sequential", accepted_zooms=requests,
                        observations=observations,
                        intermediate_zoom_2_absent=(rapid and all(
                            4096 << 2 not in item["first_sample_codes"] for item in observations)))
        finally:
            if watcher:
                watcher.cancel()
                with suppress(asyncio.CancelledError):
                    await watcher
            service.abort_active_scan()
            await stream.aclose()
            api.svc = previous_service


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pipeline", type=int, default=8, choices=range(1, 129), metavar="1..128")
    parser.add_argument("--kind", choices=["raster", "vector"], default="raster")
    parser.add_argument("--rapid", action="store_true", help="Accept Zoom 2 then 4 before encoding resumes")
    parser.add_argument("--chunk-ms", type=float, default=100)
    args = parser.parse_args()
    logger = logging.getLogger(LOG_NAME)
    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logger.addHandler(handler)
    result = asyncio.run(reproduce(pipeline=args.pipeline, kind=args.kind,
                                  rapid=args.rapid, chunk_ms=args.chunk_ms))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
