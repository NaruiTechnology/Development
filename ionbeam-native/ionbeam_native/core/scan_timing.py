"""Port of ionbeam-web/frontend/src/lib/scanTiming.ts (revC3 acquisition timing)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence

from .jsmath import is_finite, to_fixed, trunc

GLASGOW_REVC3_CLOCK_HZ = 48_000_000
GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES = 3
DEFAULT_DWELL_PRESETS = (0, 1, 3, 7, 15, 31, 63)


@dataclass(frozen=True)
class ScanTimingEstimate:
    sample_period_ns: float
    samples_per_pixel: int
    pixel_dwell_ns: float
    pixel_rate: float
    pixel_count: int
    frame_seconds: float


@dataclass(frozen=True)
class DwellPresetOption:
    value: int
    label: str


def samples_per_pixel(dwell: float) -> int:
    return max(0, trunc(dwell)) + 1


def _half_period(adc_half_period) -> float:
    try:
        value = float(adc_half_period)
    except (TypeError, ValueError):
        return GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES
    return value if is_finite(value) and value >= 3 else GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES


def estimate_revc3_scan_timing(resolution: float, dwell: float,
                               adc_half_period=GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES) -> ScanTimingEstimate:
    safe_resolution = max(1, trunc(resolution))
    samples = samples_per_pixel(dwell)
    sample_period_ns = (2 * _half_period(adc_half_period) * 1e9) / GLASGOW_REVC3_CLOCK_HZ
    pixel_dwell_ns = sample_period_ns * samples
    pixel_rate = 1e9 / pixel_dwell_ns
    pixel_count = safe_resolution * safe_resolution
    return ScanTimingEstimate(
        sample_period_ns=sample_period_ns,
        samples_per_pixel=samples,
        pixel_dwell_ns=pixel_dwell_ns,
        pixel_rate=pixel_rate,
        pixel_count=pixel_count,
        frame_seconds=(pixel_count * pixel_dwell_ns) / 1e9,
    )


def conversion_hz(adc_half_period=GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES) -> float:
    return GLASGOW_REVC3_CLOCK_HZ / (2 * _half_period(adc_half_period))


def format_pixel_rate(pixels_per_second: float) -> str:
    if pixels_per_second >= 1e6:
        return f"{to_fixed(pixels_per_second / 1e6, 1 if pixels_per_second % 1e6 == 0 else 2)} MPix/s"
    return f"{to_fixed(pixels_per_second / 1e3, 0 if pixels_per_second % 1e3 == 0 else 2)} kPix/s"


def format_duration(seconds: float) -> str:
    if seconds < 1e-6:
        return f"{to_fixed(seconds * 1e9, 1)} ns"
    if seconds < 1e-3:
        return f"{to_fixed(seconds * 1e6, 1)} µs"
    if seconds < 1:
        return f"{to_fixed(seconds * 1e3, 1)} ms"
    return f"{to_fixed(seconds, 2 if seconds < 10 else 1)} s"


def format_nanoseconds(nanoseconds: float) -> str:
    if nanoseconds < 1_000:
        return f"{to_fixed(nanoseconds, 1)} ns"
    if nanoseconds < 1_000_000:
        return f"{to_fixed(nanoseconds / 1_000, 2)} µs"
    return f"{to_fixed(nanoseconds / 1_000_000, 2)} ms"


def revc3_dwell_preset_options(values: Sequence[int] = DEFAULT_DWELL_PRESETS,
                               adc_half_period=GLASGOW_REVC3_ADC_HALF_PERIOD_CYCLES) -> List[DwellPresetOption]:
    options = []
    for value in values:
        timing = estimate_revc3_scan_timing(1, value, adc_half_period)
        options.append(DwellPresetOption(
            value=value,
            label=(f"{value} — {timing.samples_per_pixel} samples/pixel — "
                   f"{format_nanoseconds(timing.pixel_dwell_ns)} — {format_pixel_rate(timing.pixel_rate)}"),
        ))
    return options
