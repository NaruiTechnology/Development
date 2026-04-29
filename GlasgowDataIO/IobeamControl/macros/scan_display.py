"""
IobeamControl/macros/scan_display.py
====================================

Host-side display helpers for scan results.

Two entry points, one per scan type:

    display_raster(pixels, x_res, y_res, *, title=None, save_path=None)
        16-bit ADC pixels in raster order -> imshow grid.

    display_vector(pixels, iter_points, *, x_res=2048, y_res=2048,
                   title=None, save_path=None)
        Pixels paired with the (x, y, dwell) iteration order from
        VectorScanCommand -> 2-D scatter plot, colour = pixel value.

Both functions accept either a flat sequence of ints/uint16, an
array.array('H'), or a numpy.ndarray. matplotlib is imported lazily so
modules that don't actually call display_*() don't pull in the GUI
dependency at import time (matters for headless CI).

If matplotlib isn't installed, both functions log a warning and
return None instead of raising - this keeps test_raster.py able to
opt-in to display via JSON config without breaking pytest on machines
that don't have the GUI stack.

Both functions accept `save_path=...` to write a PNG to disk
unconditionally; the on-screen show() only happens when save_path is
None and matplotlib is available.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def _to_numpy(seq, dtype="uint16"):
    """Coerce flat-sequence-or-array-or-ndarray -> numpy.ndarray."""
    try:
        import numpy as np
    except ImportError:
        logger.warning("numpy not installed; display disabled")
        return None
    if hasattr(seq, "shape"):  # already ndarray
        return seq.astype(dtype, copy=False)
    return np.fromiter(seq, dtype=dtype, count=len(seq))


def _maybe_show(fig, save_path):
    if save_path is not None:
        save_path = Path(save_path)
        save_path.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(save_path, dpi=120, bbox_inches="tight")
        logger.info(f"saved scan plot to {save_path}")
    else:
        try:
            import matplotlib.pyplot as plt  # noqa: F401
            # plt.show() is blocking; OK for interactive use, the test
            # suite should pass save_path=... so it doesn't hang in CI.
            import matplotlib.pyplot as plt
            plt.show()
        except Exception as exc:
            logger.warning(f"matplotlib show failed: {exc}")


def display_raster(pixels, x_res, y_res, *, title=None, save_path=None,
                   cmap="gray"):
    """
    Render `pixels` as an x_res x y_res image.

    pixels - flat row-major sequence of length x_res*y_res, 16-bit
             ADC values (the high 8 bits carry the actual sample;
             FakeAdcSimulator returns value << 6).
    x_res, y_res - integer resolution of the captured frame.
    title - optional plot title.
    save_path - if set, write PNG to this path instead of showing.
    cmap - matplotlib colormap name; "gray" matches the SEM aesthetic.

    Returns the figure on success, None if matplotlib/numpy are missing
    or pixel count doesn't match resolution.
    """
    arr = _to_numpy(pixels, dtype="uint16")
    if arr is None:
        return None
    expected = int(x_res) * int(y_res)
    got      = len(arr) if arr.ndim == 1 else arr.size
    if got != expected:
        logger.warning(
            f"display_raster: got {got} pixels, expected {expected} "
            f"({x_res}x{y_res}); plotting truncated/padded view")
        if got > expected:
            arr = arr[:expected]
        else:
            import numpy as np
            arr = np.concatenate([arr, np.zeros(expected - got, dtype="uint16")])
    arr = arr.reshape((y_res, x_res))

    try:
        import matplotlib.pyplot as plt
    except ImportError:
        logger.warning("matplotlib not installed; display_raster disabled")
        return None

    fig, ax = plt.subplots(figsize=(6, 6))
    # Show as 8-bit (high byte) so the eye sees the same range a
    # uint8-saved TIFF would.
    ax.imshow(arr >> 8, cmap=cmap, interpolation="nearest", aspect="equal",
              vmin=0, vmax=255)
    ax.set_title(title or f"Raster scan: {x_res} x {y_res}")
    ax.set_xlabel("X (pixels)")
    ax.set_ylabel("Y (pixels)")
    fig.tight_layout()
    _maybe_show(fig, save_path)
    return fig


def display_vector(pixels, iter_points, *, x_res=2048, y_res=2048,
                   title=None, save_path=None, cmap="gray"):
    """
    Render `pixels` as a scatter plot at the (x, y) coords from
    `iter_points`.

    pixels       - flat sequence of 16-bit ADC values, one per scan
                   point, in the same order iter_points yields them.
    iter_points  - iterable yielding (x, y, dwell) triples. Same
                   iterator that was fed to VectorScanCommand.
    x_res, y_res - axis ranges (default 2048x2048 = full DAC range).
    title, save_path, cmap - as for display_raster.

    Each point is plotted as a square at (x, y) coloured by its 8-bit
    grayscale value. Sparse vector scans render as a scatter; dense
    ones effectively recover the underlying raster image.
    """
    arr = _to_numpy(pixels, dtype="uint16")
    if arr is None:
        return None
    iter_list = list(iter_points)
    if len(iter_list) < arr.size:
        logger.warning(
            f"display_vector: {len(iter_list)} iter points < "
            f"{arr.size} pixels; truncating")
        arr = arr[:len(iter_list)]
    elif len(iter_list) > arr.size:
        iter_list = iter_list[:arr.size]

    try:
        import numpy as np
        import matplotlib.pyplot as plt
    except ImportError:
        logger.warning("matplotlib not installed; display_vector disabled")
        return None

    xs = np.fromiter((p[0] for p in iter_list), dtype="float32",
                     count=len(iter_list))
    ys = np.fromiter((p[1] for p in iter_list), dtype="float32",
                     count=len(iter_list))
    cs = (arr >> 8).astype("uint8")  # high byte = 8-bit equivalent

    fig, ax = plt.subplots(figsize=(6, 6))
    sc = ax.scatter(xs, ys, c=cs, cmap=cmap, s=2, vmin=0, vmax=255,
                    marker="s")
    ax.set_xlim(0, x_res)
    ax.set_ylim(y_res, 0)  # invert Y so (0,0) is top-left, matches imshow
    ax.set_aspect("equal")
    ax.set_title(title or f"Vector scan: {len(iter_list)} points")
    ax.set_xlabel("X (DAC code)")
    ax.set_ylabel("Y (DAC code)")
    fig.colorbar(sc, ax=ax, label="ADC sample (8-bit)")
    fig.tight_layout()
    _maybe_show(fig, save_path)
    return fig


def display_from_csv(csv_path, *, kind="raster", x_res=None, y_res=None,
                     iter_points=None, title=None, save_path=None):
    """
    Convenience wrapper for the existing _exportDataToCsvFile() output.

    The raster test writes one row per resolution-wide line, space-
    separated; we infer x_res/y_res from the file shape if not given.
    The vector test writes one row per chunk, no positional metadata,
    so the caller must supply iter_points (or pass kind="raster" if
    the dump is a uniform vector raster).
    """
    csv_path = Path(csv_path)
    if not csv_path.is_file():
        logger.error(f"display_from_csv: not found: {csv_path}")
        return None

    rows = []
    with csv_path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append([int(v) for v in line.split()])

    flat = [v for row in rows for v in row]

    if kind == "raster":
        if y_res is None:
            y_res = len(rows)
        if x_res is None and rows:
            x_res = len(rows[0])
        return display_raster(flat, x_res=x_res, y_res=y_res,
                              title=title or csv_path.name,
                              save_path=save_path)
    if kind == "vector":
        if iter_points is None:
            raise ValueError("kind='vector' requires iter_points")
        return display_vector(flat, iter_points,
                              title=title or csv_path.name,
                              save_path=save_path)
    raise ValueError(f"unknown kind: {kind}")
