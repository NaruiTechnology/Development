"""Minimal WebSocket client: request a raster scan, count chunks as they
stream in. Useful as a smoke test and a template for real clients.

    python examples/ws_client.py
"""
import asyncio
import json
import os
import sys

import websockets


URL   = os.environ.get("GLASGOW_WS", "ws://127.0.0.1:8765/scan/raster/stream")
TOKEN = os.environ.get("GLASGOW_TOKEN")


async def main():
    headers = {}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"

    async with websockets.connect(URL, additional_headers=headers) as ws:
        await ws.send(json.dumps({
            "resolution":    512,
            "dwell":         2,
            "latency_bytes": 16384,
            "frame_blank":   False,
        }))

        chunks = 0
        total_bytes = 0
        async for msg in ws:
            if isinstance(msg, bytes):
                chunks += 1
                total_bytes += len(msg)
                if chunks % 8 == 0:
                    print(f"  chunk #{chunks}: {len(msg)} bytes "
                          f"(total {total_bytes})", flush=True)
            else:
                event = json.loads(msg)
                print("event:", event)
                if event.get("event") in ("done", "error"):
                    break

        print(f"received {chunks} chunks, {total_bytes} bytes total")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
