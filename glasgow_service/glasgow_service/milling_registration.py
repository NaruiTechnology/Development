"""Translation registration of full-field detector frames outside the milling ROI."""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass

import numpy as np
from pydantic import BaseModel, Field, FiniteFloat

FRAME_EDGE = 512
FRAME_BYTES = FRAME_EDGE * FRAME_EDGE * 2
MASK_BYTES = FRAME_EDGE * FRAME_EDGE
ENCODED_LENGTH = 4 * ((FRAME_BYTES + 2) // 3)
MASK_ENCODED_LENGTH = 4 * ((MASK_BYTES + 2) // 3)
MATCH_UPPER_PERCENT = 98
MATCH_LOWER_PERCENT = 75
# Require a distinct correlation peak before the snapshot qualifies as a
# reliable registration reference. Qualification compares the frame to itself.
MIN_UNIQUE_PEAK_MARGIN = 0.035


class MillingRegistrationRequest(BaseModel):
    reference: str = Field(min_length=ENCODED_LENGTH, max_length=ENCODED_LENGTH)
    current: str = Field(min_length=ENCODED_LENGTH, max_length=ENCODED_LENGTH)
    mask: str = Field(min_length=MASK_ENCODED_LENGTH, max_length=MASK_ENCODED_LENGTH)
    pitch_x: FiniteFloat = Field(gt=0, le=64)
    pitch_y: FiniteFloat = Field(gt=0, le=64)
    radius_x: int = Field(ge=3, le=64)
    radius_y: int = Field(ge=3, le=64)
    pass_index: int = Field(0, ge=0)


@dataclass(frozen=True)
class MillingMatch:
    offset: tuple[float, float] | None
    correlation: float | None
    threshold_percent: int | None
    retries: int
    reason: str


def _decode(encoded: str, size: int, dtype: str) -> np.ndarray:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Invalid detector image encoding") from exc
    if len(raw) != size:
        raise ValueError("Invalid detector image size")
    return np.frombuffer(raw, dtype=dtype).reshape(FRAME_EDGE, FRAME_EDGE)


def _peak_offset(left: float, middle: float, right: float) -> float:
    curvature = left - 2 * middle + right
    return float(np.clip(0.5 * (left - right) / curvature, -0.5, 0.5)) if curvature < 0 else 0.0


def register_milling_frames(request: MillingRegistrationRequest) -> MillingMatch:
    """Return measured translation and confidence diagnostics for one full-field frame."""
    reference = _decode(request.reference, FRAME_BYTES, "<u2").astype(np.float64)
    current = _decode(request.current, FRAME_BYTES, "<u2").astype(np.float64)
    mask = _decode(request.mask, MASK_BYTES, "u1").astype(bool)
    if mask.mean() < 0.1:
        return MillingMatch(None, None, None, 0, "insufficient_unmasked_area")

    rx, ry = request.radius_x, request.radius_y
    # Six zero-padded cross-correlations provide masked normalized correlation
    # at every integer shift without scaling with the area of each search window.
    edge = FRAME_EDGE * 2
    m = mask.astype(np.float64)
    rm, cm = reference * m, current * m

    def fft(value: np.ndarray) -> np.ndarray:
        return np.fft.rfft2(value, s=(edge, edge))

    def corr(left: np.ndarray, right_fft: np.ndarray) -> np.ndarray:
        return np.fft.irfft2(np.conj(fft(left)) * right_fft, s=(edge, edge))

    fm = fft(m)
    fcm = fft(cm)
    count = corr(m, fm)
    sum_a = corr(rm, fm)
    sum_b = corr(m, fcm)
    sum_aa = corr(reference * reference * m, fm)
    sum_bb = corr(m, fft(current * current * m))
    sum_ab = corr(rm, fcm)
    scores = np.full((2 * ry + 1, 2 * rx + 1), -1.0, dtype=np.float64)
    for row, dy in enumerate(range(-ry, ry + 1)):
        iy = dy % edge
        for col, dx in enumerate(range(-rx, rx + 1)):
            ix = dx % edge
            n = count[iy, ix]
            if n < FRAME_EDGE * FRAME_EDGE / 5:
                continue
            cov = sum_ab[iy, ix] - sum_a[iy, ix] * sum_b[iy, ix] / n
            var_a = sum_aa[iy, ix] - sum_a[iy, ix] ** 2 / n
            var_b = sum_bb[iy, ix] - sum_b[iy, ix] ** 2 / n
            denominator = np.sqrt(max(0, var_a) * max(0, var_b))
            if denominator > 0:
                scores[row, col] = float(np.clip(cov / denominator, -1, 1))

    row, col = np.unravel_index(int(scores.argmax()), scores.shape)
    peak = float(scores[row, col])
    if peak < 0:
        return MillingMatch(None, None, None, 0, "low_texture")
    if row in (0, 2 * ry) or col in (0, 2 * rx):
        return MillingMatch(None, peak, None, 0, "search_limit")
    competitors = scores.copy()
    competitors[max(0, row - 2):row + 3, max(0, col - 2):col + 3] = -1
    if peak - float(competitors.max()) < MIN_UNIQUE_PEAK_MARGIN:
        return MillingMatch(None, peak, None, 0, "ambiguous_peak")
    threshold = next((value for value in range(MATCH_UPPER_PERCENT, MATCH_LOWER_PERCENT - 1, -1)
                      if peak >= value / 100), None)
    retries = MATCH_UPPER_PERCENT - threshold if threshold is not None else MATCH_UPPER_PERCENT - MATCH_LOWER_PERCENT
    if threshold is None:
        return MillingMatch(None, peak, None, retries, "low_correlation")
    dx = col - rx + _peak_offset(scores[row, col - 1], peak, scores[row, col + 1])
    dy = row - ry + _peak_offset(scores[row - 1, col], peak, scores[row + 1, col])
    return MillingMatch((dx * request.pitch_x, dy * request.pitch_y), peak, threshold, retries, "matched")
