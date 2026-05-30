"""
IobeamControl/applet/imageSource.py
===================================

Host-side helper that produces the 8-bit pixel array consumed by
FakeAdcSimulator's BRAM init. Three modes:

    load_image(path, resolution=64, invert=False) -> list[int]
        Open a PNG/BMP/JPEG via PIL, convert to 8-bit grayscale,
        resize to `resolution x resolution`, return as a flat
        row-major list of N*N ints (each 0..255).

    random_image(resolution=64, seed=None) -> list[int]
        Generate `resolution * resolution` random 0..255 ints. Useful
        when no test image is available.

    pattern_image(resolution=64, kind="ramp") -> list[int]
        Synthesise a deterministic test pattern (ramp, checker, bars,
        bullseye) without requiring numpy / PIL. Useful for sanity
        checks where the visual feedback ("is this pixel actually
        where I expect") matters more than realism.

Reuses the PIL pattern from macros/bmp2vector.py so the same dependency
graph is in play; we don't pull in cv2 / scikit-image just for this.

Simulation schema (post-cleanup)
--------------------------------
``get_image_data`` consumes the consolidated simulation block from
``streamData.json``. The block now has a single flat layout instead of
the older ``_alt_file`` / ``_alt_random`` overlays:

    {
      "enabled": true,
      "mode": "image",                  # "image" | "zeros" | "loopback"
      "imageResolution": 64,            # power of two, [16, 256]
      "source": "pattern",              # "pattern" | "file" | "random"
      "patternKind": "bullseye",        # source == "pattern"
      "filePath": "Development/.../img.bmp",   # source == "file"
      "invert": false,                  # source == "file"
      "seed": 42                        # source == "random"
    }

``filePath`` is resolved through :func:`_resolve_iobeam_path`: absolute
paths are used verbatim, while relative paths are joined against
``IOBEAM_ROOT`` (default: the service working directory, or the checkout
root found by walking up from this file). This removes machine-specific
absolute paths from the JSON and lets the same config travel between dev
boxes.

Back-compat
-----------
Old JSON files still in the wild (with ``_alt_file.path`` and
``_alt_random.seed``) are honoured: ``get_image_data`` falls back to
the legacy layout when the consolidated keys are absent. Hand-edited
configs continue to work; saving any of them through the new UI
canonicalises to the flat form.
"""

import logging
import os
import random
from pathlib import Path

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------- #
# Path resolution.
#
# Why this exists
# ---------------
# streamData.json used to carry machine-specific absolute paths to
# ``Development/.../SampleImage.bmp``.
# That made the file un-shareable between developer boxes, CI, and the
# production target. The cleanup moves those literals out of the JSON
# and into a single env-driven root, falling back to:
#
#   1. ``IOBEAM_ROOT`` environment variable (preferred; set by the service
#      launcher when a specific checkout root is required).
#   2. The walk-up from this file: ``GlasgowDataIO`` lives at
#      ``<root>/Development/GlasgowDataIO``, so the parent of
#      ``Development`` is the root.
#   3. Current working directory, last resort. This matches the Windows
#      service wrapper's working directory in deployed runs but is fragile
#      in ad-hoc dev shells.
# ---------------------------------------------------------------------------- #

def _walk_up_to_iobeam_root() -> Path | None:
    """Walk this file's ancestry looking for an IobeamTech project root.

    The repo layout is::

        <root>/Development/GlasgowDataIO/IobeamControl/applet/imageSource.py

    so the root is three levels above ``Development``. We treat the
    presence of a ``Development`` directory under any ancestor as the
    signature, which keeps this resilient to the literal directory
    name above ``Development`` (which is ``IobeamTech`` in production
    but might be e.g. a developer's checkout name).
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "Development").is_dir():
            return parent
    return None


def get_iobeam_root() -> Path:
    """Return the resolved IOBEAM_ROOT used for relative simulation paths.

    Resolution order:
        1. ``IOBEAM_ROOT`` env var (expanduser + resolve).
        2. Walk-up from this source file.
        3. ``Path.cwd()`` as the final fallback.
    """
    env = os.environ.get("IOBEAM_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    walked = _walk_up_to_iobeam_root()
    if walked is not None:
        return walked
    return Path.cwd().resolve()


def _resolve_iobeam_path(p: str | os.PathLike) -> Path:
    """Resolve a possibly-relative path against IOBEAM_ROOT.

    Absolute paths are returned unchanged (after expanduser). Relative
    paths are joined against :func:`get_iobeam_root`. This is the
    *only* place in the simulation pipeline that knows about
    IOBEAM_ROOT - all other call sites pass paths through here so the
    behaviour stays consistent.
    """
    pp = Path(p).expanduser()
    if pp.is_absolute():
        return pp
    return (get_iobeam_root() / pp).resolve()


def _validate_resolution(resolution):
    if not (resolution & (resolution - 1) == 0 and 16 <= resolution <= 256):
        raise ValueError(
            f"resolution must be a power of two in [16, 256], got {resolution}")


def load_image(path, resolution=64, invert=False):
    """
    Load `path` (PNG/BMP/JPEG/etc.), convert to 8-bit grayscale, resize
    to a `resolution x resolution` square, and return the pixel data as
    a flat row-major list of ints in [0, 255].

    The path is resolved through :func:`_resolve_iobeam_path`, so
    relative paths in streamData.json are interpreted against
    IOBEAM_ROOT (typically the project root used by the service launcher).

    Falls back to random_image() if PIL is missing or the file can't be
    read - this keeps the build path alive on machines without Pillow.
    """
    _validate_resolution(resolution)

    try:
        from PIL import Image  # imported lazily so test_glasgow_applet et al.
        # don't pull in PIL when only pure-amaranth sim is needed.
    except ImportError:
        logger.warning("Pillow not installed; falling back to random image")
        return random_image(resolution)

    p = _resolve_iobeam_path(path)
    if not p.is_file():
        logger.warning(
            "image not found at %s (resolved from %r against IOBEAM_ROOT=%s);"
            " falling back to random image",
            p, path, get_iobeam_root())
        return random_image(resolution)

    im = Image.open(p).convert("L")
    im = im.resize((resolution, resolution), resample=Image.Resampling.NEAREST)
    pixels = list(im.getdata())
    if invert:
        pixels = [255 - v for v in pixels]
    logger.info(f"loaded {p.name} -> {resolution}x{resolution} grayscale "
                f"({len(pixels)} pixels, range {min(pixels)}..{max(pixels)})")
    return pixels


def random_image(resolution=64, seed=None):
    """
    Generate `resolution * resolution` random 0..255 ints.
    Deterministic when seed is not None.
    """
    _validate_resolution(resolution)
    rng = random.Random(seed)
    return [rng.randint(0, 255) for _ in range(resolution * resolution)]


def pattern_image(resolution=64, kind="ramp"):
    """
    Synthesise a deterministic test pattern. No PIL / numpy dependency.

    kind:
      "ramp"     - left-to-right grayscale ramp (x indicates value)
      "checker"  - 8x8 checkerboard
      "bars"     - vertical bars of stepped grayscale
      "bullseye" - radial gradient from centre
    """
    _validate_resolution(resolution)
    n = resolution
    out = [0] * (n * n)
    if kind == "ramp":
        for y in range(n):
            for x in range(n):
                out[y * n + x] = (x * 255) // (n - 1)
    elif kind == "checker":
        # Use dark gray rather than true black for the low squares. Small
        # ROI scans can fall entirely inside one checker cell; a zero-valued
        # cell is indistinguishable from a dead ADC path in the live/final
        # views, while 32 still reads visually as the dark half of a checker.
        low = 32
        high = 255
        cell = max(1, n // 8)
        for y in range(n):
            for x in range(n):
                out[y * n + x] = high if ((x // cell) + (y // cell)) & 1 else low
    elif kind == "bars":
        for y in range(n):
            for x in range(n):
                out[y * n + x] = ((x * 8) // n) * 32  # 8 bars, 0,32,...,224
    elif kind == "bullseye":
        cx = cy = (n - 1) / 2
        max_r = ((cx ** 2) + (cy ** 2)) ** 0.5
        for y in range(n):
            for x in range(n):
                r = (((x - cx) ** 2) + ((y - cy) ** 2)) ** 0.5
                out[y * n + x] = int(255 * (1 - r / max_r))
    else:
        raise ValueError(f"unknown pattern kind: {kind}")
    return out


def _legacy_source_overrides(sim_config: dict) -> dict:
    """Apply the legacy _alt_file / _alt_random overlays if present.

    Configs written by the older UI carried the file path and seed
    inside ``_alt_file`` / ``_alt_random`` sub-dicts and used the
    top-level ``source`` only as an enum selector. The consolidated
    schema flattens those out. We return a fresh dict so the original
    sim_config is left untouched (callers may still want to look at
    the raw shape for diagnostics).
    """
    out = dict(sim_config)
    source = out.get("source", "pattern")
    if source == "file" and "filePath" not in out:
        legacy = out.get("_alt_file") or {}
        legacy_path = legacy.get("path")
        if legacy_path:
            out["filePath"] = legacy_path
        if "invert" not in out and "invert" in legacy:
            out["invert"] = legacy["invert"]
    if source == "random" and "seed" not in out:
        legacy = out.get("_alt_random") or {}
        if "seed" in legacy:
            out["seed"] = legacy["seed"]
    return out


def get_image_data(sim_config):
    """
    Resolve the ``simulation`` block from streamData.json into an image
    array. Accepts both the consolidated schema (see module docstring)
    and the legacy ``_alt_file`` / ``_alt_random`` overlay layout.

    Returns ``(image_data, resolution)``.

    The path for ``source == "file"`` is resolved through
    :func:`_resolve_iobeam_path`, so relative paths in
    streamData.json are interpreted against IOBEAM_ROOT.
    """
    sim_config = sim_config or {}
    sim_config = _legacy_source_overrides(sim_config)

    resolution = int(sim_config.get("imageResolution", 64))
    source = sim_config.get("source", "pattern")

    if source == "file":
        img_path = sim_config.get("filePath") or ""
        if img_path:
            return (load_image(img_path,
                               resolution=resolution,
                               invert=bool(sim_config.get("invert", False))),
                    resolution)
        # Fall through to pattern when source==file but no path given.
        logger.warning(
            "simulation.source='file' but filePath is empty; "
            "falling back to pattern image")

    if source == "random":
        return (random_image(resolution, seed=sim_config.get("seed")),
                resolution)

    return (pattern_image(resolution,
                          kind=sim_config.get("patternKind", "ramp")),
            resolution)
