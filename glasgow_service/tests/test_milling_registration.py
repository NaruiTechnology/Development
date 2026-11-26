import asyncio
import base64

import httpx
import numpy as np
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from glasgow_service.exposure_lattice_adapter import lattice_stream
from glasgow_service.milling_registration import (
    MillingRegistrationRequest,
    register_milling_frames,
)
from glasgow_service.models import VectorRequest
from glasgow_service.roi_scaling import dac_pitch_codes


def test_masked_registration_retries_and_translates_each_dac_chunk():
    frame_edge = 512
    rng = np.random.default_rng(128)
    shape = (frame_edge, frame_edge)
    reference = rng.integers(2000, 10000, shape, dtype=np.uint16)
    mask = np.ones(shape, dtype=np.uint8)
    mask[140:372, 140:372] = 0
    pitch = dac_pitch_codes(0, 16383, frame_edge)

    def encode(frame):
        return base64.b64encode(frame.tobytes()).decode("ascii")

    def register(frame, pass_index, radius=12):
        return register_milling_frames(MillingRegistrationRequest(
            reference=encode(np.where(mask, reference, 0).astype("<u2")),
            current=encode(frame.astype("<u2")), mask=encode(mask),
            pitch_x=pitch, pitch_y=pitch, radius_x=radius, radius_y=radius,
            pass_index=pass_index,
        ))

    qualification = register(reference, 0)
    assert qualification.offset == pytest.approx((0, 0), abs=0.2)
    assert qualification.threshold_percent == 98

    for pass_index, (dx, dy) in enumerate(((4, -3), (-2, 5)), start=2):
        shifted = np.roll(reference, (dy, dx), axis=(0, 1)).astype(float)
        shifted += rng.normal(0, 1000, shape)
        shifted[mask == 0] = 16383
        match = register(np.clip(shifted, 0, 16383), pass_index)
        assert match.reason == "matched"
        assert match.offset == pytest.approx((dx * pitch, dy * pitch), abs=0.5)
        assert 75 <= match.threshold_percent < 98
        assert match.retries == 98 - match.threshold_percent
        offset = tuple(round(code) for code in match.offset)

        for cell_start, cell_end in ((0, 200), (200, 400)):
            lattice = dict(shape={"kind": "rect", "x0": 8000, "x1": 8200, "y0": 8000, "y1": 8200},
                           pitch_x=10, dwell=4, passes=1, axis="x",
                           cell_start=cell_start, cell_end=cell_end)
            original, count = lattice_stream(VectorRequest(pattern="lattice", lattice=lattice))
            corrected, corrected_count = lattice_stream(VectorRequest(
                pattern="lattice", lattice={**lattice, "dac_offset": offset},
            ))
            assert corrected_count == count == 200
            assert list(corrected()) == [
                (x + offset[0], y + offset[1], dwell, blank, index)
                for x, y, dwell, blank, index in original()
            ]

    wide = register(np.roll(reference, (-67, 80), axis=(0, 1)), 4, radius=105)
    assert wide.offset == pytest.approx((80 * pitch, -67 * pitch), abs=0.5)

    failed = register(rng.integers(0, 16384, shape, dtype=np.uint16), 5)
    assert failed.offset is None


def test_finer_sampling_recovers_a_shift_in_fine_texture(monkeypatch):
    from glasgow_service.processing_reference_api import router

    rng = np.random.default_rng(302)
    reference = rng.integers(2000, 12000, (1024, 1024), dtype=np.uint16)
    current = np.roll(reference, (-5, 3), axis=(0, 1))
    mask = np.ones_like(reference, dtype=np.uint8)
    mask[350:650, 350:650] = 0
    current[mask == 0] = 16383

    def request(resolution):
        sample = slice(None, None, 1024 // resolution)
        pitch = dac_pitch_codes(0, 16383, resolution)
        return dict(resolution=resolution, pitch_x=pitch, pitch_y=pitch,
                    radius_x=18, radius_y=18, pass_index=2,
                    reference=base64.b64encode(reference[sample, sample].astype("<u2").tobytes()).decode(),
                    current=base64.b64encode(current[sample, sample].astype("<u2").tobytes()).decode(),
                    mask=base64.b64encode(mask[sample, sample].tobytes()).decode())

    fine = request(1024)
    monkeypatch.setenv("GLASGOW_TOKEN", "registration-test")
    app = FastAPI()
    app.include_router(router)

    async def verify_registration():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            url = "/processing/milling-registration"
            assert (await client.post(url, json=fine)).status_code == 401
            response = await client.post(url, json=fine, headers={"Authorization": "Bearer registration-test"})
            response.raise_for_status()
        result = response.json()
        assert result["reason"] == "matched"
        assert result["offset"] == pytest.approx((48, -80), abs=0.2)

    async def verify_with_timeout():
        await asyncio.wait_for(verify_registration(), timeout=15)

    asyncio.run(verify_with_timeout())
    # The coarser raster misses the corresponding samples for this texture.
    assert register_milling_frames(MillingRegistrationRequest(**request(512))).offset is None
    with pytest.raises(ValidationError, match="Detector image length"):
        MillingRegistrationRequest(**{**fine, "current": request(512)["current"]})
    with pytest.raises(ValidationError, match="Mask length"):
        MillingRegistrationRequest(**{**fine, "mask": request(512)["mask"]})
    with pytest.raises(ValidationError, match="Unsupported registration resolution"):
        MillingRegistrationRequest(**{**fine, "resolution": 2048})
