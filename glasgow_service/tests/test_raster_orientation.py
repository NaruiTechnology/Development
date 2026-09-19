"""The raster frame is row-major: X is the fast axis, one row per scan line.

That is what the FPGA emits (measured end to end through the gateware), what
the frontend canvas assumes (idx % resolution is the column), and what
scan_display and upstream OBI's frame buffer assume. The service PNG used to
transpose the frame for a column-major stream that does not exist.
"""
import array

import numpy as np

from glasgow_service.service import _raster_image_from_chunks


def make_frame(res):
    """Every pixel unique, so any transposition or shift is visible."""
    return (np.arange(res * res, dtype=np.uint16) * 7 + 3).reshape(res, res)


def chunked(flat, sizes):
    out, i = [], 0
    for size in sizes:
        out.append(array.array("H", flat[i:i + size].tolist()))
        i += size
    out.append(array.array("H", flat[i:].tolist()))
    return [c for c in out if len(c)]


def test_stream_order_is_x_fast_then_y():
    res = 8
    frame = make_frame(res)
    img = _raster_image_from_chunks(chunked(frame.flatten(), [5, 17, 30]), res, dwell=0, adc_latency=8)
    assert np.array_equal(img, frame)
    assert img[0, 1] == frame.flatten()[1], "the second sample is the next pixel along X"
    assert img[1, 0] == frame.flatten()[res], "the sample after one full row starts the next row"


def test_a_transposed_frame_is_not_accepted_as_correct():
    res = 8
    frame = make_frame(res)
    img = _raster_image_from_chunks(chunked(frame.flatten(), [64]), res, dwell=0, adc_latency=8)
    assert not np.array_equal(img, frame.T)


def test_truncated_scans_are_zero_padded_in_row_order():
    res = 8
    frame = make_frame(res)
    partial = frame.flatten()[: 3 * res + 2]        # three full rows and two pixels
    img = _raster_image_from_chunks(chunked(partial, [10]), res, dwell=0, adc_latency=8)
    assert np.array_equal(img[:3], frame[:3])
    assert np.array_equal(img[3, :2], frame[3, :2])
    assert not img[3, 2:].any() and not img[4:].any()


def test_surplus_samples_are_dropped():
    res = 4
    frame = make_frame(res)
    extra = np.concatenate([frame.flatten(), np.array([9999, 9999], dtype=np.uint16)])
    assert np.array_equal(_raster_image_from_chunks(chunked(extra, [7]), res, 0, 8), frame)
