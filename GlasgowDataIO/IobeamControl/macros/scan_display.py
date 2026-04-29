"""
IobeamControl/macros/scan_display.py
====================================

Host-side display helpers for scan results.

Three entry points:

    display_raster(pixels, x_res, y_res, *, title=None, save_path=None)
        16-bit ADC pixels in raster order -> imshow grid.

    display_vector(pixels, iter_points, *, x_res=2048, y_res=2048,
                   title=None, save_path=None)
        Pixels paired with the (x, y, dwell) iteration order from
        VectorScanCommand -> 2-D scatter plot, colour = pixel value.

    save_scan_from_config(chunks, kind, scan_config, *,
                          iter_points=None, resolution=None)
        TURNKEY HELPER. Pass it the raw chunks list straight from
        `async for chunk in conn.transfer_multiple(...)`, plus the
        scan-section dict from streamData.json. Reads `display.enabled`
        / `display.saveAs` and writes the PNG. After a successful
        save, launches the OS default image viewer unless
        `display.openViewer` is set to false. Use this from FastAPI
        handlers and any other call site that already has chunks +
        the JSON config in scope.

display_raster / display_vector accept either a flat sequence of
ints/uint16, an `array.array('H')`, or a numpy.ndarray. matplotlib is
imported lazily so modules that don't actually call display_*() don't
pull in the GUI dependency at import time.

If matplotlib isn't installed, both functions log a warning and return
None instead of raising - this keeps the FastAPI handler / pytest able
to opt-in to display via JSON config without breaking on machines that
don't have the GUI stack.

`save_path=...` writes a PNG to disk; tilde and $VARS are expanded.
`save_path=None` + matplotlib available opens a blocking GUI window.
"""

import logging
import os
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------- #
# Internal helpers
# ---------------------------------------------------------------------------- #
def _resolve_path(p):
    """
    Expand `~` and environment variables in `p` and return a Path.

    Bug magnet: `Path("~/Downloads/x.png")` does NOT expand `~`. It
    silently treats `~` as a directory name relative to cwd, and the
    later `mkdir(parents=True)` cheerfully creates it. The PNG ends up
    at `./~/Downloads/x.png`, which looks like "no file written"
    because nobody ever looks there.

    Fix: always run the path through expanduser + expandvars before
    doing anything else.
    """
    if p is None:
        return None
    return Path(os.path.expandvars(os.fspath(p))).expanduser()


def _to_numpy(seq, dtype="uint16"):
    """Coerce flat-sequence-or-array-or-ndarray -> numpy.ndarray."""
    try:
        import numpy as np
    except ImportError:
        logger.warning("numpy not installed; display disabled")
        return None
    if hasattr(seq, "shape"):  # already ndarray
        return seq.astype(dtype, copy=False)
    # array.array, list, tuple, generator -> ndarray. Use np.asarray for
    # buffers that already implement __array__; np.fromiter as fallback
    # for plain generators.
    try:
        return np.asarray(seq, dtype=dtype)
    except (TypeError, ValueError):
        return np.fromiter(seq, dtype=dtype)


def _flatten_chunks(chunks, dtype="uint16"):
    """
    Concatenate an iterable of array.array/bytes/list chunks into one
    flat numpy array. Used by save_scan_from_config to turn the
    transfer_multiple yield stream into a single buffer.

    Accepts:
      - list of array.array('H')         (the canonical case)
      - list of memoryview / bytes       (unflipped 16-bit big-endian)
      - list of list[int] / numpy.ndarray
      - a single concatenated array.array / ndarray (passthrough)
    """
    try:
        import numpy as np
    except ImportError:
        logger.warning("numpy not installed; cannot flatten chunks")
        return None

    if chunks is None:
        return np.zeros(0, dtype=dtype)

    # Already a flat array-like
    if hasattr(chunks, "shape") or (
        hasattr(chunks, "typecode") and chunks.typecode in ("H", "B")
    ):
        return _to_numpy(chunks, dtype=dtype)

    # Iterable of chunks
    parts = []
    for ch in chunks:
        if ch is None or len(ch) == 0:
            continue
        # bytes/bytearray/memoryview of 16-bit big-endian: byteswap on
        # little-endian hosts. recv_res() already produces native-endian
        # array.array('H'), so this branch only fires for raw bytes
        # captured upstream of recv_res.
        if isinstance(ch, (bytes, bytearray, memoryview)):
            arr = np.frombuffer(bytes(ch), dtype=">u2").astype(dtype)
        else:
            arr = _to_numpy(ch, dtype=dtype)
        parts.append(arr)

    if not parts:
        return np.zeros(0, dtype=dtype)
    return np.concatenate(parts)


def _open_in_viewer(path):
    """
    Launch the OS default image viewer on `path`, non-blocking.

    Returns True on a successful spawn, False otherwise. Never raises.

    Cross-platform behaviour:
      Linux/BSD - subprocess.Popen(['xdg-open', path]) detached via
                  start_new_session=True so SIGINT to uvicorn doesn't
                  kill the viewer. Requires xdg-utils (default on
                  Ubuntu desktop) and a DISPLAY/WAYLAND_DISPLAY env
                  pointing at a running X/Wayland session.
      macOS    - subprocess.Popen(['open', path]) — same semantics.
      Windows  - os.startfile(path), which is fire-and-forget.

    Headless servers and broken-DISPLAY VMs:
      The Popen call may succeed (the helper exits 0) but then the
      child immediately fails because there's no display to open on.
      We don't poll for that — the file is saved, the user can copy
      it elsewhere. We log a single warning if the spawn itself fails
      (xdg-open missing, permission denied, etc.).

    Why no DISPLAY check up front:
      Wayland sessions, remote sessions, and container forwarding all
      use different env vars, and trying to enumerate them is more
      brittle than just letting xdg-open do its dispatching and
      catching whatever comes back.
    """
    p = str(path)
    try:
        if sys.platform.startswith("darwin"):
            subprocess.Popen(
                ["open", p],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        elif sys.platform.startswith("win"):
            # os.startfile is the canonical Windows way to "open with
            # the registered handler"; non-blocking by definition.
            os.startfile(p)  # type: ignore[attr-defined]
        else:
            # Linux/BSD/everything else
            subprocess.Popen(
                ["xdg-open", p],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        logger.info(f"launched default viewer for {p}")
        return True
    except FileNotFoundError as exc:
        # xdg-open / open not installed (headless server, minimal
        # container, etc.). Save still succeeded; just log and move on.
        logger.warning(
            f"viewer launch skipped: required tool not found ({exc}). "
            f"File is saved at {p}.")
        return False
    except Exception as exc:
        logger.warning(f"viewer launch failed for {p}: {exc}")
        return False


def _maybe_show(fig, save_path):
    if save_path is not None:
        save_path = _resolve_path(save_path)
        save_path.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(save_path, dpi=120, bbox_inches="tight")
        logger.info(f"saved scan plot to {save_path}")
        return save_path
    try:
        import matplotlib.pyplot as plt
        plt.show()
    except Exception as exc:
        logger.warning(f"matplotlib show failed: {exc}")
    return None


# ---------------------------------------------------------------------------- #
# Public API: per-scan-type display
# ---------------------------------------------------------------------------- #
def display_raster(pixels, x_res, y_res, *, title=None, save_path=None,
                   cmap="gray"):
    """
    Render `pixels` as an x_res x y_res image.

    pixels - flat row-major sequence of length x_res*y_res, 16-bit
             ADC values (the high 8 bits carry the actual sample;
             FakeAdcSimulator returns value << 6, CommandExecutor
             shifts that left 2 more = pixel value in the high byte).
    x_res, y_res - integer resolution of the captured frame.
    title - optional plot title.
    save_path - if set, write PNG to this path instead of showing.
                `~` and $VARS are expanded.
    cmap - matplotlib colormap name; "gray" matches the SEM aesthetic.

    Returns the figure on success, None if matplotlib/numpy are missing.
    """
    arr = _to_numpy(pixels, dtype="uint16")
    if arr is None:
        return None
    expected = int(x_res) * int(y_res)
    got = len(arr) if arr.ndim == 1 else arr.size
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
        import matplotlib
        # Use a non-interactive backend when saving to disk so this works
        # cleanly under uvicorn/FastAPI (no DISPLAY, no Tk required).
        if save_path is not None:
            matplotlib.use("Agg", force=False)
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
    if save_path is not None:
        plt.close(fig)
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
        import matplotlib
        if save_path is not None:
            matplotlib.use("Agg", force=False)
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
    if save_path is not None:
        plt.close(fig)
    return fig


# ---------------------------------------------------------------------------- #
# Public API: turnkey config-driven save
# ---------------------------------------------------------------------------- #
def save_scan_from_config(chunks, kind, scan_config, *,
                          iter_points=None,
                          resolution=None,
                          x_res=None,
                          y_res=None):
    """
    One-call wrapper that does everything the FastAPI handler / test
    runner needs after a scan completes:

        1. Reads `display.enabled` and `display.saveAs` from the
           supplied scan_config dict (typically the rasterScan or
           vectorScan section of streamData.json's action block).
        2. If enabled, expands `~` / $VARS in `saveAs`.
        3. Concatenates `chunks` into a single uint16 buffer.
        4. Calls display_raster() or display_vector() with save_path.
        5. Returns the resolved Path on success, or None on any
           opt-out (display.enabled=false, no display block, missing
           saveAs, no matplotlib).

    Parameters
    ----------
    chunks
        Either an iterable of `array.array('H')` chunks (the natural
        output of `async for chunk in conn.transfer_multiple(cmd, ...)`),
        or a single pre-flattened sequence/ndarray.
    kind
        "raster" or "vector".
    scan_config
        The dict for this scan type, e.g.
            action["rasterScan"]   or   action["vectorScan"]
        Must contain a `display` sub-dict with at least:
            { "enabled": true, "saveAs": "~/Downloads/last.png" }
        Tolerates missing keys - returns None silently if `display`
        is absent or `enabled` is false.
    iter_points
        REQUIRED when kind == "vector". Same iterator that was fed to
        VectorScanCommand (e.g. macros.vector.default_iter()).
        Ignored for raster.
    resolution
        Square scan resolution. For raster, used as both x and y if
        x_res/y_res aren't given. Defaults to scan_config["resolution"]
        for raster, 2048 for vector.
    x_res, y_res
        Override the inferred axes (mainly for non-square scans).

    Failure modes are logged at INFO/WARNING and never raise: a missing
    PIL/matplotlib install or a malformed config returns None and lets
    the caller carry on. This is deliberate - the scan succeeded, the
    PNG is icing.
    """
    if not scan_config:
        return None

    display_cfg = scan_config.get("display") or {}
    if not display_cfg.get("enabled"):
        return None

    save_path = display_cfg.get("saveAs")
    if not save_path:
        logger.warning(f"display.enabled=true but display.saveAs is empty "
                       f"for kind={kind}; skipping save")
        return None
    save_path = _resolve_path(save_path)

    # Flatten chunks -> uint16 buffer
    pixels = _flatten_chunks(chunks)
    if pixels is None or pixels.size == 0:
        logger.warning(f"save_scan_from_config: no pixels to save "
                       f"(kind={kind}); skipping")
        return None

    if kind == "raster":
        # Resolve x_res/y_res
        if x_res is None or y_res is None:
            res = (resolution
                   or scan_config.get("resolution")
                   or int(pixels.size ** 0.5))
            x_res = x_res or res
            y_res = y_res or res
        title = display_cfg.get("title") or (
            f"Raster scan: {x_res}x{y_res}")
        fig = display_raster(pixels, x_res, y_res,
                             title=title,
                             save_path=save_path,
                             cmap=display_cfg.get("cmap", "gray"))
        result = save_path if fig is not None else None

    elif kind == "vector":
        if iter_points is None:
            logger.error("save_scan_from_config: kind='vector' requires "
                         "iter_points (the same iterator fed to "
                         "VectorScanCommand)")
            return None
        title = display_cfg.get("title") or f"Vector scan: {pixels.size} points"
        fig = display_vector(pixels, iter_points,
                             x_res=x_res or 2048,
                             y_res=y_res or 2048,
                             title=title,
                             save_path=save_path,
                             cmap=display_cfg.get("cmap", "gray"))
        result = save_path if fig is not None else None

    else:
        logger.error(f"save_scan_from_config: unknown kind: {kind!r}")
        return None

    # Optional: launch the OS default viewer on the saved file.
    # Defaults to True so existing configs without `openViewer` get
    # the new behaviour automatically. Set `"openViewer": false` in
    # the JSON `display` block to opt out (e.g. for batch automation
    # or headless CI runs where popping a window is unwanted).
    if result is not None and display_cfg.get("openViewer", True):
        _open_in_viewer(result)
    return result


# ---------------------------------------------------------------------------- #
# CSV replay (interactive use after the fact)
# ---------------------------------------------------------------------------- #
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
    csv_path = _resolve_path(csv_path)
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
