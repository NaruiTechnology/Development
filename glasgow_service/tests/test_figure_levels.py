"""The scan figure must stretch to the detector signal, not to 0..full scale."""
import pytest

np = pytest.importorskip("numpy")

from glasgow_service.service import (
    _FIGURE_CLIP_HI_PCT,
    _FIGURE_CLIP_LO_PCT,
    _percentile_clip_uint16,
)


def _bench_frame():
    rng = np.random.default_rng(1)
    img = rng.integers(0x8700, 0x8C00, size=(256, 256)).astype(np.uint16)
    img[100:150, 100:150] = rng.integers(0x9800, 0xB000, size=(50, 50))
    img[0, :] = 0x8090  # dropout line
    img[10, 10] = 0xBA90  # hot pixel
    return img


def test_figure_window_tracks_data_and_ignores_outliers():
    img = _bench_frame()
    vmin, vmax = _percentile_clip_uint16(img, _FIGURE_CLIP_LO_PCT, _FIGURE_CLIP_HI_PCT)
    assert 0x8090 < vmin < 0x9000
    assert vmax < 0xBA90
    # far narrower than the old fixed 0..0xff00 window, so contrast is used
    assert (vmax - vmin) < 0x4000


def test_figure_window_flat_frame_is_valid():
    vmin, vmax = _percentile_clip_uint16(np.full((4, 4), 0x9000, dtype=np.uint16), 0.5, 99.5)
    assert vmax > vmin
