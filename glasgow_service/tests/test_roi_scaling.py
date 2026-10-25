"""ROI DAC pitch and zoom: the arithmetic the scan chunks and the UI both rely on."""
from glasgow_service.roi_scaling import dac_pitch_codes, dac_step, roi_span, roi_zoom


def test_full_range_512_matches_firmware_step():
    # 16384 codes / 512 px = 32 codes per pixel = 32 * 256 in UQ8.8
    assert dac_step(0, 16383, 512) == 32 * 256
    assert dac_pitch_codes(0, 16383, 512) == 32.0


def test_span_is_inclusive_and_order_independent():
    assert roi_span(10, 19) == 10
    assert roi_span(19, 10) == 10


def test_step_truncates_to_one_256th_of_a_code():
    # 1000 codes / 512 px = 1.953125 -> 500 / 256, exactly representable
    assert dac_step(0, 999, 512) == 500
    # 1000 codes / 300 px = 3.3333.. -> truncated, never rounded up
    assert dac_step(0, 999, 300) == 853
    assert dac_pitch_codes(0, 999, 300) == 853 / 256


def test_step_never_zero():
    assert dac_step(5, 5, 4096) == 1


def test_zoom_full_frame_is_one():
    assert roi_zoom(None) == 1.0
    assert roi_zoom((0, 16383, 0, 16383)) == 1.0


def test_zoom_grows_as_roi_shrinks():
    assert roi_zoom((0, 8191, 0, 8191)) == 2.0
    assert roi_zoom((0, 4095, 0, 4095)) == 4.0
    assert roi_zoom((0, 1023, 0, 1023)) == 16.0


def test_zoom_is_limited_by_the_longer_roi_side():
    # a full-width, quarter-height strip still needs the full-width field of view
    assert roi_zoom((0, 16383, 0, 4095)) == 1.0
    assert roi_zoom((0, 8191, 0, 2047)) == 2.0
