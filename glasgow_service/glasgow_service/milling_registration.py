"""Translation registration of full-field detector frames outside the milling ROI."""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass

import numpy as np
from pydantic import BaseModel, Field, FiniteFloat, model_validator

REGISTRATION_RESOLUTIONS = (512, 1024)
# The padded ROI occupies at least 4 µm on both axes. A 2 µm shift can
# therefore span up to half the raster, plus room to fit the peak.
MAX_SEARCH_RADIUS = max(REGISTRATION_RESOLUTIONS) // 2 + 2


def _encoded_length(size: int) -> int:
    return 4 * ((size + 2) // 3)


MATCH_UPPER_PERCENT = 98
MATCH_LOWER_PERCENT = 75
# Require a distinct correlation peak before the snapshot qualifies as a
# reliable registration reference. Qualification compares the frame to itself.
MIN_UNIQUE_PEAK_MARGIN = 0.035


class MillingRegistrationRequest(BaseModel):
    resolution: int = Field(default=REGISTRATION_RESOLUTIONS[0], strict=True)
    reference: str = Field(max_length=_encoded_length(max(REGISTRATION_RESOLUTIONS) ** 2 * 2))
    current: str = Field(max_length=_encoded_length(max(REGISTRATION_RESOLUTIONS) ** 2 * 2))
    mask: str = Field(max_length=_encoded_length(max(REGISTRATION_RESOLUTIONS) ** 2))
    pitch_x: FiniteFloat = Field(gt=0, le=64)
    pitch_y: FiniteFloat = Field(gt=0, le=64)
    radius_x: int = Field(ge=3, le=MAX_SEARCH_RADIUS)
    radius_y: int = Field(ge=3, le=MAX_SEARCH_RADIUS)
    pass_index: int = Field(0, ge=0)

    @model_validator(mode="after")
    def _check_frame_sizes(self) -> MillingRegistrationRequest:
        if self.resolution not in REGISTRATION_RESOLUTIONS:
            raise ValueError("Unsupported registration resolution")
        pixels = self.resolution ** 2
        if len(self.reference) != _encoded_length(pixels * 2) or len(self.current) != _encoded_length(pixels * 2):
            raise ValueError("Detector image length does not match the registration resolution")
        if len(self.mask) != _encoded_length(pixels):
            raise ValueError("Mask length does not match the registration resolution")
        if max(self.radius_x, self.radius_y) > self.resolution // 2 + 2:
            raise ValueError("Search radius exceeds the limit for this registration resolution")
        return self


@dataclass(frozen=True)
class MillingMatch:
    offset: tuple[float, float] | None
    correlation: float | None
    threshold_percent: int | None
    retries: int
    reason: str


def _decode(encoded: str, resolution: int, dtype: str) -> np.ndarray:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Invalid detector image encoding") from exc
    if len(raw) != resolution ** 2 * np.dtype(dtype).itemsize:
        raise ValueError("Invalid detector image size")
    return np.frombuffer(raw, dtype=dtype).reshape(resolution, resolution)


def _peak_offset(left: float, middle: float, right: float) -> float:
    curvature = left - 2 * middle + right
    return float(np.clip(0.5 * (left - right) / curvature, -0.5, 0.5)) if curvature < 0 else 0.0


def register_milling_frames(request: MillingRegistrationRequest) -> MillingMatch:
    """Return measured translation and confidence diagnostics for one full-field frame."""
    resolution = request.resolution
    reference = _decode(request.reference, resolution, "<u2").astype(np.float64)
    current = _decode(request.current, resolution, "<u2").astype(np.float64)
    mask = _decode(request.mask, resolution, "u1").astype(bool)
    if mask.mean() < 0.1:
        return MillingMatch(None, None, None, 0, "insufficient_unmasked_area")

    rx, ry = request.radius_x, request.radius_y
    # Six zero-padded cross-correlations provide masked normalized correlation
    # at every integer shift without scaling with the area of each search window.
    edge = resolution * 2
    window = np.ix_(np.arange(-ry, ry + 1) % edge, np.arange(-rx, rx + 1) % edge)
    m = mask.astype(np.float64)
    rm, cm = reference * m, current * m

    def fft(value: np.ndarray) -> np.ndarray:
        return np.fft.rfft2(value, s=(edge, edge), axes=(0, 1))

    def corr(left: np.ndarray, right: np.ndarray) -> np.ndarray:
        spectrum = np.conj(left)
        spectrum *= right
        # Keep only the requested shifts, especially for 1024 px rasters.
        return np.fft.irfft2(spectrum, s=(edge, edge), axes=(0, 1))[window]

    fm = fft(m)
    frm = fft(rm)
    fcm = fft(cm)
    count = np.rint(corr(fm, fm))
    n = np.maximum(count, 1)
    sum_a = corr(frm, fm)
    sum_b = corr(fm, fcm)
    var_a = corr(fft(reference * rm), fm) - sum_a ** 2 / n
    var_b = corr(fm, fft(current * cm)) - sum_b ** 2 / n
    covariance = corr(frm, fcm) - sum_a * sum_b / n
    denominator = np.sqrt(np.maximum(0, var_a) * np.maximum(0, var_b))
    scores = np.full(count.shape, -1.0)
    valid = (count >= resolution ** 2 / 5) & (denominator > 0)
    np.divide(covariance, denominator, out=scores, where=valid)
    np.clip(scores, -1, 1, out=scores)

    row, col = np.unravel_index(int(scores.argmax()), scores.shape)
    peak = float(scores[row, col])
    if peak < 0:
        return MillingMatch(None, None, None, 0, "low_texture")
    if row in (0, 2 * ry) or col in (0, 2 * rx):
        return MillingMatch(None, peak, None, 0, "search_limit")
    competitors = scores.copy()
    neighborhood = resolution // 256
    competitors[max(0, row - neighborhood):row + neighborhood + 1,
                max(0, col - neighborhood):col + neighborhood + 1] = -1
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
