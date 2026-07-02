"""Pydantic models shared between the service and the API layer.

API change in this revision: CSV output is no longer a side effect of a
scan run. The browser pulls CSV / PNG figure bytes on demand from
/scan/last/* endpoints. So `save_csv`, `csv_dir`, and `csv_path` are
gone, replaced by `has_data` on the result so the UI knows when the
download buttons can be enabled.

`output_mode` was added to RasterRequest in the scan-params refactor.
It was already a field on RasterScanCommand (defaulting to SixteenBit)
but had no way to flow through the REST API — VectorRequest had it,
RasterRequest didn't, so hardware always got the default. Adding it
here closes that gap. Defaulting to "SixteenBit" keeps the wire format
backward compatible with frontends that don't send the field yet.
"""
from enum import Enum
from typing import List, Optional, Tuple, Union
from pydantic import BaseModel, Field, field_validator


class DeviceState(str, Enum):
    DISCONNECTED = "disconnected"
    CONNECTING   = "connecting"
    IDLE         = "idle"
    BUSY         = "busy"
    ERROR        = "error"


class ServiceStatus(BaseModel):
    state: DeviceState
    last_error: Optional[str] = None
    scans_completed: int = 0
    chunks_in_flight: int = 0


# ---------- requests -------------------------------------------------------

class RasterRequest(BaseModel):
    resolution:    int  = Field(512,   ge=1, le=2048, description="DAC range (NxN).")
    dwell:         int  = Field(2,     ge=1, le=65535, description="Dwell time units (125 ns each).")
    latency_bytes: int  = Field(16384, ge=2, description="`latency` passed to transfer_multiple.")
    frame_blank:   bool = False
    cookie:        int  = Field(123, ge=0, le=0xFFFF)
    # New in scan-params refactor. Was previously hardcoded to SixteenBit
    # inside the macro because the API had no field for it.
    output_mode:   str  = Field("SixteenBit", description="SixteenBit or EightBit.")
    beam_type:     str  = Field("Ion", description="NoBeam, Electron, or Ion.")
    external_control: bool = Field(True, description="Drive external beam control pins during the scan.")

    # Wet-run extras (REST only; WebSocket streaming ignores these):
    do_validate: bool = Field(True, description="Run chunk-count / size checks and return the report.")
    roi: Optional["ROIRequest"] = Field(
        default=None,
        description="Optional DAC-code ROI bounds. Coordinates are inclusive 0..16383.",
    )
    simulation_bitmap: Optional["SimulationBitmap"] = Field(
        default=None,
        description=(
            "Optional browser-provided grayscale crop for simulation-only raster scans. "
            "Ignored for production hardware."
        ),
    )

    model_config = {
        "json_schema_extra": {
            "examples": [
                {"resolution": 512,  "dwell": 2, "latency_bytes": 16384,
                 "frame_blank": False, "output_mode": "SixteenBit",
                 "beam_type": "Ion", "external_control": True,
                 "do_validate": True},
                {"resolution": 1024, "dwell": 3, "latency_bytes": 16384,
                 "frame_blank": False, "output_mode": "SixteenBit",
                 "beam_type": "Ion", "external_control": True,
                 "do_validate": True},
            ]
        }
    }


class VectorPattern(str, Enum):
    default = "default"
    custom  = "custom"


class VectorPoint(BaseModel):
    x: int = Field(..., ge=0, le=16383)
    y: int = Field(..., ge=0, le=16383)
    dwell: int = Field(..., ge=1, le=65535)
    blank: Optional[bool] = None


class SimulationBitmap(BaseModel):
    width:  int = Field(..., ge=1, le=4096)
    height: int = Field(..., ge=1, le=4096)
    pixels: List[Union[int, "SimulationBitmapPixel"]] = Field(..., max_length=1_000_000)

    @field_validator("pixels")
    @classmethod
    def _pixels_are_bytes(cls, v: List[int]) -> List[int]:
        for px in v:
            if isinstance(px, SimulationBitmapPixel):
                value = px.value
            else:
                value = int(px)
            if value < 0 or value > 255:
                raise ValueError("simulation_bitmap pixels must be 0..255")
        return v


class SimulationBitmapPixel(BaseModel):
    value: int = Field(..., ge=0, le=255)
    isHighlighted: Optional[bool] = None
    isSkipped: Optional[bool] = None


class VectorRequest(BaseModel):
    pattern:        VectorPattern = VectorPattern.default
    points:         Optional[List[Union[Tuple[int, int, int], VectorPoint]]] = Field(
        default=None,
        description="For `custom`: list of (x, y, dwell) tuples or {x, y, dwell, blank} objects. Capped at 1M points.",
        max_length=1_000_000,
    )
    # Density of the default sweep across the 2048-DAC range. Stride is
    # derived as 2048 // vector_resolution; only divisors of 2048 produce
    # an integer stride. Ignored when pattern=custom.
    vector_resolution: int = Field(
        2048,
        description=(
            "Default-pattern sample density on each axis. Allowed: 1..2048. "
            "Coverage is always full DAC range; smaller values just sample sparser. "
            "Ignored when pattern=custom."
        ),
    )
    dwell:          int  = Field(
        1,
        ge=1,
        le=65535,
        description="Default-pattern dwell time units (125 ns each). Ignored when pattern=custom.",
    )
    latency_bytes:  int  = Field(8196, ge=2, description="Matches `vectorScan.latency` in streamData.json.")
    output_mode:    str  = Field("SixteenBit", description="SixteenBit or EightBit.")
    beam_type:      str  = Field("Ion", description="NoBeam, Electron, or Ion.")
    external_control: bool = Field(True, description="Drive external beam control pins during the scan.")
    cookie:         int  = Field(123, ge=0, le=0xFFFF)

    # Wet-run extras (REST only):
    pre_process:    bool = Field(False, description="Call _pre_process_chunks before transfer; time it separately.")
    do_validate:    bool = Field(True,  description="Run chunk presence checks and return the report.")
    roi:            Optional["ROIRequest"] = Field(
        default=None,
        description="Optional DAC-code ROI bounds. Coordinates are inclusive 0..16383.",
    )
    simulation_bitmap: Optional[SimulationBitmap] = Field(
        default=None,
        description=(
            "Optional browser-provided grayscale crop for simulation-only vector scans. "
            "Ignored for production hardware."
        ),
    )

    @field_validator("vector_resolution")
    @classmethod
    def _check_vector_resolution(cls, v: int) -> int:
        if v < 1 or v > 2048:
            raise ValueError(f"vector_resolution must be between 1 and 2048; got {v}")
        return v

    model_config = {
        "json_schema_extra": {
            "examples": [
                {"pattern": "default", "vector_resolution": 2048,
                 "dwell": 1, "latency_bytes": 8196, "pre_process": True, "do_validate": True},
                {"pattern": "default", "vector_resolution": 512,
                 "dwell": 4, "latency_bytes": 8196, "pre_process": True, "do_validate": True},
                {"pattern": "custom",
                 "points": [[0, 0, 2], [100, 100, 2], [200, 100, 2], [200, 200, 2]],
                 "latency_bytes": 8196, "do_validate": True},
            ]
        }
    }


# ---------- results --------------------------------------------------------

class ValidationCheck(BaseModel):
    name:   str
    passed: bool
    detail: Optional[str] = None


class ScanValidation(BaseModel):
    passed: bool
    checks: List[ValidationCheck]


class ScanResult(BaseModel):
    """Unified result for both raster and vector blocking scans.

    `has_data=True` means the server is holding the chunk buffer for this
    scan in memory, so /scan/last/csv and /scan/last/figure will return
    its contents.
    """
    kind:             str              # "raster" or "vector"
    chunks:           int
    bytes:            int

    # raster-only (None for vector):
    resolution:       Optional[int]   = None
    dwell:            Optional[int]   = None
    expected_chunks:  Optional[int]   = None
    pixels_per_chunk: Optional[int]   = None

    # vector-only (None for raster):
    process_time_s:   Optional[float] = None

    # shared:
    send_time_s:      Optional[float] = None
    has_data:         bool            = False
    validation:       Optional[ScanValidation] = None


class ROIRequest(BaseModel):
    x_start: float = Field(..., ge=0, le=16383)
    x_end:   float = Field(..., ge=0, le=16383)
    y_start: float = Field(..., ge=0, le=16383)
    y_end:   float = Field(..., ge=0, le=16383)

    @field_validator("x_end")
    @classmethod
    def _x_nonempty(cls, v: int, info) -> int:
        start = info.data.get("x_start")
        if start is not None and v == start:
            raise ValueError("x_end must differ from x_start")
        return v

    @field_validator("y_end")
    @classmethod
    def _y_nonempty(cls, v: int, info) -> int:
        start = info.data.get("y_start")
        if start is not None and v == start:
            raise ValueError("y_end must differ from y_start")
        return v


RasterRequest.model_rebuild()
VectorRequest.model_rebuild()
