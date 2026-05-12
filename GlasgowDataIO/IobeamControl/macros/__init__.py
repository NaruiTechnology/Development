"""macros package — re-exports the public scan command surface.

Before this refactor RasterScanCommand was defined inline in this file
AND in macros/raster.py, with subtly different sender behavior. Different
consumers picked up different classes depending on whether they imported
via `from macros import RasterScanCommand` or `from .raster import
RasterScanCommand`. We now have one canonical class in macros/raster.py
and this file just re-exports it.
"""

import struct

# Use the `GlasgowDataIO.IobeamControl.*` prefix consistently. Running
# under uvicorn (the FastAPI service), the working directory is the
# project root and only `GlasgowDataIO` is on sys.path as a top-level
# package — unprefixed `IobeamControl.*` imports fail at startup with
# `ModuleNotFoundError: No module named 'IobeamControl'`.
from GlasgowDataIO.IobeamControl.commands import DwellTime, DACCodeRange, OutputMode
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    BaseCommand, VectorPixelCommand, RasterRegionCommand,
    SynchronizeCommand, RasterPixelRunCommand, BlankCommand, FlushCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import u16

# Canonical class — see macros/raster.py for the implementation and the
# rationale behind the sender's per-chunk flush and pipeline-drain padding.
from .raster import RasterScanCommand  # noqa: F401

BIG_ENDIAN = (struct.pack('@H', 0x1234) == struct.pack('>H', 0x1234))

__all__ = ["RasterScanCommand", "BIG_ENDIAN"]
