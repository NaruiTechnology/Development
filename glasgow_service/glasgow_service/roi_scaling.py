"""ROI scan scaling: the one place that turns a DAC-code ROI into scan pitch and zoom.

The DAC chunks of an ROI scan (service._dac_range_for_bounds / _roi_vector_iter)
and the magnification an ROI scan implies must come from the same arithmetic,
or the image the operator sees and the data the hardware receives drift apart.
The frontend mirrors this in lib/pixelSize.ts (dacCodePitch, selectionZoom).
"""
from typing import Optional, Tuple

DAC_CODES = 16384  # full DAC range 0..16383, inclusive
STEP_FRACTION = 256  # the FPGA steps in UQ8.8


def roi_span(start: int, end: int) -> int:
    """Number of DAC codes covered by an inclusive start..end range."""
    lo, hi = sorted((int(start), int(end)))
    return max(1, hi - lo + 1)


def dac_step(start: int, end: int, count: int) -> int:
    """UQ8.8 DAC step for `count` pixels over start..end (inclusive)."""
    return max(1, int((roi_span(start, end) / count) * STEP_FRACTION))


def dac_pitch_codes(start: int, end: int, count: int) -> float:
    """DAC codes between neighbouring pixels, as the FPGA actually steps."""
    return dac_step(start, end, count) / STEP_FRACTION


def roi_zoom(bounds: Optional[Tuple[int, int, int, int]]) -> float:
    """How many times smaller the ROI is than the full DAC range (1.0 = full frame).

    `bounds` is (x0, x1, y0, y1) as returned by service._roi_bounds. The scan
    magnification is the base magnification times this factor: the smaller the
    ROI, the larger the magnification. One value has to keep the whole ROI in
    view, so a non-square ROI is limited by its longer side.
    """
    if bounds is None:
        return 1.0
    x0, x1, y0, y1 = bounds
    return min(DAC_CODES / roi_span(x0, x1), DAC_CODES / roi_span(y0, y1))
