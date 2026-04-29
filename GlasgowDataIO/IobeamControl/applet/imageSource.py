"""
IobeamControl/applet/imageSource.py
===================================

Host-side helper that produces the 8-bit pixel array consumed by
FakeAdcSimulator's BRAM init. Two modes:

    load_image(path, resolution=64, invert=False) -> list[int]
        Open a PNG/BMP/JPEG via PIL, convert to 8-bit grayscale,
        resize to `resolution x resolution`, return as a flat
        row-major list of N*N ints (each 0..255).

    random_image(resolution=64, seed=None) -> list[int]
        Generate `resolution * resolution` random 0..255 ints. Useful
        when no test image is available.

    pattern_image(resolution=64, kind="ramp") -> list[int]
        Synthesise a deterministic test pattern (ramp, checker, bars)
        without requiring numpy / PIL. Useful for sanity checks where
        the visual feedback ("is this pixel actually where I expect")
        matters more than realism.

Reuses the PIL pattern from macros/bmp2vector.py so the same dependency
graph is in play; we don't pull in cv2/scikit-image just for this.

The output of any of these three calls is a flat list[int] suitable for
passing as `image_data` to FakeAdcSimulator(__init__, image_data=...).
"""

import logging
import random
from pathlib import Path

logger = logging.getLogger(__name__)


def _validate_resolution(resolution):
    if not (resolution & (resolution - 1) == 0 and 16 <= resolution <= 256):
        raise ValueError(
            f"resolution must be a power of two in [16, 256], got {resolution}")


def load_image(path, resolution=64, invert=False):
    """
    Load `path` (PNG/BMP/JPEG/etc.), convert to 8-bit grayscale, resize
    to a `resolution x resolution` square, and return the pixel data as
    a flat row-major list of ints in [0, 255].

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

    p = Path(path)
    if not p.is_file():
        logger.warning(f"image not found at {p}; falling back to random image")
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
      "ramp"    - left-to-right grayscale ramp (x indicates value)
      "checker" - 8x8 checkerboard
      "bars"    - vertical bars of stepped grayscale
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
        cell = max(1, n // 8)
        for y in range(n):
            for x in range(n):
                out[y * n + x] = 255 if ((x // cell) + (y // cell)) & 1 else 0
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


def get_image_data(sim_config):
    """
    Resolve `simulation` block from streamData.json into an image array.

    sim_config schema:
        {
          "enabled": true,
          "imageResolution": 64,                  # power of two, [16,256]
          "source": "file" | "random" | "pattern",
          "path":    "/path/to/image.png",       # source == "file"
          "patternKind": "ramp",                  # source == "pattern"
          "seed": 42,                             # source == "random"
          "invert": false                         # source == "file"
        }

    Returns (image_data, resolution).
    """
    sim_config = sim_config or {}
    resolution = int(sim_config.get("imageResolution", 64))
    source = sim_config.get("source", "pattern")

    if source == "file" and sim_config.get("path"):
        return (load_image(sim_config["path"],
                           resolution=resolution,
                           invert=bool(sim_config.get("invert", False))),
                resolution)
    if source == "random":
        return (random_image(resolution, seed=sim_config.get("seed")),
                resolution)
    return (pattern_image(resolution,
                          kind=sim_config.get("patternKind", "ramp")),
            resolution)
