"""Pydantic models shared between the service and the API layer."""
from enum import Enum
from typing import List, Optional, Tuple
from pydantic import BaseModel, Field


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

    # Wet-run extras (REST only; WebSocket streaming ignores these):
    save_csv:    bool = Field(False, description="Export received pixels as a CSV file.")
    csv_dir:     Optional[str] = Field(None, description="Override default CSV directory (~/Downloads).")
    do_validate: bool = Field(True,  description="Run chunk-count / size / padding checks and return the report.")

    model_config = {
        "json_schema_extra": {
            "examples": [
                {"resolution": 512,  "dwell": 2, "latency_bytes": 16384,
                 "frame_blank": False, "save_csv": False, "do_validate": True},
                {"resolution": 1024, "dwell": 3, "latency_bytes": 16384,
                 "frame_blank": False, "save_csv": False, "do_validate": True},
            ]
        }
    }


class VectorPattern(str, Enum):
    default = "default"
    custom  = "custom"


class VectorRequest(BaseModel):
    pattern:        VectorPattern = VectorPattern.default
    points:         Optional[List[Tuple[int, int, int]]] = Field(
        default=None,
        description="For `custom`: list of (x, y, dwell) tuples. Capped at 1M points.",
        max_length=1_000_000,
    )
    latency_bytes:  int  = Field(8196, ge=2, description="Matches `vectorScan.latency` in streamData.json.")
    output_mode:    str  = Field("SixteenBit", description="SixteenBit or EightBit.")
    cookie:         int  = Field(123, ge=0, le=0xFFFF)

    # Wet-run extras (REST only):
    pre_process:    bool = Field(False, description="Call _pre_process_chunks before transfer; time it separately.")
    save_csv:       bool = Field(False, description="Export received chunks as a CSV file.")
    csv_dir:        Optional[str] = Field(None, description="Override default CSV directory (~/Downloads).")
    do_validate:    bool = Field(True,  description="Run non-empty / padding checks and return the report.")

    model_config = {
        "json_schema_extra": {
            "examples": [
                {"pattern": "default", "latency_bytes": 8196,
                 "pre_process": True, "save_csv": False, "do_validate": True},
                {"pattern": "custom",
                 "points": [[0, 0, 2], [100, 100, 2], [200, 100, 2], [200, 200, 2]],
                 "latency_bytes": 8196, "save_csv": False, "do_validate": True},
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
    """Unified result for both raster and vector blocking scans."""
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
    csv_path:         Optional[str]   = None
    validation:       Optional[ScanValidation] = None
