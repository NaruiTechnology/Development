"""Port of ionbeam-web/backend/src/wsProxy.ts ``streamMockAdc``.

In the web stack, an ADC test with ``simulation: true`` never reaches the
Python service: the Node proxy synthesises it. The desktop app has no proxy,
so the same generator lives here (identical LFSR, so a given seed produces
the same trace as the browser).
"""
from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator

import numpy as np

SAMPLES_PER_CHUNK = 4096
CHUNK_INTERVAL_S = 0.1


def _lfsr_step(state: int) -> int:
    feedback = ((state >> 13) ^ (state >> 12)) & 1
    return ((state << 1) & 0x3FFF) | feedback


def mock_adc_chunk(state: int) -> tuple[int, bytes]:
    """One 4096-sample chunk; returns (new_state, big-endian uint16 bytes)."""
    state = _lfsr_step(state)
    level = state
    out = np.empty(SAMPLES_PER_CHUNK, dtype=">u2")
    for index in range(SAMPLES_PER_CHUNK):
        state = _lfsr_step(state)
        noise = ((state & 0xFF) - 128) * 8
        out[index] = max(0, min(0x3FFF, level + noise))
    return state, out.tobytes()


async def mock_adc_stream(duration_minutes: int, seed: int, stop: asyncio.Event) -> AsyncIterator[bytes]:
    duration = duration_minutes if duration_minutes in (5, 10, 15, 20) else 5
    state = max(1, int(seed) & 0x3FFF)
    deadline = time.monotonic() + duration * 60
    while not stop.is_set() and time.monotonic() < deadline:
        state, chunk = mock_adc_chunk(state)
        yield chunk
        try:
            await asyncio.wait_for(stop.wait(), timeout=CHUNK_INTERVAL_S)
        except asyncio.TimeoutError:
            pass
