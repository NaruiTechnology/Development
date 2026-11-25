"""Translation registration of detector frames from outside the milling ROI."""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass

import numpy as np
from pydantic import BaseModel, Field, FiniteFloat

FRAME_EDGE = 256
FRAME_BYTES = FRAME_EDGE * FRAME_EDGE * 2
ENCODED_LENGTH = 4 * ((FRAME_BYTES + 2) // 3)
# Match the custom pattern retry cadence while keeping the milling confidence floor.
MATCH_UPPER_PERCENT = 98
MATCH_LOWER_PERCENT = 75


class RegistrationStrip(BaseModel):
    reference: str = Field(min_length=ENCODED_LENGTH, max_length=ENCODED_LENGTH)
    current: str = Field(min_length=ENCODED_LENGTH, max_length=ENCODED_LENGTH)
    pitch_x: FiniteFloat = Field(ge=1 / 256, le=64)
    pitch_y: FiniteFloat = Field(ge=1 / 256, le=64)
    radius_x: int = Field(ge=3, le=64)
    radius_y: int = Field(ge=3, le=64)


class MillingRegistrationRequest(BaseModel):
    strips: list[RegistrationStrip] = Field(min_length=1, max_length=4)


@dataclass(frozen=True)
class StripMatch:
    strip: RegistrationStrip
    score: float
    dx: float
    dy: float


@dataclass(frozen=True)
class MillingMatch:
    offset: tuple[float, float]
    correlation: float
    threshold_percent: int
    matched_strips: int


def _image(encoded: str) -> np.ndarray:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Invalid detector image encoding") from exc
    if len(raw) != FRAME_BYTES:
        raise ValueError("Invalid detector image size")
    return np.frombuffer(raw, dtype="<u2").reshape(FRAME_EDGE, FRAME_EDGE).astype(np.float64)


def _window_sum(image: np.ndarray, height: int, width: int) -> np.ndarray:
    integral = np.pad(image, ((1, 0), (1, 0))).cumsum(axis=0).cumsum(axis=1)
    return integral[height:, width:] - integral[:-height, width:] - integral[height:, :-width] + integral[:-height, :-width]


def _peak_offset(left: float, middle: float, right: float) -> float:
    curvature = left - 2 * middle + right
    return float(np.clip(0.5 * (left - right) / curvature, -0.5, 0.5)) if curvature < 0 else 0.0


def _match_strip(strip: RegistrationStrip) -> StripMatch | None:
    if min(strip.pitch_x, strip.pitch_y) * FRAME_EDGE < 16:
        return None
    rx, ry = strip.radius_x, strip.radius_y
    template = _image(strip.reference)[ry:-ry, rx:-rx]
    current = _image(strip.current)
    template = template - template.mean()
    energy = np.sum(template ** 2)
    if energy < template.size * 16:
        return None
    # Evaluate zero mean normalized cross-correlation over valid placements
    # only. A fixed interior template gives every displacement equal support.
    numerator = np.fft.irfft2(
        np.fft.rfft2(current) * np.fft.rfft2(template, s=current.shape).conj(),
        s=current.shape,
    )[:2 * ry + 1, :2 * rx + 1]
    sums = _window_sum(current, *template.shape)
    variance = _window_sum(current ** 2, *template.shape) - sums ** 2 / template.size
    scores = np.clip(numerator / np.sqrt(energy * np.maximum(variance, 1)), -1, 1)
    scores[variance < template.size * 16] = -1
    y, x = np.unravel_index(scores.argmax(), scores.shape)
    peak = float(scores[y, x])
    if peak < MATCH_LOWER_PERCENT / 100 or x in (0, 2 * rx) or y in (0, 2 * ry):
        return None
    competitors = scores.copy()
    competitors[max(0, y - 2):y + 3, max(0, x - 2):x + 3] = -1
    if peak - competitors.max() < 0.035:
        return None
    if strip.reference == strip.current:
        return StripMatch(strip, peak, 0.0, 0.0)
    dx = x - rx + _peak_offset(scores[y, x - 1], peak, scores[y, x + 1])
    dy = y - ry + _peak_offset(scores[y - 1, x], peak, scores[y + 1, x])
    return StripMatch(strip, peak, dx * strip.pitch_x, dy * strip.pitch_y)


def register_milling_frames(request: MillingRegistrationRequest) -> MillingMatch | None:
    """Return absolute DAC displacement from the initial image, or no reliable match."""
    # Reset the threshold on each request. Reuse the same image scores across
    # retries so each step needs no new scan, image upload, or correlation.
    thresholds = range(MATCH_UPPER_PERCENT, MATCH_LOWER_PERCENT - 1, -1)
    matches = [match for strip in request.strips if (match := _match_strip(strip)) is not None]
    for percent in thresholds:
        eligible = [match for match in matches if match.score >= percent / 100]
        if not eligible:
            continue
        best_x = min(eligible, key=lambda match: match.strip.pitch_x)
        best_y = min(eligible, key=lambda match: match.strip.pitch_y)
        dx, dy = best_x.dx, best_y.dy
        # Keep all reliable strips in the agreement check, including those
        # below the current retry threshold.
        if any(abs(match.dx - dx) > 1.5 * match.strip.pitch_x or
               abs(match.dy - dy) > 1.5 * match.strip.pitch_y for match in matches):
            return None
        return MillingMatch((dx, dy), min(best_x.score, best_y.score), percent, len(eligible))
    return None
